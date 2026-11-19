"use strict";
/* Internal Korean-stock fills only. Adapted from HFM margin's stocks/trade:
 * atomic wallet debit/credit, average-cost holdings, idempotent orders, audit ledger.
 * No external broker/exchange order is ever placed.
 * Not callable with a synthetic quote through HTTP. Require a sufficiently recent
 * server-side provider price and explicit feature configuration. */
const crypto=require("node:crypto");
const core=require("./app-api"),funding=require("./funding-api"),directory=require("./stock-directory");
const {pool,auth}=core;
const SQL=[
 "CREATE TABLE IF NOT EXISTS hf_stock_positions(user_id BIGINT NOT NULL REFERENCES hf_users(id) ON DELETE CASCADE,symbol CHAR(6) NOT NULL,qty BIGINT NOT NULL DEFAULT 0 CHECK(qty>=0),cost_krw BIGINT NOT NULL DEFAULT 0 CHECK(cost_krw>=0),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,symbol))",
 "CREATE TABLE IF NOT EXISTS hf_stock_internal_orders(id UUID PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES hf_users(id) ON DELETE CASCADE,symbol CHAR(6) NOT NULL,side VARCHAR(4) NOT NULL CHECK(side IN ('BUY','SELL')),qty INTEGER NOT NULL CHECK(qty>0 AND qty<=100000),price_krw BIGINT NOT NULL CHECK(price_krw>0),gross_krw BIGINT NOT NULL CHECK(gross_krw>0),fee_krw BIGINT NOT NULL DEFAULT 0 CHECK(fee_krw>=0),realized_cost_krw BIGINT,realized_pnl_krw BIGINT,quote_source VARCHAR(40) NOT NULL,quote_at TIMESTAMPTZ NOT NULL,status VARCHAR(20) NOT NULL DEFAULT 'INTERNAL_FILLED' CHECK(status='INTERNAL_FILLED'),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
 "CREATE INDEX IF NOT EXISTS hf_stock_internal_orders_user ON hf_stock_internal_orders(user_id,created_at DESC)",
 "ALTER TABLE hf_wallet_ledger ALTER COLUMN request_id DROP NOT NULL",
 "ALTER TABLE hf_wallet_ledger ADD COLUMN IF NOT EXISTS stock_order_id UUID UNIQUE REFERENCES hf_stock_internal_orders(id)"
];
let initialized;
const send=(res,status,data)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(JSON.stringify(data))};
const fail=(code)=>{const e=new Error(code);e.code=code;throw e};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYMBOL=/^\d{6}$/;
function checkOrder(b){
 const symbol=String(b.symbol||""),side=String(b.side||"").toUpperCase(),qty=Number(b.qty),id=String(b.requestKey||b.clientOrderId||"");
 if(!SYMBOL.test(symbol)||!["BUY","SELL"].includes(side)||!Number.isSafeInteger(qty)||qty<1||qty>100000||!UUID.test(id))fail("INVALID_STOCK_ORDER");
 return {symbol,side,qty,id};
}
function checkQuote(quote,now=Date.now()){
 const price=Number(quote?.price),asOf=Date.parse(quote?.asOf||"");
 if(!Number.isSafeInteger(price)||price<=0||!Number.isFinite(asOf))fail("REFERENCE_QUOTE_UNAVAILABLE");
 if(now-asOf>60000||asOf-now>5000)fail("REFERENCE_QUOTE_STALE");
 if(quote?.marketStatus!=="REGULAR_SESSION")fail("MARKET_CLOSED");
 if(quote?.tradeable!==true)fail("REFERENCE_QUOTE_UNAVAILABLE");
 if(typeof quote?.source!=="string"||!quote.source)fail("INVALID_QUOTE_SOURCE");
 return {price,asOf:new Date(asOf).toISOString(),source:quote.source};
}
function signed(balance,delta){
 const value=BigInt(balance)+BigInt(delta);
 if(value<0n||value>100000000000000n)fail("INSUFFICIENT_BALANCE");
 return value;
}
function realizedCost(qty,cost,sold){
 const positionQty=BigInt(qty),positionCost=BigInt(cost),sellQty=BigInt(sold);
 if(positionQty<sellQty||sellQty<=0n)fail("INSUFFICIENT_SHARES");
 return sellQty===positionQty?positionCost:positionCost*sellQty/positionQty;
}
async function ensure(){
 if(!initialized)initialized=(async()=>{
  await core.ensureReady();await funding.ensure();
  const c=await pool.connect();
  try{await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(18202,2031)");for(const sql of SQL)await c.query(sql);await c.query("COMMIT")}
  catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
 })().catch(e=>{initialized=null;throw e});
 return initialized;
}
function allowed(){
 return process.env.HFM_STOCK_INTERNAL_TRADING_ENABLED==="true";
}
async function state(userId){
 await ensure();
 const [positions,orders]=await Promise.all([
  pool.query("SELECT symbol,qty,cost_krw,updated_at FROM hf_stock_positions WHERE user_id=$1 AND qty>0 ORDER BY symbol",[userId]),
  pool.query("SELECT id,symbol,side,qty,price_krw,gross_krw,fee_krw,realized_cost_krw,realized_pnl_krw,quote_source,quote_at,status,created_at FROM hf_stock_internal_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200",[userId])
 ]);
 return {enabled:allowed(),positions:positions.rows.map(x=>({symbol:x.symbol.trim(),qty:Number(x.qty),costKrw:String(x.cost_krw),avgPrice:Number(x.qty)?Number(x.cost_krw)/Number(x.qty):0,updatedAt:x.updated_at})),
  orders:orders.rows.map(x=>({id:x.id,symbol:x.symbol.trim(),side:x.side,qty:x.qty,priceKrw:Number(x.price_krw),grossKrw:String(x.gross_krw),feeKrw:String(x.fee_krw),realizedCostKrw:x.realized_cost_krw===null?null:String(x.realized_cost_krw),realizedPnlKrw:x.realized_pnl_krw===null?null:String(x.realized_pnl_krw),quoteSource:x.quote_source,quoteAt:x.quote_at,status:x.status,createdAt:x.created_at}))};
}
/* Caller owns BEGIN/COMMIT/ROLLBACK. c must be a dedicated DB client. */
async function transact(c,userId,order,quote){
 const {symbol,side,qty,id}=checkOrder(order);
 const q=checkQuote(quote);
 if(!Number.isSafeInteger(qty*q.price)||qty*q.price>10000000000)fail("ORDER_TOO_LARGE");
 const gross=BigInt(qty)*BigInt(q.price),fee=0n;
 const acc=await c.query("SELECT role,status FROM hf_users WHERE id=$1 FOR UPDATE",[userId]);
 await c.query("INSERT INTO hf_wallets(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING",[userId]);
 const wallet=await c.query("SELECT stocks_balance FROM hf_wallets WHERE user_id=$1 FOR UPDATE",[userId]);
 if(wallet.rowCount!==1)fail("WALLET_NOT_FOUND");
 const old=await c.query("SELECT * FROM hf_stock_internal_orders WHERE id=$1",[id]);
 if(old.rowCount){
  const row=old.rows[0];
  if(String(row.user_id)!==String(userId)||row.symbol.trim()!==symbol||row.side!==side||Number(row.qty)!==qty)fail("IDEMPOTENCY_CONFLICT");
  return {id,duplicate:true,priceKrw:Number(row.price_krw),grossKrw:String(row.gross_krw)};
 }

 if(acc.rowCount!==1||acc.rows[0].status!=="ACTIVE")fail("MEMBER_NOT_ACTIVE");
 const restriction=await c.query("SELECT stocks_blocked FROM hf_member_restrictions WHERE user_id=$1",[userId]);
 if(restriction.rows[0]?.stocks_blocked)fail("STOCK_TRADING_RESTRICTED");
 const cash=BigInt(wallet.rows[0].stocks_balance);
 let delta,release=null;
 if(side==="BUY"){
  const pending=await c.query("SELECT COALESCE(SUM(amount),0)::bigint AS amount FROM hf_funding_requests WHERE user_id=$1 AND account='STOCKS' AND kind='WITHDRAW' AND status='PENDING'",[userId]);
  const available=cash-BigInt(pending.rows[0].amount);
  if(available<gross+fee)fail("INSUFFICIENT_BALANCE");
  delta=-(gross+fee);
  await c.query("INSERT INTO hf_stock_positions(user_id,symbol,qty,cost_krw) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,symbol) DO UPDATE SET qty=hf_stock_positions.qty+EXCLUDED.qty,cost_krw=hf_stock_positions.cost_krw+EXCLUDED.cost_krw,updated_at=NOW()",[userId,symbol,qty,String(gross)]);
 }else{
  const pos=await c.query("SELECT qty,cost_krw FROM hf_stock_positions WHERE user_id=$1 AND symbol=$2 FOR UPDATE",[userId,symbol]);
  if(!pos.rowCount||BigInt(pos.rows[0].qty)<BigInt(qty))fail("INSUFFICIENT_SHARES");
  release=realizedCost(pos.rows[0].qty,pos.rows[0].cost_krw,qty);
  delta=gross-fee;
  await c.query("UPDATE hf_stock_positions SET qty=qty-$3,cost_krw=cost_krw-$4,updated_at=NOW() WHERE user_id=$1 AND symbol=$2",[userId,symbol,qty,String(release)]);
 }
 const after=signed(cash,delta);
 const upd=await c.query("UPDATE hf_wallets SET stocks_balance=$1,updated_at=NOW() WHERE user_id=$2 RETURNING stocks_balance",[String(after),userId]);
 if(!upd.rowCount||BigInt(upd.rows[0].stocks_balance)!==after)fail("WALLET_UPDATE_FAILED");
 const realized=release===null?null:gross-fee-release;
 await c.query("INSERT INTO hf_stock_internal_orders(id,user_id,symbol,side,qty,price_krw,gross_krw,fee_krw,realized_cost_krw,realized_pnl_krw,quote_source,quote_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[id,userId,symbol,side,qty,q.price,String(gross),String(fee),release===null?null:String(release),realized===null?null:String(realized),q.source,q.asOf]);
 await c.query("INSERT INTO hf_wallet_ledger(user_id,request_id,stock_order_id,account,delta,balance_after) VALUES($1,NULL,$2,'STOCKS',$3,$4)",[userId,id,String(delta),String(after)]);
 await c.query("INSERT INTO hf_audit(actor_id,action,target,detail) VALUES($1,$2,$3,$4::jsonb)",[userId,"STOCK_INTERNAL_"+side,id,JSON.stringify({symbol,qty,price:q.price,source:q.source,quoteAt:q.asOf})]);
 return {id,duplicate:false,status:"INTERNAL_FILLED",priceKrw:q.price,grossKrw:String(gross),balanceKrw:String(after),realizedPnlKrw:realized===null?null:String(realized)};
}
async function rollbackSmoke(){
 await ensure();
 const c=await pool.connect();
 try{
  await c.query("BEGIN");
  const name="smoke_"+crypto.randomBytes(8).toString("hex");
  const member=await c.query("INSERT INTO hf_users(username,password_hash,full_name,phone) VALUES($1,'SMOKE_NO_LOGIN','계산검증','00000000000') RETURNING id",[name]);
  const userId=member.rows[0].id;
  await c.query("INSERT INTO hf_wallets(user_id,stocks_balance) VALUES($1,1000000)",[userId]);
  const quote={price:10000,asOf:new Date().toISOString(),source:"INTERNAL_TEST_ONLY",marketStatus:"REGULAR_SESSION",tradeable:true};
  const buyKey=crypto.randomUUID(),sellKey=crypto.randomUUID();
  const bought=await transact(c,userId,{symbol:"005930",side:"BUY",qty:10,requestKey:buyKey},quote);
  if(bought.balanceKrw!=="900000")fail("SMOKE_BUY_BALANCE");
  const repeated=await transact(c,userId,{symbol:"005930",side:"BUY",qty:10,requestKey:buyKey},quote);
  if(!repeated.duplicate)fail("SMOKE_IDEMPOTENCY");
  const sold=await transact(c,userId,{symbol:"005930",side:"SELL",qty:4,requestKey:sellKey},quote);
  if(sold.balanceKrw!=="940000"||sold.realizedPnlKrw!=="0")fail("SMOKE_SELL_ACCOUNTING");
  const [pos,rows]=await Promise.all([
   c.query("SELECT qty,cost_krw FROM hf_stock_positions WHERE user_id=$1 AND symbol='005930'",[userId]),
   c.query("SELECT delta,balance_after FROM hf_wallet_ledger WHERE user_id=$1 ORDER BY id",[userId])
  ]);
  if(Number(pos.rows[0]?.qty)!==6||Number(pos.rows[0]?.cost_krw)!==60000||rows.rowCount!==2)fail("SMOKE_LEDGER_MISMATCH");
  for(const [item,reason] of [
   [{symbol:"005930",side:"SELL",qty:7,requestKey:crypto.randomUUID()},"INSUFFICIENT_SHARES"],
   [{symbol:"005930",side:"BUY",qty:1000,requestKey:crypto.randomUUID()},"INSUFFICIENT_BALANCE"],
   [{symbol:"005930",side:"BUY",qty:11,requestKey:buyKey},"IDEMPOTENCY_CONFLICT"]
  ]){
   let blocked=false;
   try{await transact(c,userId,item,quote)}
   catch(e){blocked=e.code===reason;if(!blocked)throw e}
   if(!blocked)fail("SMOKE_RISK_CHECK_FAILED_"+reason);
  }
  const after=await c.query("SELECT stocks_balance FROM hf_wallets WHERE user_id=$1",[userId]);
  if(String(after.rows[0]?.stocks_balance)!=="940000")fail("SMOKE_BALANCE_CHANGED_AFTER_BLOCK");

  return {ok:true,bought:10,sold:4,remaining:6,ledger:2,duplicateBlocked:true,insufficientFundsBlocked:true,oversellBlocked:true,conflictingRetryBlocked:true,rolledBack:true};
 }finally{await c.query("ROLLBACK").catch(()=>{});c.release()}
}
// Rollback-only verification against the production quote provider; no user data persists.
async function rollbackLiveQuoteSmoke(provider){
 await ensure();
 const quote=await provider("005930");
 const verified=checkQuote({...quote,tradeable:true});
 const c=await pool.connect();
 try{
  await c.query("BEGIN");
  const member=await c.query("INSERT INTO hf_users(username,password_hash,full_name,phone) VALUES($1,'SMOKE_NO_LOGIN','검증','00000000000') RETURNING id",["smoke_live_"+crypto.randomBytes(8).toString("hex")]);
  const userId=member.rows[0].id;
  await c.query("INSERT INTO hf_wallets(user_id,stocks_balance) VALUES($1,$2)",[userId,1000000000]);
  const key=crypto.randomUUID();
  const buy=await transact(c,userId,{symbol:"005930",side:"BUY",qty:1,requestKey:key},{...quote,tradeable:true});
  if(!buy.id||buy.priceKrw!==verified.price||buy.balanceKrw!==String(1000000000-verified.price))fail("LIVE_QUOTE_BUY_MISMATCH");
  const replay=await transact(c,userId,{symbol:"005930",side:"BUY",qty:1,requestKey:key},{...quote,tradeable:true});
  if(!replay.duplicate)fail("LIVE_QUOTE_RETRY_MISMATCH");
  const sold=await transact(c,userId,{symbol:"005930",side:"SELL",qty:1,requestKey:crypto.randomUUID()},{...quote,tradeable:true});
  if(sold.realizedPnlKrw!=="0"||sold.balanceKrw!=="1000000000")fail("LIVE_QUOTE_SELL_MISMATCH");
  return {ok:true,rolledBack:true,source:verified.source,price:verified.price,sideCount:2};
 }finally{await c.query("ROLLBACK").catch(()=>{});c.release()}
}
async function route(req,res,url,quoteProvider){
 const p=url.pathname;
 if(p!=="/api/stocks/internal")return false;
 try{
  await ensure();
  const user=await auth(req);if(!user){send(res,401,{error:"LOGIN_REQUIRED"});return true}
  if(req.method==="GET"){send(res,200,await state(user.id));return true}
  if(req.method!=="POST"){send(res,405,{error:"METHOD_NOT_ALLOWED"});return true}
  if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host){send(res,403,{error:"ORIGIN_MISMATCH"});return true}
  let size=0,text="";for await(const chunk of req){size+=chunk.length;if(size>4096)fail("INVALID_BODY");text+=chunk}
  let b;try{b=JSON.parse(text)}catch{fail("INVALID_JSON")}
  const o=checkOrder(b);
  if(!allowed()){send(res,503,{error:"STOCK_INTERNAL_EXECUTION_DISABLED"});return true}
  const duplicate=await pool.query("SELECT user_id,symbol,side,qty,price_krw,gross_krw FROM hf_stock_internal_orders WHERE id=$1",[o.id]);
  if(duplicate.rowCount){
   const row=duplicate.rows[0];
   if(String(row.user_id)!==String(user.id)||row.symbol.trim()!==o.symbol||row.side!==o.side||Number(row.qty)!==o.qty){
    send(res,409,{error:"IDEMPOTENCY_CONFLICT"});return true;
   }
   send(res,200,{ok:true,id:o.id,duplicate:true,executionMode:"INTERNAL_MARKET_REFERENCE",priceKrw:Number(row.price_krw),grossKrw:String(row.gross_krw)});return true;
  }
  const listed=await directory.find(o.symbol);
  if(!listed){send(res,404,{error:"STOCK_NOT_LISTED"});return true}
  const quote=await quoteProvider(o.symbol);
  const c=await pool.connect();
  try{
   await c.query("BEGIN");
   const result=await transact(c,user.id,o,{...quote,tradeable:true});
   await c.query("COMMIT");
   send(res,200,{ok:true,executionMode:"INTERNAL_MARKET_REFERENCE",...result});return true;
  }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
 }catch(e){
  const errors=new Set(["INVALID_STOCK_ORDER","INVALID_BODY","INVALID_JSON","ORDER_TOO_LARGE","IDEMPOTENCY_CONFLICT","INSUFFICIENT_BALANCE","INSUFFICIENT_SHARES","STOCK_TRADING_RESTRICTED","MARKET_CLOSED","REFERENCE_QUOTE_STALE","REFERENCE_QUOTE_UNAVAILABLE","QUOTE_ENTITLEMENT_REQUIRED"]);
  const code=e.code||e.message;const status=code==="INSUFFICIENT_BALANCE"||code==="INSUFFICIENT_SHARES"||code==="IDEMPOTENCY_CONFLICT"?409:code==="STOCK_TRADING_RESTRICTED"?403:code==="MARKET_CLOSED"||code==="REFERENCE_QUOTE_STALE"||code==="REFERENCE_QUOTE_UNAVAILABLE"||code==="QUOTE_ENTITLEMENT_REQUIRED"?503:errors.has(code)?400:503;
  console.warn("HFM_STOCK_ORDER_REJECTED",JSON.stringify({code:errors.has(code)?code:"STOCK_EXECUTION_FAILED",status}));
  if(!errors.has(code))console.error("HFM_STOCK_ENGINE_ERROR",String(e.message).slice(0,90));
  send(res,status,{error:errors.has(code)?code:"STOCK_EXECUTION_FAILED"});return true;
 }
}
module.exports={SQL,ensure,state,transact,rollbackSmoke,rollbackLiveQuoteSmoke,route,checkQuote,checkOrder,realizedCost};
