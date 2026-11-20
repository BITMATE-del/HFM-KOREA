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
  function recordAggregate({product,contract:nextContract,period,candles,aggregate,now=Date.now()}){
   if(!Array.isArray(candles)||!candles.length||!PERIOD_SECONDS[period]||!aggregate)return {changed:false,candles};
   if(contract!==nextContract){seen.clear();contract=nextContract}
   const time=Number(aggregate.timestamp),open=Number(aggregate.open),high=Number(aggregate.high),
    low=Number(aggregate.low),close=Number(aggregate.close),volume=Number(aggregate.volume);
   if(!Number.isSafeInteger(time)||time<now-20000||time>now+1500||
    ![open,high,low,close,volume].every(Number.isFinite)||open<=0||close<=0||
    high<Math.max(open,close)||low>Math.min(open,close)||volume<0)return {changed:false,candles};
   const keys=seen.get(product)||new Set();
   if(!seen.has(product))seen.set(product,keys);
   const key="sec:"+nextContract+":"+time;
   if(keys.has(key))return {changed:false,candles};
   const t=bucket(time,period),last=candles[candles.length-1];
   if(t===null||t<last.time)return {changed:false,candles};
   // Protect against mismatched vendor price scales or erroneous contract selection.
   if(Number(last.close)>0&&(close/Number(last.close)>1.5||close/Number(last.close)<0.5))return {changed:false,candles};
   keys.add(key);
   if(keys.size>3000)seen.set(product,new Set([...keys].slice(-1200)));
   const result=candles.slice();
   if(t===last.time){
    result[result.length-1]={...last,high:Math.max(last.high,high),low:Math.min(last.low,low),close,
     volume:Math.max(0,Number(last.volume)||0)+(last.livePartial?volume:0),livePartial:true};
   }else{
    result.push({time:t,open,high,low,close,volume,livePartial:true});
   }
   return {changed:true,candles:result.slice(-25000)};
  }
  return {record,recordAggregate};
 }
 return {PERIOD_SECONDS,bucket,validTrade,createRecorder};
});
