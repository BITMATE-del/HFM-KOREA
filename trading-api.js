"use strict";
const core=require("./app-api"),funding=require("./funding-api");
const {pool,auth}=core;
const stockDirectory=require("./stock-directory");
const stockEngine=require("./stock-internal-engine");
const instruments={NQ:["FUTURES",.25],MNQ:["FUTURES",.25],ES:["FUTURES",.25],MES:["FUTURES",.25],GC:["FUTURES",.1],MGC:["FUTURES",.1],CL:["FUTURES",.01],"005930":["STOCKS",1],"000660":["STOCKS",1],"035420":["STOCKS",1],"005380":["STOCKS",1]};
const SQL=[
"CREATE TABLE IF NOT EXISTS hf_orders(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES hf_users(id) ON DELETE CASCADE,request_key UUID NOT NULL,symbol VARCHAR(12) NOT NULL,product VARCHAR(12) NOT NULL CHECK(product IN ('FUTURES','STOCKS')),side VARCHAR(4) NOT NULL CHECK(side IN ('BUY','SELL')),order_type VARCHAR(8) NOT NULL CHECK(order_type IN ('LIMIT','MARKET')),qty INTEGER NOT NULL CHECK(qty>0 AND qty<=100),limit_price NUMERIC(18,5),status VARCHAR(12) NOT NULL DEFAULT 'HELD' CHECK(status IN ('HELD','CANCELLED','FILLED','REJECTED')),reason VARCHAR(80) NOT NULL DEFAULT 'MARKET_DATA_NOT_AVAILABLE',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,request_key))",
"CREATE INDEX IF NOT EXISTS hf_orders_user ON hf_orders(user_id,created_at DESC)",
"CREATE TABLE IF NOT EXISTS hf_positions(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES hf_users(id) ON DELETE CASCADE,symbol VARCHAR(12) NOT NULL,product VARCHAR(12) NOT NULL CHECK(product IN ('FUTURES','STOCKS')),side VARCHAR(4) NOT NULL CHECK(side IN ('BUY','SELL')),qty INTEGER NOT NULL CHECK(qty>0),entry_price NUMERIC(18,5) NOT NULL CHECK(entry_price>0),open_order_id BIGINT NOT NULL UNIQUE REFERENCES hf_orders(id),state VARCHAR(12) NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CLOSED')),opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),closed_at TIMESTAMPTZ)",
"CREATE INDEX IF NOT EXISTS hf_positions_user ON hf_positions(user_id,state)",
"CREATE TABLE IF NOT EXISTS hf_fills(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES hf_users(id) ON DELETE CASCADE,order_id BIGINT NOT NULL UNIQUE REFERENCES hf_orders(id),position_id BIGINT REFERENCES hf_positions(id),symbol VARCHAR(12) NOT NULL,qty INTEGER NOT NULL CHECK(qty>0),price NUMERIC(18,5) NOT NULL CHECK(price>0),fee_krw BIGINT NOT NULL DEFAULT 0,executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),source VARCHAR(40) NOT NULL)"
];
let ready;
async function ensure(){if(!ready)ready=(async()=>{await core.ensureReady();await funding.ensure();const c=await pool.connect();try{await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(18202,2028)");for(const sql of SQL)await c.query(sql);await c.query("COMMIT")}catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}})().catch(e=>{ready=null;throw e});return ready}
const send=(res,status,data)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(JSON.stringify(data))};
async function read(req){let n=0;const parts=[];for await(const p of req){n+=p.length;if(n>8192)throw Error("BODY_TOO_LARGE");parts.push(p)}try{const x=JSON.parse(Buffer.concat(parts).toString());if(!x||Array.isArray(x)||typeof x!=="object")throw Error();return x}catch{throw Error("INVALID_JSON")}}
const dto=o=>({id:String(o.id),symbol:o.symbol,product:o.product,side:o.side,type:o.order_type,qty:o.qty,limitPrice:o.limit_price===null?null:Number(o.limit_price),status:o.status,reason:o.reason,createdAt:o.created_at,updatedAt:o.updated_at});
async function route(req,res,url){
 const path=url.pathname;if(!path.startsWith("/api/trading/")&&!path.startsWith("/api/admin/trading/"))return false;
 try{
  await ensure();
  if(req.method!=="GET"&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host){send(res,403,{error:"ORIGIN_MISMATCH"});return true}
  const u=await auth(req);if(!u){send(res,401,{error:"LOGIN_REQUIRED"});return true}
  const admin=path.startsWith("/api/admin/");
  if(admin&&u.role!=="ADMIN"){send(res,403,{error:"ADMIN_REQUIRED"});return true}
  const m=req.method,b=m==="POST"?await read(req):{};
  if(!admin&&m==="POST"&&path.startsWith("/api/trading/orders")){
   const blocked=await pool.query("SELECT futures_blocked,stocks_blocked FROM hf_member_restrictions WHERE user_id=$1",[u.id]);
   const x=blocked.rows[0],code=String(b.symbol||"").toUpperCase(),spec=instruments[code]||(/^[0-9]{6}$/.test(code)?["STOCKS",1]:null);
   if((x?.futures_blocked&&spec?.[0]==="FUTURES")||(x?.stocks_blocked&&spec?.[0]==="STOCKS")){send(res,403,{error:"TRADING_RESTRICTED"});return true}
  }
  if(path==="/api/trading/state"&&m==="GET"){
   const [orders,positions,fills,wallet,internalStocks]=await Promise.all([
    pool.query("SELECT * FROM hf_orders WHERE user_id=$1 ORDER BY id DESC LIMIT 150",[u.id]),
    pool.query("SELECT * FROM hf_positions WHERE user_id=$1 ORDER BY id DESC LIMIT 150",[u.id]),
    pool.query("SELECT * FROM hf_fills WHERE user_id=$1 ORDER BY id DESC LIMIT 150",[u.id]),
    pool.query("SELECT futures_balance,stocks_balance FROM hf_wallets WHERE user_id=$1",[u.id]),
    stockEngine.state(u.id)
   ]);
   const stockOrders=internalStocks.orders.map(o=>({id:o.id,symbol:o.symbol,product:"STOCKS",side:o.side,type:"MARKET",qty:o.qty,limitPrice:null,status:"FILLED",reason:"INTERNAL_MARKET_REFERENCE",createdAt:o.createdAt,updatedAt:o.createdAt,fillPrice:o.priceKrw,realizedPnlKrw:o.realizedPnlKrw,feeKrw:o.feeKrw}));
   const stockPositions=internalStocks.positions.map(p=>({id:"STOCK:"+p.symbol,symbol:p.symbol,product:"STOCKS",side:"BUY",qty:p.qty,entry:p.avgPrice,costKrw:p.costKrw,state:"OPEN",openedAt:p.updatedAt}));
   send(res,200,{executionEnabled:false,internalStockExecutionEnabled:internalStocks.enabled,marketDataReady:false,
    orders:[...stockOrders,...orders.rows.map(dto)],positions:[...stockPositions,...positions.rows.map(x=>({id:String(x.id),symbol:x.symbol,side:x.side,qty:x.qty,entry:Number(x.entry_price),product:x.product,state:x.state}))],
    fills:fills.rows.map(x=>({id:String(x.id),symbol:x.symbol,qty:x.qty,price:Number(x.price),feeKrw:String(x.fee_krw)})),
    wallet:{futuresBalance:String(wallet.rows[0]?.futures_balance||0),stocksBalance:String(wallet.rows[0]?.stocks_balance||0)}});return true;
  }
  if(path==="/api/trading/risk-preview"&&m==="GET"){
   const symbol=String(url.searchParams.get("symbol")||"").toUpperCase();
   const qty=Number(url.searchParams.get("qty")||"");
   if(!instruments[symbol]||!Number.isSafeInteger(qty)||qty<1||qty>100){send(res,400,{error:"INVALID_RISK_INPUT"});return true}
   if(instruments[symbol][0]!=="FUTURES"){send(res,400,{error:"FUTURES_ONLY"});return true}
   const calc=require("./settlement-core");
   const [balance,withdrawals,positions]=await Promise.all([
    pool.query("SELECT futures_balance FROM hf_wallets WHERE user_id=$1",[u.id]),
    pool.query("SELECT COALESCE(SUM(amount),0)::bigint AS total FROM hf_funding_requests WHERE user_id=$1 AND account='FUTURES' AND kind='WITHDRAW' AND status='PENDING'",[u.id]),
    pool.query("SELECT symbol,qty FROM hf_positions WHERE user_id=$1 AND product='FUTURES' AND state='OPEN'",[u.id])
   ]);
   const locked=positions.rows.reduce((sum,p)=>sum+calc.marginFor(p.symbol,p.qty),0);
   const cash=Number(balance.rows[0]?.futures_balance||0),pending=Number(withdrawals.rows[0]?.total||0);
   const available=calc.availableMargin({balanceKrw:cash,lockedKrw:locked,pendingWithdrawalsKrw:pending});
   const margin=calc.marginFor(symbol,qty),estimatedFee=calc.feesFor(qty);
   send(res,200,{symbol,qty,balanceKrw:String(cash),lockedMarginKrw:String(locked),pendingWithdrawalKrw:String(pending),
    availableKrw:String(available),marginRequiredKrw:String(margin),estimatedFeeKrw:String(estimatedFee),
    enoughBalance:available>=margin+estimatedFee,canExecute:false,reason:"LIVE_PRICE_AND_SETTLEMENT_DISABLED"});
   return true;
  }
  if(path==="/api/trading/orders"&&m==="POST"){
   const symbol=String(b.symbol||"").toUpperCase(),spec=instruments[symbol]||(/^[0-9]{6}$/.test(symbol)?["STOCKS",1]:null),side=String(b.side||""),type=String(b.type||"").toUpperCase(),qty=Number(b.qty),limit=Number(b.limitPrice),key=String(b.requestKey||"");
   if(!spec||!["BUY","SELL"].includes(side)||!["LIMIT","MARKET"].includes(type)||!Number.isSafeInteger(qty)||qty<1||qty>100||!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(key)){send(res,400,{error:"INVALID_ORDER"});return true}
   if(spec[0]==="STOCKS"){
    let listed;
    try{listed=await stockDirectory.find(symbol)}catch{send(res,503,{error:"STOCK_CATALOG_UNAVAILABLE"});return true}
    if(!listed){send(res,404,{error:"STOCK_SYMBOL_NOT_LISTED"});return true}
   }
   if(type==="MARKET"){send(res,409,{error:"MARKET_DATA_UNAVAILABLE",executionEnabled:false});return true}
   if(!Number.isFinite(limit)||limit<=0||Math.abs(Math.round(limit/spec[1])*spec[1]-limit)>1e-6){send(res,400,{error:"INVALID_TICK_PRICE"});return true}
   const c=await pool.connect();try{
    await c.query("BEGIN");
    const old=await c.query("SELECT * FROM hf_orders WHERE user_id=$1 AND request_key=$2 FOR UPDATE",[u.id,key]);
    if(old.rowCount){
     const x=old.rows[0];if(x.symbol!==symbol||x.side!==side||x.order_type!==type||x.qty!==qty||Number(x.limit_price)!==limit){await c.query("ROLLBACK");send(res,409,{error:"REQUEST_KEY_CONFLICT"});return true}
     await c.query("COMMIT");send(res,200,{ok:true,duplicate:true,order:dto(x)});return true;
    }
    const count=await c.query("SELECT COUNT(*)::int AS n FROM hf_orders WHERE user_id=$1 AND status='HELD'",[u.id]);
    if(count.rows[0].n>=100){await c.query("ROLLBACK");send(res,409,{error:"TOO_MANY_HELD_ORDERS"});return true}
    const r=await c.query("INSERT INTO hf_orders(user_id,request_key,symbol,product,side,order_type,qty,limit_price) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,request_key) DO NOTHING RETURNING *",[u.id,key,symbol,spec[0],side,type,qty,limit]);
    if(!r.rowCount){const found=(await c.query("SELECT * FROM hf_orders WHERE user_id=$1 AND request_key=$2",[u.id,key])).rows[0];
 if(!found||found.symbol!==symbol||found.side!==side||found.order_type!==type||found.qty!==qty||Number(found.limit_price)!==limit){await c.query("ROLLBACK");send(res,409,{error:"REQUEST_KEY_CONFLICT"});return true}
 await c.query("COMMIT");send(res,200,{ok:true,duplicate:true,order:dto(found)});return true}
 await c.query("INSERT INTO hf_audit(actor_id,action,target) VALUES($1,'ORDER_HELD',$2)",[u.id,String(r.rows[0].id)]);
    await c.query("COMMIT");send(res,201,{ok:true,executionEnabled:false,order:dto(r.rows[0])});return true;
   }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
  }
  const cancel=path.match(/^\/api\/trading\/orders\/(\d+)\/cancel$/);
  if(cancel&&m==="POST"){
   const c=await pool.connect();try{
    await c.query("BEGIN");
    const q=await c.query("UPDATE hf_orders SET status='CANCELLED',updated_at=NOW(),reason='USER_CANCELLED' WHERE id=$1 AND user_id=$2 AND status='HELD' RETURNING *",[cancel[1],u.id]);
    if(!q.rowCount){await c.query("ROLLBACK");send(res,409,{error:"ORDER_NOT_HELD"});return true}
    await c.query("INSERT INTO hf_audit(actor_id,action,target) VALUES($1,'ORDER_CANCELLED',$2)",[u.id,cancel[1]]);
    await c.query("COMMIT");send(res,200,{ok:true,order:dto(q.rows[0])});return true;
   }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
  }
  if(path==="/api/admin/trading/reconciliation"&&m==="GET"){
   const [counts,anomalies]=await Promise.all([
    pool.query("SELECT (SELECT COUNT(*)::int FROM hf_orders WHERE status='HELD') AS held_orders,(SELECT COUNT(*)::int FROM hf_orders WHERE status='FILLED') AS filled_orders,(SELECT COUNT(*)::int FROM hf_positions WHERE state='OPEN') AS open_positions,(SELECT COUNT(*)::int FROM hf_fills) AS recorded_fills,(SELECT COUNT(*)::int FROM hf_fills f LEFT JOIN hf_orders o ON o.id=f.order_id WHERE o.id IS NULL OR o.status<>'FILLED') AS inconsistent_fills"),
    pool.query("SELECT w.user_id,u.username,w.futures_balance,w.stocks_balance,COALESCE(l.futures,0)::bigint AS ledger_futures,COALESCE(l.stocks,0)::bigint AS ledger_stocks FROM hf_wallets w JOIN hf_users u ON u.id=w.user_id LEFT JOIN (SELECT user_id,SUM(delta) FILTER(WHERE account='FUTURES') AS futures,SUM(delta) FILTER(WHERE account='STOCKS') AS stocks FROM hf_wallet_ledger GROUP BY user_id) l ON l.user_id=w.user_id WHERE w.futures_balance<>COALESCE(l.futures,0) OR w.stocks_balance<>COALESCE(l.stocks,0) ORDER BY w.user_id LIMIT 50")
   ]);
   send(res,200,{executionEnabled:false,summary:counts.rows[0],walletMismatchCount:anomalies.rowCount,affectedUsers:anomalies.rows.map(x=>({userId:String(x.user_id),username:x.username,futuresBalance:String(x.futures_balance),stocksBalance:String(x.stocks_balance),ledgerFutures:String(x.ledger_futures),ledgerStocks:String(x.ledger_stocks)})),warning:anomalies.rowCount===50?"LIMIT_REACHED":"NONE"});
   return true;
  }
  if(path==="/api/admin/trading/orders"&&m==="GET"){
   const [q,stocks]=await Promise.all([
    pool.query("SELECT o.*,u.username FROM hf_orders o JOIN hf_users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 200"),
    pool.query("SELECT o.*,u.username FROM hf_stock_internal_orders o JOIN hf_users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 200")
   ]);
   const items=[...q.rows.map(x=>({...dto(x),username:x.username})),...stocks.rows.map(x=>({id:String(x.id),username:x.username,symbol:x.symbol.trim(),product:"STOCKS",side:x.side,type:"MARKET",qty:x.qty,limitPrice:Number(x.price_krw),status:"FILLED",createdAt:x.created_at}))].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,200);
   send(res,200,{executionEnabled:false,items});return true;
  }
  if(path==="/api/admin/trading/positions"&&m==="GET"){
   const [q,stocks]=await Promise.all([
    pool.query("SELECT p.*,u.username FROM hf_positions p JOIN hf_users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 200"),
    pool.query("SELECT p.*,u.username FROM hf_stock_positions p JOIN hf_users u ON u.id=p.user_id WHERE p.qty>0 ORDER BY p.updated_at DESC LIMIT 200")
   ]);
   send(res,200,{items:[...q.rows.map(x=>({id:String(x.id),username:x.username,symbol:x.symbol,qty:x.qty,side:x.side,entry:Number(x.entry_price),state:x.state})),...stocks.rows.map(x=>({id:"STOCK:"+x.user_id+":"+x.symbol.trim(),username:x.username,symbol:x.symbol.trim(),qty:Number(x.qty),side:"BUY",entry:Number(x.cost_krw)/Number(x.qty),state:"OPEN"}))]});return true;
  }
  send(res,404,{error:"NOT_FOUND"});return true;
 }catch(e){console.error("TRADING_API_ERROR",String(e.message).slice(0,100));const known=["INVALID_JSON","BODY_TOO_LARGE"].includes(e.message);send(res,known?400:503,{error:known?e.message:"SERVICE_UNAVAILABLE"});return true}
}
module.exports={route,ensure};