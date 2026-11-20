"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const live=require("../futures-live-chart.js");
test("live trade timestamp converts to real candle boundaries",()=>{
 assert.equal(live.bucket(1763600467000,"1min"),1763600460);
 assert.equal(live.bucket(1763600467000,"5min"),1763600400);
 assert.equal(live.bucket(1763600467000,"1session"),null);
});
test("live futures trade samples update only the current chart bar, never invent intervening bars",()=>{
 const t=1763600460000,now=t+12000,rec=live.createRecorder();
 const base=[{time:1763600400,open:200,high:202,low:199,close:201,volume:80}];
 const out=rec.record({product:"NQ",contract:"NQZ6",period:"1min",candles:base,now,
  trades:[{timestamp:t+2000,price:204,size:2,sequence:"5"},{timestamp:t+3000,price:203,size:4,sequence:"6"}]});
 assert.equal(out.changed,true);
 assert.equal(out.candles.length,2);
 assert.deepEqual(out.candles.at(-1),{time:1763600460,open:204,high:204,low:203,close:203,volume:6,livePartial:true});
 const again=rec.record({product:"NQ",contract:"NQZ6",period:"1min",candles:out.candles,now,
  trades:[{timestamp:t+2000,price:204,size:2,sequence:"5"}]});
 assert.equal(again.changed,false);
 assert.equal(again.candles.at(-1).volume,6);
 assert.equal(base.length,1);
});
test("delayed, invalid, out-of-order historical events never fabricate present trades",()=>{
 const now=1763600490000,rec=live.createRecorder();
 const base=[{time:1763600460,open:200,high:201,low:199,close:200.5,volume:10}];
 const out=rec.record({product:"NQ",contract:"NQZ6",period:"1min",candles:base,now,
  trades:[{timestamp:now-60000,price:1,size:1,sequence:"1"},{timestamp:now+300000,price:999,size:1,sequence:"2"},
  {timestamp:now-1500,price:-20,size:1,sequence:"3"}]});
 assert.equal(out.changed,false);
 assert.equal(out.candles,base);
});
test("live chart never changes existing order engine or passes through stale source as live",()=>{
 const server=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
 const html=fs.readFileSync(path.join(__dirname,"../index.html"),"utf8");
 const chart=fs.readFileSync(path.join(__dirname,"../hfm-market-chart.js"),"utf8");
 assert.match(server,/url\.pathname==="\/api\/futures\/chart-trades"/);
 assert.match(server,/MASSIVE_FUTURES_PAID!=="true"/);
 assert.match(server,/\/futures\/v1\/trades\//);
 assert.match(server,/LOGIN_REQUIRED/);
 assert.match(html,/setInterval\(pullFuturesChartTrades,4500\)/);
 assert.match(html,/if\(d\.delayed\|\|d\.ageSeconds===null\|\|d\.ageSeconds>15\)return/);
 assert.match(chart,/data\.at\(-1\)\?\.high,data\.at\(-1\)\?\.low/);
});
