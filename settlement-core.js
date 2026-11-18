"use strict";
/* Pure integer-tick futures accounting. No orders, DB mutations, network calls, or secret keys.
 * Contract sizing and fees are internal configurable policy values, not CME margin requirements.
 */
const SPECS=Object.freeze({
 NQ:Object.freeze({tickUnits:25,scale:100,mult:20,marginKrw:3000000}),
 MNQ:Object.freeze({tickUnits:25,scale:100,mult:2,marginKrw:420000}),
 ES:Object.freeze({tickUnits:25,scale:100,mult:50,marginKrw:2500000}),
 MES:Object.freeze({tickUnits:25,scale:100,mult:5,marginKrw:330000}),
 GC:Object.freeze({tickUnits:10,scale:100,mult:100,marginKrw:3500000}),
 MGC:Object.freeze({tickUnits:10,scale:100,mult:10,marginKrw:450000}),
 CL:Object.freeze({tickUnits:1,scale:100,mult:1000,marginKrw:2200000})
});
const CODE=/^[A-Z0-9]{2,10}$/;
function assert(condition,code){if(!condition){const err=new Error(code);err.code=code;throw err}}
function checkedInt(n,low,high,code){assert(typeof n==="number"&&Number.isSafeInteger(n)&&n>=low&&n<=high,code);return n}
function specFor(symbol){assert(typeof symbol==="string"&&CODE.test(symbol)&&SPECS[symbol],"UNSUPPORTED_CONTRACT");return SPECS[symbol]}
function toTicks(symbol,price){
 const s=specFor(symbol);assert(typeof price==="number"&&Number.isFinite(price)&&price>0&&price<100000000,"INVALID_PRICE");
 const scaled=Math.round(price*s.scale);
 assert(Math.abs(price*s.scale-scaled)<1e-7&&scaled%s.tickUnits===0,"INVALID_TICK_PRICE");
 return scaled/s.tickUnits;
}
function marginFor(symbol,qty){const s=specFor(symbol);checkedInt(qty,1,100,"INVALID_QTY");return checkedInt(s.marginKrw*qty,0,Number.MAX_SAFE_INTEGER,"MARGIN_OVERFLOW")}
function feesFor(qty,perContractKrw=1500){checkedInt(qty,1,100,"INVALID_QTY");checkedInt(perContractKrw,0,100000,"INVALID_FEE");return qty*perContractKrw}
function pnlKrw({symbol,side,entry,exit,qty,krwPerUsd}){
 const s=specFor(symbol);assert(side==="BUY"||side==="SELL","INVALID_SIDE");checkedInt(qty,1,100,"INVALID_QTY");
 checkedInt(krwPerUsd,1,10000,"INVALID_FX");
 const ticks=toTicks(symbol,exit)-toTicks(symbol,entry);
 const tickValue=s.tickUnits*s.mult/s.scale;
 const gross=ticks*tickValue*qty*krwPerUsd*(side==="BUY"?1:-1);
 assert(Number.isSafeInteger(gross),"PNL_OVERFLOW");return gross;
}
function availableMargin({balanceKrw,lockedKrw,pendingWithdrawalsKrw=0}){
 checkedInt(balanceKrw,0,Number.MAX_SAFE_INTEGER,"INVALID_BALANCE");
 checkedInt(lockedKrw,0,Number.MAX_SAFE_INTEGER,"INVALID_LOCKED_MARGIN");
 checkedInt(pendingWithdrawalsKrw,0,Number.MAX_SAFE_INTEGER,"INVALID_PENDING_WITHDRAWALS");
 return Math.max(0,balanceKrw-lockedKrw-pendingWithdrawalsKrw);
}
function checkQuote({symbol,price,asOf,receivedAt,now=Date.now(),source,licensed=false,sessionOpen=true}){
 specFor(symbol);
 assert(licensed===true,"QUOTE_ENTITLEMENT_REQUIRED");
 assert(sessionOpen===true,"MARKET_CLOSED");
 assert(typeof source==="string"&&/^[A-Z][A-Z_0-9]{2,39}$/.test(source),"QUOTE_SOURCE_INVALID");
 const iso=Date.parse(asOf),received=Date.parse(receivedAt);
 assert(Number.isFinite(iso)&&Number.isFinite(received)&&Number.isFinite(now),"QUOTE_TIMESTAMP_INVALID");
 assert(iso<=received+1000&&received<=now+1000&&iso<=now+1000,"QUOTE_FUTURE_TIMESTAMP");
 assert(now-iso<=5000&&now-received<=5000,"QUOTE_STALE");
 toTicks(symbol,price);
 return {symbol,price,asOf,receivedAt,source};
}
function settlementPlan({symbol,side,entry,exit,qty,krwPerUsd,feeKrw=1500}){
 const gross=pnlKrw({symbol,side,entry,exit,qty,krwPerUsd});
 const fee=feesFor(qty,feeKrw);
 return Object.freeze({grossPnlKrw:gross,feeKrw:fee,netPnlKrw:gross-fee,releasedMarginKrw:marginFor(symbol,qty)});
}
module.exports={SPECS,specFor,toTicks,marginFor,feesFor,pnlKrw,availableMargin,checkQuote,settlementPlan};
