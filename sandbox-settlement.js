"use strict";
/**
 * Isolated simulation-only PostgreSQL settlement engine.
 * Never accesses hf_wallets, hf_orders, hf_positions, hf_fills, hf_wallet_ledger.
 * No HTTP route or operator UI invokes this module.
 * Currency policy uses caller-supplied test FX; it is NOT a real-time price feed.
 */
const {randomUUID}=require("node:crypto");
const calc=require("./settlement-core");
const DDL=[
 "CREATE TABLE IF NOT EXISTS hf_lab_accounts(id UUID PRIMARY KEY,balance_krw BIGINT NOT NULL CHECK(balance_krw>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
 "CREATE TABLE IF NOT EXISTS hf_lab_orders(id UUID PRIMARY KEY,account_id UUID NOT NULL REFERENCES hf_lab_accounts(id),request_key UUID NOT NULL,action VARCHAR(5) NOT NULL CHECK(action IN ('OPEN','CLOSE')),symbol VARCHAR(10) NOT NULL,side VARCHAR(4) NOT NULL CHECK(side IN ('BUY','SELL')),qty INTEGER NOT NULL CHECK(qty>0 AND qty<=100),price NUMERIC(18,5) NOT NULL CHECK(price>0),fx_krw INTEGER NOT NULL CHECK(fx_krw>0),status VARCHAR(8) NOT NULL DEFAULT 'FILLED' CHECK(status='FILLED'),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(account_id,request_key))",
 "CREATE TABLE IF NOT EXISTS hf_lab_positions(id UUID PRIMARY KEY,account_id UUID NOT NULL REFERENCES hf_lab_accounts(id),open_order_id UUID NOT NULL UNIQUE REFERENCES hf_lab_orders(id),close_order_id UUID UNIQUE REFERENCES hf_lab_orders(id),symbol VARCHAR(10) NOT NULL,side VARCHAR(4) NOT NULL CHECK(side IN ('BUY','SELL')),qty INTEGER NOT NULL CHECK(qty>0 AND qty<=100),entry_price NUMERIC(18,5) NOT NULL CHECK(entry_price>0),margin_krw BIGINT NOT NULL CHECK(margin_krw>0),state VARCHAR(8) NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CLOSED')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),closed_at TIMESTAMPTZ)",
 "CREATE INDEX IF NOT EXISTS hf_lab_positions_account ON hf_lab_positions(account_id,state)",
 "CREATE TABLE IF NOT EXISTS hf_lab_ledger(id BIGSERIAL PRIMARY KEY,account_id UUID NOT NULL REFERENCES hf_lab_accounts(id),order_id UUID NOT NULL UNIQUE REFERENCES hf_lab_orders(id),change_krw BIGINT NOT NULL,balance_after_krw BIGINT NOT NULL CHECK(balance_after_krw>=0),kind VARCHAR(12) NOT NULL CHECK(kind IN ('OPEN_FEE','CLOSE_PNL')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
];
const U=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8a-f][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function requireValue(ok,reason){if(!ok)throw Object.assign(new Error(reason),{code:reason})}
async function initSchema(pool){
 const c=await pool.connect();try{
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(18202,2029)");
  for(const sql of DDL)await c.query(sql);
  await c.query("COMMIT");
 }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
}
/** Invoke only inside an existing SQL transaction holding one sandbox account row FOR UPDATE. */
async function executeInTransaction(c,x){
 const {accountId,requestKey,action,symbol,side,qty,price,fxKrw,positionId}=x;
 requireValue(U.test(accountId)&&U.test(requestKey),"INVALID_UUID");
 requireValue(action==="OPEN"||action==="CLOSE","INVALID_ACTION");
 requireValue(side==="BUY"||side==="SELL","INVALID_SIDE");
 calc.specFor(symbol);calc.toTicks(symbol,price);calc.feesFor(qty);
 requireValue(Number.isSafeInteger(fxKrw)&&fxKrw>0&&fxKrw<=10000,"INVALID_FX");
 if(action==="CLOSE")requireValue(U.test(positionId||""),"INVALID_POSITION");
 const account=await c.query("SELECT balance_krw FROM hf_lab_accounts WHERE id=$1 FOR UPDATE",[accountId]);
 requireValue(account.rowCount===1,"ACCOUNT_NOT_FOUND");
 const duplicate=await c.query("SELECT id,action,symbol,side,qty,price,fx_krw FROM hf_lab_orders WHERE account_id=$1 AND request_key=$2",[accountId,requestKey]);
 if(duplicate.rowCount){
  const row=duplicate.rows[0];
  requireValue(row.action===action&&row.symbol===symbol&&row.side===side&&row.qty===qty&&Number(row.price)===price&&row.fx_krw===fxKrw,"IDEMPOTENCY_CONFLICT");
  return {orderId:row.id,duplicate:true,accountBalanceKrw:Number(account.rows[0].balance_krw)};
 }
 const balance=Number(account.rows[0].balance_krw);
 const fee=calc.feesFor(qty);
 let change=-fee,position=null,locked=0,margin=0;
 if(action==="OPEN"){
  const open=await c.query("SELECT symbol,qty FROM hf_lab_positions WHERE account_id=$1 AND state='OPEN'",[accountId]);
  locked=open.rows.reduce((sum,p)=>sum+calc.marginFor(p.symbol,p.qty),0);
  margin=calc.marginFor(symbol,qty);
  requireValue(calc.availableMargin({balanceKrw:balance,lockedKrw:locked})>=margin+fee,"INSUFFICIENT_MARGIN");
 }else{
  const r=await c.query("SELECT * FROM hf_lab_positions WHERE id=$1 AND account_id=$2 AND state='OPEN' FOR UPDATE",[positionId,accountId]);
  requireValue(r.rowCount===1,"POSITION_NOT_OPEN");
  position=r.rows[0];requireValue(position.symbol===symbol&&position.qty===qty&&position.side===side,"POSITION_MISMATCH");
  change=calc.settlementPlan({symbol,side,entry:Number(position.entry_price),exit:price,qty,krwPerUsd:fxKrw}).netPnlKrw;
  requireValue(Number.isSafeInteger(change),"INVALID_SETTLEMENT");
 }
 const after=balance+change;
 requireValue(Number.isSafeInteger(after)&&after>=0,"INSUFFICIENT_SETTLEMENT_BALANCE");
 const id=randomUUID();
 await c.query("INSERT INTO hf_lab_orders(id,account_id,request_key,action,symbol,side,qty,price,fx_krw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,accountId,requestKey,action,symbol,side,qty,price,fxKrw]);
 if(action==="OPEN"){
  const posId=randomUUID();
  await c.query("INSERT INTO hf_lab_positions(id,account_id,open_order_id,symbol,side,qty,entry_price,margin_krw) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[posId,accountId,id,symbol,side,qty,price,margin]);
  position={id:posId};
 }else{
  await c.query("UPDATE hf_lab_positions SET state='CLOSED',close_order_id=$1,closed_at=NOW() WHERE id=$2 AND account_id=$3 AND state='OPEN'",[id,positionId,accountId]);
 }
 const updated=await c.query("UPDATE hf_lab_accounts SET balance_krw=balance_krw+$1 WHERE id=$2 AND balance_krw+$1>=0 RETURNING balance_krw",[change,accountId]);
 requireValue(updated.rowCount===1&&Number(updated.rows[0].balance_krw)===after,"BALANCE_UPDATE_FAILED");
 await c.query("INSERT INTO hf_lab_ledger(account_id,order_id,change_krw,balance_after_krw,kind) VALUES($1,$2,$3,$4,$5)",[accountId,id,change,after,action==="OPEN"?"OPEN_FEE":"CLOSE_PNL"]);
 return {orderId:id,positionId:position.id,duplicate:false,changeKrw:change,accountBalanceKrw:after,marginReservedKrw:margin,action};
}
async function execute(pool,input){
 const c=await pool.connect();
 try{await c.query("BEGIN");const result=await executeInTransaction(c,input);await c.query("COMMIT");return result}
 catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
}
/** Integration test is rolled back unconditionally: NO money or order writes persist. */
async function rollbackSmoke(pool){
 const c=await pool.connect(),accountId=randomUUID();
 try{
  await c.query("BEGIN");
  await c.query("INSERT INTO hf_lab_accounts(id,balance_krw) VALUES($1,$2)",[accountId,10000000]);
  const opened=await executeInTransaction(c,{accountId,requestKey:randomUUID(),action:"OPEN",symbol:"NQ",side:"BUY",qty:1,price:22000,fxKrw:1400});
  requireValue(opened.accountBalanceKrw===9998500&&opened.marginReservedKrw===3000000,"OPEN_ACCOUNTING_FAILED");
  const closed=await executeInTransaction(c,{accountId,requestKey:randomUUID(),action:"CLOSE",symbol:"NQ",side:"BUY",qty:1,price:22001,fxKrw:1400,positionId:opened.positionId});
  requireValue(closed.changeKrw===26500&&closed.accountBalanceKrw===10025000,"CLOSE_ACCOUNTING_FAILED");
  const ledger=await c.query("SELECT change_krw,balance_after_krw FROM hf_lab_ledger WHERE account_id=$1 ORDER BY id",[accountId]);
  requireValue(ledger.rowCount===2&&Number(ledger.rows[0].change_krw)===-1500&&Number(ledger.rows[1].change_krw)===26500,"LEDGER_MISMATCH");
  const position=await c.query("SELECT state FROM hf_lab_positions WHERE id=$1",[opened.positionId]);
  requireValue(position.rows[0].state==="CLOSED","POSITION_NOT_CLOSED");
  return {ok:true,events:2,rolledBack:true,openFeeKrw:1500,closeNetKrw:26500};
 }finally{await c.query("ROLLBACK").catch(()=>{});c.release()}
}
module.exports={initSchema,executeInTransaction,execute,rollbackSmoke,DDL};
