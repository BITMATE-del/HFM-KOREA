"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const html=fs.readFileSync(path.join(__dirname,"../index.html"),"utf8");
const engine=fs.readFileSync(path.join(__dirname,"../futures-internal-engine.js"),"utf8");

test("additional entry action is available only for an existing internal futures lot",()=>{
 assert.match(html,/o\.internalFutures\?\`<button class="btn btn-small" data-add-position=/);
 assert.match(html,/o\.side==='BUY'\?'추가 매수':'추가 매도'/);
 assert.match(html,/\[data-add-position\]/);
 assert.match(html,/function addToFuturesPosition\(id\)/);
});
test("additional entry uses existing secured futures OPEN order, bound to the lot symbol and direction",()=>{
 const start=html.indexOf("function addToFuturesPosition(id){");
 const end=html.indexOf("function closePosition(id){",start);
 assert.ok(start>0&&end>start);
 const src=html.slice(start,end);
 assert.match(src,/latest\.symbol!==p\.symbol\|\|latest\.side!==p\.side/);
 assert.match(src,/action:'OPEN',symbol:p\.symbol,side:p\.side,qty:selectedQty,type:'MARKET'/);
 assert.match(src,/requestKey=crypto\.randomUUID\(\)/);
 assert.match(src,/Number\.isSafeInteger\(amount\)/);
 assert.match(src,/syncTradingState\(\)/);
 assert.doesNotMatch(src,/UPDATE hf_|DELETE FROM|\/api\/stocks\/internal/);
});
test("the existing engine supports another separately recorded entry with margin and fee checks",()=>{
 assert.match(engine,/if\(o\.action==="OPEN"\)/);
 assert.match(engine,/calc\.availableMargin/);
 assert.match(engine,/INSERT INTO hf_futures_internal_positions/);
 assert.match(engine,/UNIQUE\(user_id,request_key\)/);
 assert.match(engine,/WALLET_UPDATE_FAILED/);
});
test("all inline scripts still parse",()=>{
 const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
 for(const s of scripts)if(s[1].trim())assert.doesNotThrow(()=>new vm.Script(s[1]));
});
