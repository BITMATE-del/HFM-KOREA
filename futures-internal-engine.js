"use strict";
const crypto=require("node:crypto");
const core=require("./app-api"),funding=require("./funding-api"),stocks=require("./stock-internal-engine"),calc=require("./settlement-core");
const {pool,auth}=core;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYMS=new Set(Object.keys(calc.SPECS));
const DDL=[
 "CREATE TABLE IF NOT EXISTS hf_futures_internal_orders(id UUID PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES hf_users(id),request_key UUID NOT NULL,action VARCHAR(6) NOT NULL CHECK(action IN ('OPEN','CLOSE')),symbol VARCHAR(10) NOT NULL,side VARCHAR(4) NOT NULL CHECK(side IN ('BUY','SELL')),qty INTEGER NOT NULL CHECK(qty BETWEEN 1 AND 100),order_type VARCHAR(8) NOT NULL CHECK(order_type IN ('MARKET','LIMIT')),limit_price NUMERIC(18,5),position_id UUID,status VARCHAR(12) NOT NULL CHECK(status IN ('HELD','FILLED','CANCELLED')),fill_price NUMERIC(18,5),fee_krw BIGINT NOT NULL DEFAULT 0,realized_pnl_krw BIGINT,source VARCHAR(40),quote_at TIMESTAMPTZ,fx_krw INTEGER,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,request_key))",
 "CREATE INDEX IF NOT EXISTS hf_futures_internal_orders_pending ON hf_futures_internal_orders(status,created_at) WHERE status='HELD'",
 "CREATE TABLE IF NOT EXISTS hf_futures_internal_positions(id UUID PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES hf_users(id),open_order_id UUID NOT NULL UNIQUE REFERENCES hf_futures_internal_orders(id),close_order_id UUID UNIQUE REFERENCES hf_futures_internal_orders(id),symbol VARCHAR(10) NOT NULL,side VARCHAR(4) NOT NULL CHECK(side IN ('BUY','SELL')),qty INTEGER NOT NULL CHECK(qty BETWEEN 1 AND 100),entry_price NUMERIC(18,5) NOT NULL,margin_krw BIGINT NOT NULL,state VARCHAR(8) NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CLOSED')),opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),closed_at TIMESTAMPTZ)",
 "CREATE INDEX IF NOT EXISTS hf_futures_internal_positions_user ON hf_futures_internal_positions(user_id,state)",
 "ALTER TABLE hf_wallet_ledger ADD COLUMN IF NOT EXISTS futures_order_id UUID UNIQUE REFERENCES hf_futures_internal_orders(id)"
];
let ready=null;
const fail=code=>{const e=Error(code);e.code=code;throw e};
function ensure(){if(!ready)ready=(async()=>{await stocks.ensure();const c=await pool.connect();try{await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(18202,2033)");for(const q of DDL)await c.query(q);await c.query("COMMIT")}catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}})().catch(e=>{ready=null;throw e});return ready}
const send=(res,code,data)=>{res.writeHead(code,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(data))};
async function read(req){let length=0,s="";for await(const chunk of req){length+=chunk.length;if(length>4096)fail("INVALID_BODY");s+=chunk}try{return JSON.parse(s)}catch{fail("INVALID_JSON")}}
function input(b){
 const symbol=String(b.symbol||"").toUpperCase(),side=String(b.side||"").toUpperCase();
 const qty=Number(b.qty),type=String(b.type||"MARKET").toUpperCase();
 const action=String(b.action||"OPEN").toUpperCase(),key=String(b.requestKey||"");
 const limit=b.limitPrice===null||b.limitPrice===undefined?null:Number(b.limitPrice);
 const positionId=String(b.positionId||"");
 if(!SYMS.has(symbol)||!["BUY","SELL"].includes(side)||!Number.isSafeInteger(qty)||qty<1||qty>100||!["MARKET","LIMIT"].includes(type)||!["OPEN","CLOSE"].includes(action)||!UUID.test(key))fail("INVALID_ORDER");
 if(type==="LIMIT"){if(!Number.isFinite(limit)||limit<=0)fail("INVALID_TICK_PRICE");calc.toTicks(symbol,limit)}
 if(action==="CLOSE"&&(!UUID.test(positionId)||type!=="MARKET"))fail("INVALID_POSITION");
 if(action==="OPEN"&&positionId)fail("INVALID_POSITION");
 return {symbol,side,qty,type,action,key,limit,positionId:action==="CLOSE"?positionId:null};
}
function checkQuote(q,symbol){
 if(!q||q.symbol!==symbol||q.source!=="MASSIVE_FUTURES"||!q.licensed||q.marketOpen===false)fail("REFERENCE_QUOTE_UNAVAILABLE");
 const time=Date.parse(q.asOf);
 if(!Number.isFinite(time)||time>Date.now()+1000||Date.now()-time>15000)fail("REFERENCE_QUOTE_STALE");
 for(const x of ["bid","ask"]){if(!Number.isFinite(q[x])||q[x]<=0)fail("REFERENCE_QUOTE_UNAVAILABLE");calc.toTicks(symbol,q[x])}
 if(q.bid>q.ask)fail("REFERENCE_QUOTE_UNAVAILABLE");
 return q;
}
function tradeable(o,q){
 if(o.action==="CLOSE")return true;
 if(o.type==="MARKET")return true;
 return o.side==="BUY"?q.ask<=o.limit:q.bid>=o.limit;
}
function quotePrice(o,q){return o.side==="BUY"?q.ask:q.bid}
function serializeOrder(x){return {id:x.id,action:x.action,symbol:x.symbol,side:x.side,qty:x.qty,type:x.order_type,limitPrice:x.limit_price===null?null:Number(x.limit_price),status:x.status,fillPrice:x.fill_price===null?null:Number(x.fill_price),feeKrw:String(x.fee_krw),realizedPnlKrw:x.realized_pnl_krw===null?null:String(x.realized_pnl_krw),createdAt:x.created_at,updatedAt:x.updated_at}}
async function state(userId){
 await ensure();
 const [orders,positions]=await Promise.all([
 pool.query("SELECT * FROM hf_futures_internal_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200",[userId]),
 pool.query("SELECT * FROM hf_futures_internal_positions WHERE user_id=$1 AND state='OPEN' ORDER BY opened_at DESC LIMIT 150",[userId])
 ]);
 return {executionEnabled:true,orders:orders.rows.map(serializeOrder),positions:positions.rows.map(x=>({id:x.id,symbol:x.symbol,side:x.side,qty:x.qty,entry:Number(x.entry_price),openedAt:x.opened_at,marginKrw:String(x.margin_krw),state:x.state}))};
}
async function executeInTransaction(c,userId,o,q){
 const wallet=await c.query("SELECT futures_balance FROM hf_wallets WHERE user_id=$1 FOR UPDATE",[userId]);
 if(!wallet.rowCount)fail("WALLET_NOT_FOUND");
 const existing=await c.query("SELECT * FROM hf_futures_internal_orders WHERE user_id=$1 AND request_key=$2 FOR UPDATE",[userId,o.key]);
 if(existing.rowCount){
  const x=existing.rows[0];
  if(x.symbol!==o.symbol||x.side!==o.side||x.qty!==o.qty||x.action!==o.action||x.order_type!==o.type||String(x.position_id||"")!==String(o.positionId||"")||(o.type==="LIMIT"&&Number(x.limit_price)!==o.limit))fail("IDEMPOTENCY_CONFLICT");
  return {duplicate:true,order:serializeOrder(x)};
 }
 const account=await c.query("SELECT status FROM hf_users WHERE id=$1",[userId]);
 if(account.rows[0]?.status!=="ACTIVE")fail("MEMBER_NOT_ACTIVE");
 const blocked=await c.query("SELECT futures_blocked FROM hf_member_restrictions WHERE user_id=$1",[userId]);
 if(blocked.rows[0]?.futures_blocked)fail("FUTURES_TRADING_RESTRICTED");
 let pos=null;
 if(o.action==="CLOSE"){
  const p=await c.query("SELECT * FROM hf_futures_internal_positions WHERE id=$1 AND user_id=$2 AND state='OPEN' FOR UPDATE",[o.positionId,userId]);
  if(!p.rowCount)fail("POSITION_NOT_OPEN");
  pos=p.rows[0];
  if(pos.symbol!==o.symbol||pos.side===o.side||pos.qty!==o.qty)fail("POSITION_MISMATCH");
 }
 if(q)checkQuote(q,o.symbol);
 const fill=!!q&&tradeable(o,q);
 if(o.action==="CLOSE"&&!fill)fail("REFERENCE_QUOTE_UNAVAILABLE");
 const id=crypto.randomUUID(),price=fill?quotePrice(o,q):null;
 const fee=fill?calc.feesFor(o.qty):0;
 const status=fill?"FILLED":"HELD";
 const balance=Number(wallet.rows[0].futures_balance);
 if(!Number.isSafeInteger(balance))fail("INVALID_BALANCE");
 let delta=0,realized=null,margin=0;
 if(fill){
  if(o.action==="OPEN"){
   const prev=await c.query("SELECT symbol,qty,margin_krw FROM hf_futures_internal_positions WHERE user_id=$1 AND state='OPEN'",[userId]);
   const legacy=await c.query("SELECT symbol,qty FROM hf_positions WHERE user_id=$1 AND state='OPEN' AND product='FUTURES'",[userId]);
   const locked=prev.rows.reduce((sum,p)=>sum+Number(p.margin_krw),0)+legacy.rows.reduce((sum,p)=>sum+calc.marginFor(p.symbol,p.qty),0);
   const pending=await c.query("SELECT COALESCE(SUM(amount),0)::bigint AS amount FROM hf_funding_requests WHERE user_id=$1 AND account='FUTURES' AND kind='WITHDRAW' AND status='PENDING'",[userId]);
   margin=calc.marginFor(o.symbol,o.qty);
   if(calc.availableMargin({balanceKrw:balance,lockedKrw:locked,pendingWithdrawalsKrw:Number(pending.rows[0].amount)})<margin+fee)fail("INSUFFICIENT_MARGIN");
   delta=-fee;
  }else{
   const fx=1400; // Explicit fixed KRW/USD accounting rate until an audited live FX feed is supplied.
   realized=calc.settlementPlan({symbol:o.symbol,side:pos.side,entry:Number(pos.entry_price),exit:price,qty:o.qty,krwPerUsd:fx}).netPnlKrw;
   delta=realized;
  }
  if(!Number.isSafeInteger(balance+delta)||balance+delta<0)fail("INSUFFICIENT_SETTLEMENT_BALANCE");
 }
 await c.query("INSERT INTO hf_futures_internal_orders(id,user_id,request_key,action,symbol,side,qty,order_type,limit_price,position_id,status,fill_price,fee_krw,realized_pnl_krw,source,quote_at,fx_krw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",[id,userId,o.key,o.action,o.symbol,o.side,o.qty,o.type,o.limit,o.positionId,status,price,fee,realized,fill?q.source:null,fill?q.asOf:null,fill?1400:null]);
 if(fill){
  if(o.action==="OPEN")await c.query("INSERT INTO hf_futures_internal_positions(id,user_id,open_order_id,symbol,side,qty,entry_price,margin_krw) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[crypto.randomUUID(),userId,id,o.symbol,o.side,o.qty,price,margin]);
  else await c.query("UPDATE hf_futures_internal_positions SET state='CLOSED',close_order_id=$1,closed_at=NOW() WHERE id=$2 AND user_id=$3 AND state='OPEN'",[id,o.positionId,userId]);
  const updated=await c.query("UPDATE hf_wallets SET futures_balance=futures_balance+$1,updated_at=NOW() WHERE user_id=$2 AND futures_balance+$1>=0 RETURNING futures_balance",[String(delta),userId]);
  if(updated.rowCount!==1||Number(updated.rows[0].futures_balance)!==balance+delta)fail("WALLET_UPDATE_FAILED");
  await c.query("INSERT INTO hf_wallet_ledger(user_id,request_id,futures_order_id,account,delta,balance_after) VALUES($1,NULL,$2,'FUTURES',$3,$4)",[userId,id,String(delta),String(balance+delta)]);
 }
 await c.query("INSERT INTO hf_audit(actor_id,action,target,detail) VALUES($1,$2,$3,$4::jsonb)",[userId,"FUTURES_INTERNAL_"+(fill?"FILLED":"HELD"),id,JSON.stringify({symbol:o.symbol,side:o.side,action:o.action,qty:o.qty,price,source:fill?q.source:null,quoteAt:fill?q.asOf:null})]);
 const recorded=await c.query("SELECT * FROM hf_futures_internal_orders WHERE id=$1",[id]);
 return {duplicate:false,order:serializeOrder(recorded.rows[0])};
}
async function execute(userId,o,q){
 const c=await pool.connect();try{await c.query("BEGIN");const result=await executeInTransaction(c,userId,o,q);await c.query("COMMIT");return result}catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
}
async function cancel(userId,id){
 if(!UUID.test(id))fail("INVALID_ORDER");
 const c=await pool.connect();try{await c.query("BEGIN");const w=await c.query("SELECT futures_balance FROM hf_wallets WHERE user_id=$1 FOR UPDATE",[userId]);if(!w.rowCount)fail("WALLET_NOT_FOUND");
 const r=await c.query("UPDATE hf_futures_internal_orders SET status='CANCELLED',updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='HELD' RETURNING *",[id,userId]);if(!r.rowCount)fail("ORDER_NOT_HELD");await c.query("COMMIT");return {order:serializeOrder(r.rows[0])}}catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
}
async function matchPending(quoteProvider){
 await ensure();const o=await pool.query("SELECT * FROM hf_futures_internal_orders WHERE status='HELD' ORDER BY created_at LIMIT 50");
 for(const order of o.rows){
  let q;try{q=checkQuote(await quoteProvider(order.symbol),order.symbol)}catch{continue}
  const obj={symbol:order.symbol,side:order.side,qty:order.qty,type:order.order_type,limit:Number(order.limit_price),action:order.action};
  if(!tradeable(obj,q))continue;
  const c=await pool.connect();try{
   await c.query("BEGIN");const wallet=await c.query("SELECT futures_balance FROM hf_wallets WHERE user_id=$1 FOR UPDATE",[order.user_id]);if(!wallet.rowCount){await c.query("ROLLBACK");continue}
   const locked=await c.query("SELECT * FROM hf_futures_internal_orders WHERE id=$1 AND status='HELD' FOR UPDATE",[order.id]);if(!locked.rowCount){await c.query("ROLLBACK");continue}
   const member=await c.query("SELECT status FROM hf_users WHERE id=$1",[order.user_id]);
   const restriction=await c.query("SELECT futures_blocked FROM hf_member_restrictions WHERE user_id=$1",[order.user_id]);
   if(member.rows[0]?.status!=="ACTIVE"||restriction.rows[0]?.futures_blocked){await c.query("ROLLBACK");continue}
   checkQuote(q,order.symbol);
   const current=Number(wallet.rows[0].futures_balance),fee=calc.feesFor(order.qty),margin=calc.marginFor(order.symbol,order.qty);
   const prev=await c.query("SELECT symbol,qty,margin_krw FROM hf_futures_internal_positions WHERE user_id=$1 AND state='OPEN'",[order.user_id]);
   const legacy=await c.query("SELECT symbol,qty FROM hf_positions WHERE user_id=$1 AND product='FUTURES' AND state='OPEN'",[order.user_id]);
   const pending=await c.query("SELECT COALESCE(SUM(amount),0)::bigint AS amount FROM hf_funding_requests WHERE user_id=$1 AND account='FUTURES' AND kind='WITHDRAW' AND status='PENDING'",[order.user_id]);
   const used=prev.rows.reduce((n,p)=>n+Number(p.margin_krw),0)+legacy.rows.reduce((n,p)=>n+calc.marginFor(p.symbol,p.qty),0);
   if(calc.availableMargin({balanceKrw:current,lockedKrw:used,pendingWithdrawalsKrw:Number(pending.rows[0].amount)})<margin+fee){await c.query("ROLLBACK");continue}
   const px=quotePrice(obj,q);
   await c.query("UPDATE hf_futures_internal_orders SET status='FILLED',fill_price=$2,fee_krw=$3,source=$4,quote_at=$5,fx_krw=1400,updated_at=NOW() WHERE id=$1",[order.id,px,fee,q.source,q.asOf]);
   await c.query("INSERT INTO hf_futures_internal_positions(id,user_id,open_order_id,symbol,side,qty,entry_price,margin_krw) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[crypto.randomUUID(),order.user_id,order.id,order.symbol,order.side,order.qty,px,margin]);
   const upd=await c.query("UPDATE hf_wallets SET futures_balance=futures_balance-$1 WHERE user_id=$2 AND futures_balance>=$1 RETURNING futures_balance",[fee,order.user_id]);if(!upd.rowCount)fail("INSUFFICIENT_BALANCE");
   await c.query("INSERT INTO hf_wallet_ledger(user_id,request_id,futures_order_id,account,delta,balance_after) VALUES($1,NULL,$2,'FUTURES',$3,$4)",[order.user_id,order.id,-fee,upd.rows[0].futures_balance]);
   await c.query("INSERT INTO hf_audit(actor_id,action,target) VALUES($1,'FUTURES_INTERNAL_FILLED',$2)",[order.user_id,order.id]);
   await c.query("COMMIT");
  }catch(e){await c.query("ROLLBACK").catch(()=>{});console.warn("FUTURES_PENDING_MATCH",String(e.code||e.message).slice(0,70))}finally{c.release()}
 }
}
async function route(req,res,url,quoteProvider){
 if(!url.pathname.startsWith("/api/futures/internal/"))return false;
 try{
  await ensure();
  if(req.method!=="GET"&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)fail("ORIGIN_MISMATCH");
  const u=await auth(req);if(!u){send(res,401,{error:"LOGIN_REQUIRED"});return true}
  if(url.pathname==="/api/futures/internal/state"&&req.method==="GET"){send(res,200,await state(u.id));return true}
  if(url.pathname==="/api/futures/internal/order"&&req.method==="POST"){
   const o=input(await read(req));
   // Idempotent retries are answered without requiring a new quote.
   const old=await pool.query("SELECT * FROM hf_futures_internal_orders WHERE user_id=$1 AND request_key=$2",[u.id,o.key]);
   if(old.rowCount){
    const x=old.rows[0];
    if(x.symbol!==o.symbol||x.side!==o.side||x.qty!==o.qty||x.action!==o.action||x.order_type!==o.type||String(x.position_id||"")!==String(o.positionId||"")||(o.type==="LIMIT"&&Number(x.limit_price)!==o.limit))fail("IDEMPOTENCY_CONFLICT");
    send(res,200,{ok:true,duplicate:true,order:serializeOrder(x)});return true;
   }
   let quote;try{quote=checkQuote(await quoteProvider(o.symbol),o.symbol)}catch(e){send(res,503,{error:e.code||"REFERENCE_QUOTE_UNAVAILABLE"});return true}
   const value=await execute(u.id,o,quote);send(res,200,{ok:true,...value});return true;
  }
  if(url.pathname==="/api/futures/internal/cancel"&&req.method==="POST"){const value=await cancel(u.id,String((await read(req)).id||""));send(res,200,{ok:true,...value});return true}
  send(res,404,{error:"NOT_FOUND"});return true;
 }catch(e){
  const code=e.code||e.message;const expected=new Set(["INVALID_ORDER","INVALID_POSITION","INVALID_TICK_PRICE","INVALID_BODY","INVALID_JSON","INVALID_PRICE","INVALID_QTY","IDEMPOTENCY_CONFLICT","ORDER_NOT_HELD","POSITION_NOT_OPEN","POSITION_MISMATCH","INSUFFICIENT_MARGIN","INSUFFICIENT_SETTLEMENT_BALANCE","MEMBER_NOT_ACTIVE","FUTURES_TRADING_RESTRICTED","REFERENCE_QUOTE_STALE","REFERENCE_QUOTE_UNAVAILABLE","ORIGIN_MISMATCH"]);
  if(!expected.has(code))console.error("FUTURES_INTERNAL_ENGINE_ERROR",String(e.message).slice(0,100));
  send(res,code==="FUTURES_TRADING_RESTRICTED"||code==="ORIGIN_MISMATCH"?403:code==="INSUFFICIENT_MARGIN"||code==="INSUFFICIENT_SETTLEMENT_BALANCE"||code==="POSITION_NOT_OPEN"||code==="ORDER_NOT_HELD"||code==="IDEMPOTENCY_CONFLICT"?409:expected.has(code)?400:503,{error:expected.has(code)?code:"FUTURES_INTERNAL_UNAVAILABLE"});return true;
 }
}

async function rollbackSmoke(){
 await ensure();
 const c=await pool.connect();
 try{
  await c.query("BEGIN");
  const username="smoke_futures_"+crypto.randomBytes(8).toString("hex");
  const member=await c.query("INSERT INTO hf_users(username,password_hash,full_name,phone) VALUES($1,'SMOKE_NO_LOGIN','검증','00000000000') RETURNING id",[username]);
  const userId=member.rows[0].id;
  await c.query("INSERT INTO hf_wallets(user_id,futures_balance) VALUES($1,10000000)",[userId]);
  const quote=price=>({symbol:"NQ",bid:price,ask:price+.25,asOf:new Date().toISOString(),source:"MASSIVE_FUTURES",licensed:true,marketOpen:true});
  const open={symbol:"NQ",side:"BUY",qty:1,type:"MARKET",action:"OPEN",key:crypto.randomUUID(),limit:null,positionId:null};
  const bought=await executeInTransaction(c,userId,open,quote(22000));
  if(bought.order.status!=="FILLED"||Number(bought.order.fillPrice)!==22000.25)fail("SMOKE_OPEN_FAILED");
  const retry=await executeInTransaction(c,userId,open,quote(22000));
  if(!retry.duplicate||retry.order.id!==bought.order.id)fail("SMOKE_DUPLICATE_FAILED");
  const opened=await c.query("SELECT * FROM hf_futures_internal_positions WHERE open_order_id=$1",[bought.order.id]);
  if(opened.rowCount!==1||Number(opened.rows[0].margin_krw)!==500000)fail("SMOKE_MARGIN_FAILED");
  const close={symbol:"NQ",side:"SELL",qty:1,type:"MARKET",action:"CLOSE",key:crypto.randomUUID(),limit:null,positionId:opened.rows[0].id};
  const sold=await executeInTransaction(c,userId,close,quote(22001.25));
  if(sold.order.status!=="FILLED"||Number(sold.order.realizedPnlKrw)!==26500)fail("SMOKE_CLOSE_FAILED");
  const ledger=await c.query("SELECT delta,balance_after FROM hf_wallet_ledger WHERE user_id=$1 ORDER BY id",[userId]);
  const wallet=await c.query("SELECT futures_balance FROM hf_wallets WHERE user_id=$1",[userId]);
  if(ledger.rowCount!==2||Number(ledger.rows[0].delta)!==-1500||Number(ledger.rows[1].delta)!==26500||Number(wallet.rows[0].futures_balance)!==10025000)fail("SMOKE_LEDGER_FAILED");
  const pos=await c.query("SELECT state FROM hf_futures_internal_positions WHERE id=$1",[opened.rows[0].id]);
  if(pos.rows[0].state!=="CLOSED")fail("SMOKE_POSITION_NOT_CLOSED");
  let blocked=false;
  try{await executeInTransaction(c,userId,{...close,key:crypto.randomUUID()},quote(22001.25))}catch(e){blocked=e.code==="POSITION_NOT_OPEN";if(!blocked)throw e}
  if(!blocked)fail("SMOKE_DOUBLE_CLOSE");
  return {ok:true,rolledBack:true,orders:2,ledgerEntries:2,duplicateBlocked:true,doubleCloseBlocked:true};
 }finally{await c.query("ROLLBACK").catch(()=>{});c.release()}
}
module.exports={ensure,route,state,input,checkQuote,execute,matchPending,executeInTransaction,rollbackSmoke};
