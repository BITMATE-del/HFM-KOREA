"use strict";
/*
 * HFM internal futures stop-out, separate from market chart and execution engine.
 * Uses actual licensed executable bid/ask; never fabricates prices.
 * Policy: stop out ALL open internal positions when wallet balance + net
 * close-out PnL <= 0; realized excess deficit is explicitly recorded in audit
 * while the non-negative futures wallet/ledger stay at zero.
 */
const crypto=require("node:crypto");
const calc=require("./settlement-core");
const FX_KRW=1400;
const ZERO_EQUITY_KRW=0;
function validateQuote(q,symbol,now=Date.now()){
 if(!q||q.symbol!==symbol||q.source!=="MASSIVE_FUTURES"||q.licensed!==true||
  q.marketOpen===false||typeof q.contract!=="string"||!q.contract)return null;
 const ts=Date.parse(q.asOf);
 if(!Number.isFinite(ts)||ts>now+1000||now-ts>10000)return null;
 if(!(Number.isFinite(q.bid)&&Number.isFinite(q.ask)&&q.bid>0&&q.ask>0&&q.bid<=q.ask))return null;
 try{calc.toTicks(symbol,q.bid);calc.toTicks(symbol,q.ask)}catch{return null}
 return q;
}
function evaluate(balance,positions,quotes,now=Date.now()){
 if(!Number.isSafeInteger(balance)||balance<0||!Array.isArray(positions)||!positions.length)return null;
 let equity=balance,unrealized=0;
 const settlements=[];
 for(const p of positions){
  const q=validateQuote(quotes[p.symbol],p.symbol,now);
  if(!q)return null;
  if(!Number.isSafeInteger(Number(p.qty))||Number(p.qty)<1||Number(p.qty)>100)return null;
  const exit=p.side==="BUY"?q.bid:q.ask;
  let plan;
  try{
   plan=calc.settlementPlan({symbol:p.symbol,side:p.side,entry:Number(p.entry_price),exit,qty:Number(p.qty),krwPerUsd:FX_KRW});
  }catch{return null}
  unrealized+=plan.netPnlKrw;
  if(!Number.isSafeInteger(unrealized))return null;
  settlements.push({position:p,quote:q,exit,netPnlKrw:plan.netPnlKrw,feeKrw:plan.feeKrw});
 }
 equity+=unrealized;
 if(!Number.isSafeInteger(equity))return null;
 return {balance,equity,unrealized,liquidate:equity<=ZERO_EQUITY_KRW,settlements};
}
async function settleAccount(pool,userId,quotes,{now=Date.now(),logger=console}={}){
 const c=await pool.connect();
 try{
  await c.query("BEGIN");
  // Lock in the same order as the existing customer order engine.
  const wallet=await c.query("SELECT futures_balance FROM hf_wallets WHERE user_id=$1 FOR UPDATE",[userId]);
  if(!wallet.rowCount){await c.query("ROLLBACK");return {status:"no_wallet"}}
  const rows=await c.query("SELECT * FROM hf_futures_internal_positions WHERE user_id=$1 AND state='OPEN' ORDER BY id FOR UPDATE",[userId]);
  const positions=rows.rows;
  if(!positions.length){await c.query("ROLLBACK");return {status:"empty"}}
  const plan=evaluate(Number(wallet.rows[0].futures_balance),positions,quotes,now);
  if(!plan){await c.query("ROLLBACK");return {status:"invalid_quote"}}
  if(!plan.liquidate){await c.query("ROLLBACK");return {status:"healthy",equity:plan.equity}}
  // Never leave pending entry orders that could reopen positions after stop-out.
  await c.query("UPDATE hf_futures_internal_orders SET status='CANCELLED',updated_at=NOW() WHERE user_id=$1 AND status='HELD' AND action='OPEN'",[userId]);
  const deficit=Math.max(0,-plan.equity);
  let balance=plan.balance;
  // Settle gains first so a temporary zero balance cannot hide gains or over-credit equity.
  for(const item of [...plan.settlements].sort((a,b)=>b.netPnlKrw-a.netPnlKrw)){
   const p=item.position,orderId=crypto.randomUUID(),orderSide=p.side==="BUY"?"SELL":"BUY";
   const delta=Math.max(-balance,item.netPnlKrw);
   const uncollectible=Math.max(0,delta-item.netPnlKrw);
   const updatedBalance=balance+delta;
   if(!Number.isSafeInteger(updatedBalance)||updatedBalance<0)throw Error("LIQUIDATION_BALANCE_OVERFLOW");
   const order=await c.query(
    "INSERT INTO hf_futures_internal_orders(id,user_id,request_key,action,symbol,side,qty,order_type,position_id,status,fill_price,fee_krw,realized_pnl_krw,source,quote_at,fx_krw) VALUES($1,$2,$3,'CLOSE',$4,$5,$6,'MARKET',$7,'FILLED',$8,$9,$10,$11,$12,$13) RETURNING id",
    [orderId,userId,crypto.randomUUID(),p.symbol,orderSide,p.qty,p.id,item.exit,item.feeKrw,item.netPnlKrw,item.quote.source,item.quote.asOf,FX_KRW]);
   if(order.rowCount!==1)throw Error("LIQUIDATION_ORDER_FAILED");
   const done=await c.query("UPDATE hf_futures_internal_positions SET state='CLOSED',close_order_id=$1,closed_at=NOW() WHERE id=$2 AND user_id=$3 AND state='OPEN' RETURNING id",[orderId,p.id,userId]);
   if(done.rowCount!==1)throw Error("LIQUIDATION_POSITION_CONFLICT");
   const updated=await c.query("UPDATE hf_wallets SET futures_balance=$1,updated_at=NOW() WHERE user_id=$2 RETURNING futures_balance",[String(updatedBalance),userId]);
   if(updated.rowCount!==1||Number(updated.rows[0].futures_balance)!==updatedBalance)throw Error("LIQUIDATION_WALLET_CONFLICT");
   await c.query("INSERT INTO hf_wallet_ledger(user_id,request_id,futures_order_id,account,delta,balance_after) VALUES($1,NULL,$2,'FUTURES',$3,$4)",
    [userId,orderId,String(delta),String(updatedBalance)]);
   await c.query("INSERT INTO hf_audit(actor_id,action,target,detail) VALUES($1,'FUTURES_AUTO_LIQUIDATION',$2,$3::jsonb)",
    [userId,orderId,JSON.stringify({positionId:p.id,symbol:p.symbol,side:p.side,qty:p.qty,entry:Number(p.entry_price),
      exit:item.exit,quoteAt:item.quote.asOf,source:item.quote.source,contract:item.quote.contract,
      pnlKrw:item.netPnlKrw,chargedKrw:delta,uncollectibleKrw:uncollectible,
      stopOutEquityKrw:plan.equity,stopOutPolicy:"EQUITY_LE_ZERO",fxKrw:FX_KRW})]);
   balance=updatedBalance;
  }
  await c.query("COMMIT");
  logger.warn("FUTURES_STOP_OUT",{userId,positions:positions.length,deficitKrw:deficit});
  return {status:"liquidated",positions:positions.length,equity:plan.equity,balance,deficit};
 }catch(error){
  await c.query("ROLLBACK").catch(()=>{});
  throw error;
 }finally{c.release()}
}
function createWorker({pool,ensure,quoteProvider,logger=console}){
 let running=false;
 async function run(){
  if(running)return {status:"busy"};
  running=true;
  try{
   await ensure();
   const users=await pool.query("SELECT DISTINCT user_id FROM hf_futures_internal_positions WHERE state='OPEN' ORDER BY user_id LIMIT 100");
   if(!users.rowCount)return {status:"empty"};
   const symbols=await pool.query("SELECT DISTINCT symbol FROM hf_futures_internal_positions WHERE state='OPEN' AND user_id=ANY($1::bigint[])",[users.rows.map(u=>u.user_id)]);
   const quotes={};
   // Upstream fetch deliberately serial; existing Massive provider limits are respected.
   for(const row of symbols.rows){
    try{quotes[row.symbol]=validateQuote(await quoteProvider(row.symbol),row.symbol)}
    catch{quotes[row.symbol]=null}
   }
   const outcome={status:"checked",scanned:0,liquidated:0,skipped:0};
   for(const user of users.rows){
    try{
     const result=await settleAccount(pool,user.user_id,quotes,{logger});
     outcome.scanned++;
     if(result.status==="liquidated")outcome.liquidated++;
     if(result.status==="invalid_quote")outcome.skipped++;
    }catch(e){outcome.skipped++;logger.error("FUTURES_STOP_OUT_ERROR",String(e.code||e.message).slice(0,95))}
   }
   return outcome;
  }finally{running=false}
 }
 return {run};
}
module.exports={FX_KRW,ZERO_EQUITY_KRW,validateQuote,evaluate,settleAccount,createWorker};
