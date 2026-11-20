"use strict";
/* Chart-only, provider-authenticated futures trades -> partial live OHLC.
 * These values never enter order execution, balance or margin calculations.
 * The REST sampling endpoint is not a lossless trade stream.
 */
(function(root,factory){
 const api=factory();
 if(typeof module==="object"&&module.exports)module.exports=api;
 if(root)root.HFMFuturesChartLive=api;
})(typeof window!=="undefined"?window:null,function(){
 const PERIOD_SECONDS=Object.freeze({"1min":60,"5min":300,"15min":900,"1hour":3600});
 function bucket(timestamp,period){
  const size=PERIOD_SECONDS[period];
  return size?Math.floor(timestamp/1000/size)*size:null;
 }
 function validTrade(t,now){
  const price=Number(t?.price),stamp=Number(t?.timestamp),size=Number(t?.size||0);
  return Number.isFinite(price)&&price>0&&Number.isSafeInteger(stamp)&&
   stamp<=now+1000&&stamp>=now-45000&&Number.isFinite(size)&&size>=0;
 }
 function createRecorder(){
  const seen=new Map();
  let contract="";
  function record({product,contract:nextContract,period,candles,trades,now=Date.now()}){
   if(!Array.isArray(candles)||!candles.length||!Array.isArray(trades)||!PERIOD_SECONDS[period])
    return {changed:false,candles};
   if(contract!==nextContract){seen.clear();contract=nextContract}
   const keys=seen.get(product)||new Set();
   if(!seen.has(product))seen.set(product,keys);
   const result=candles.slice();
   let changed=false;
   const sorted=trades.slice().sort((a,b)=>Number(a.timestamp)-Number(b.timestamp));
   for(const trade of sorted){
    if(!validTrade(trade,now))continue;
    const key=trade.timestamp+":"+String(trade.sequence||"")+":"+trade.price;
    if(keys.has(key))continue;
    keys.add(key);
    const t=bucket(trade.timestamp,period),last=result[result.length-1];
    if(t===null||t<last.time)continue;
    const price=Number(trade.price);
    if(t===last.time){
     result[result.length-1]={...last,high:Math.max(last.high,price),low:Math.min(last.low,price),close:price,
      volume:Math.max(0,Number(last.volume)||0)+(last.livePartial?Number(trade.size)||0:0),livePartial:true};
    }else{
     result.push({time:t,open:price,high:price,low:price,close:price,volume:Number(trade.size)||0,livePartial:true});
    }
    changed=true;
   }
   if(keys.size>3000){seen.set(product,new Set([...keys].slice(-1200)))}
   return {changed,candles:changed?result.slice(-25000):candles};
  }
  return {record};
 }
 return {PERIOD_SECONDS,bucket,validTrade,createRecorder};
});
