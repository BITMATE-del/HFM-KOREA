"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const {normalizeSecondAggregate}=require("../futures-live-stream.js");
const {createRecorder}=require("../futures-live-chart.js");

test("Massive second aggregate is validated against actual exchange timestamp",()=>{
 const now=1763600490000;
 const good=normalizeSecondAggregate({ev:"A",sym:"NQZ6",s:now-1000,o:24001.25,h:24002,l:24000.75,c:24002,v:16},now);
 assert.deepEqual(good,{contract:"NQZ6",timestamp:now-1000,open:24001.25,high:24002,low:24000.75,close:24002,volume:16});
 assert.equal(normalizeSecondAggregate({...{ev:"A",sym:"NQZ6",s:now-600000,o:24001,h:24002,l:24000,c:24001,v:16}},now),null);
 assert.equal(normalizeSecondAggregate({ev:"A",sym:"NQZ6",s:now,o:24001,h:23999,l:24000,c:24001,v:16},now),null);
 assert.equal(normalizeSecondAggregate({ev:"Q",sym:"NQZ6",s:now,p:24001},now),null);
});
test("streaming one-second OHLC forms the currently active minute using actual ticks",()=>{
 const t=1763600460000,now=t+10000,rec=createRecorder();
 const base=[{time:1763600400,open:24000,high:24001,low:23999,close:24000.25,volume:80}];
 let r=rec.recordAggregate({product:"NQ",contract:"NQZ6",period:"1min",candles:base,now,
  aggregate:{timestamp:t+1000,open:24000.5,high:24002,low:24000.5,close:24001.75,volume:12}});
 assert.equal(r.changed,true);
 assert.equal(r.candles.length,2);
 assert.equal(r.candles.at(-1).high,24002);
 r=rec.recordAggregate({product:"NQ",contract:"NQZ6",period:"1min",candles:r.candles,now,
  aggregate:{timestamp:t+2000,open:24001.5,high:24003,low:24001.25,close:24002,volume:8}});
 assert.equal(r.changed,true);
 assert.equal(r.candles.at(-1).high,24003);
 assert.equal(r.candles.at(-1).low,24000.5);
 assert.equal(r.candles.at(-1).close,24002);
 assert.equal(r.candles.at(-1).volume,20);
 const again=rec.recordAggregate({product:"NQ",contract:"NQZ6",period:"1min",candles:r.candles,now,
  aggregate:{timestamp:t+2000,open:24001.5,high:24003,low:24001.25,close:24002,volume:8}});
 assert.equal(again.changed,false);
});
test("client requests same-origin authenticated SSE and uses REST samples as fallback",()=>{
 const server=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
 const page=fs.readFileSync(path.join(__dirname,"../index.html"),"utf8");
 const stream=fs.readFileSync(path.join(__dirname,"../futures-live-stream.js"),"utf8");
 const chart=fs.readFileSync(path.join(__dirname,"../hfm-market-chart.js"),"utf8");
 assert.match(server,/liveChartStream\.route\(req,res,url,\{auth:appApi\.auth/);
 assert.match(stream,/wss:\/\/socket\.massive\.com\/futures/);
 assert.match(stream,/await auth\(req\)/);
 assert.match(stream,/text\/event-stream/);
 assert.match(page,/new EventSource\("\/api\/futures\/live\?product="/);
 assert.match(page,/futuresStreamLastBar<12000/);
 assert.match(chart,/old\.candles\.update/);
 assert.doesNotMatch(stream,/\/api\/futures\/internal\/order|\/api\/stocks\/internal/);
 const scripts=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
 assert.ok(scripts.length);
 for(const script of scripts)new vm.Script(script);
});
