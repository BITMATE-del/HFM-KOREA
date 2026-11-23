"use strict";
/* Chart-only display preferences. No price, order or execution changes. */
const DEFAULTS=Object.freeze({ma5:true,ma20:true,ma60:true,volume:true,bollinger:false});
const KEYS=Object.keys(DEFAULTS);
function sanitize(value){
 const out={...DEFAULTS};
 if(value&&typeof value==="object")for(const key of KEYS)if(typeof value[key]==="boolean")out[key]=value[key];
 return out;
}
function stddev(data,mean){return Math.sqrt(data.reduce((sum,x)=>sum+(x-mean)**2,0)/data.length)}
function bollinger(data,period=20,deviation=2){
 if(!Array.isArray(data)||period<2||period>250||!Number.isFinite(deviation)||deviation<=0)return [];
 let sum=0,sum2=0;
 return data.map((bar,i)=>{
  const value=Number(bar.close);
  if(!Number.isFinite(value))return null;
  sum+=value;sum2+=value*value;
  if(i>=period){const previous=Number(data[i-period].close);sum-=previous;sum2-=previous*previous}
  if(i<period-1)return null;
  const mean=sum/period,variance=Math.max(0,sum2/period-mean*mean),sd=Math.sqrt(variance);
  return {time:bar.time,upper:mean+sd*deviation,middle:mean,lower:mean-sd*deviation};
 }).filter(Boolean);
}
if(typeof module==="object"&&module.exports)module.exports={DEFAULTS,KEYS,sanitize,bollinger};
if(typeof window!=="undefined")window.HFMChartIndicators={DEFAULTS,KEYS,sanitize,bollinger};
