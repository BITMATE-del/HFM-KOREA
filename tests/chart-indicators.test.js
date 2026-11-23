"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {DEFAULTS,sanitize,bollinger}=require("../chart-indicators.js");
test("default appearance retains existing three averages and volume",()=>{
 assert.deepEqual(DEFAULTS,{ma5:true,ma20:true,ma60:true,volume:true,bollinger:false});
 assert.deepEqual(sanitize(null),DEFAULTS);
 const invalid=sanitize({ma5:"false",ma20:false,unknown:true,volume:false});
 assert.deepEqual(invalid,{ma5:true,ma20:false,ma60:true,volume:false,bollinger:false});
});
test("bollinger is only computed from actual OHLC closes, no placeholder quotes",()=>{
 const real=Array.from({length:24},(_,i)=>({time:i*60,open:100+i,high:101+i,low:99+i,close:100+i}));
 const bands=bollinger(real,20,2);
 assert.equal(bands.length,5);
 assert.equal(bands[0].middle,109.5);
 assert.ok(bands[0].upper>bands[0].middle);
 assert.ok(bands[0].lower<bands[0].middle);
 assert.deepEqual(bollinger(real.slice(0,5),20,2),[]);
});
test("chart settings are view-only and existing order confirmation action timing is preserved",()=>{
 const html=fs.readFileSync(path.join(__dirname,"../index.html"),"utf8");
 const chart=fs.readFileSync(path.join(__dirname,"../hfm-market-chart.js"),"utf8");
 assert.match(html,/data-chart-indicators/);
 assert.match(html,/function configureChartIndicators\(/);
 assert.match(html,/indicators:getChartIndicators\(\)/);
 assert.match(html,/localStorage\.setItem\(HFM_INDICATOR_KEY/);
 assert.match(html,/shut\(\);action\(\)/);
 assert.match(chart,/volume:vol,lines,bands/);
 assert.match(chart,/applyLastBand\(old\.bands,data\)/);
 assert.doesNotMatch(chart,/\/api\/futures\/internal\/order/);
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())assert.doesNotThrow(()=>new vm.Script(match[1]));
});
