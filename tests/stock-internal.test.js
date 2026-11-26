"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {checkOrder,checkQuote,realizedCost}=require("../stock-internal-engine");
const makeQuote=(at=Date.now())=>({price:10000,asOf:new Date(at).toISOString(),source:"NAVER_UNOFFICIAL",marketStatus:"REGULAR_SESSION",tradeable:true});
test("domestic-stock internal order accepts strict symbol, quantity and idempotency key",()=>{
 const order=checkOrder({symbol:"005930",side:"BUY",qty:10,requestKey:"00000000-0000-4000-8000-000000000001"});
 assert.equal(order.symbol,"005930");assert.equal(order.qty,10);
 assert.throws(()=>checkOrder({symbol:"NQ",side:"BUY",qty:1,requestKey:"00000000-0000-4000-8000-000000000001"}),/INVALID_STOCK_ORDER/);
 assert.throws(()=>checkOrder({symbol:"005930",side:"BUY",qty:0,requestKey:"00000000-0000-4000-8000-000000000001"}),/INVALID_STOCK_ORDER/);
});
test("reference quote needs a recent server timestamp",()=>{
 const now=Date.parse("2026-11-18T05:00:00.000Z");
 assert.equal(checkQuote(makeQuote(now-3000),now).price,10000);
 assert.throws(()=>checkQuote(makeQuote(now-61000),now),/REFERENCE_QUOTE_STALE/);
 assert.throws(()=>checkQuote(makeQuote(now+6000),now),/REFERENCE_QUOTE_STALE/);
});
test("market-closed or ineligible reference quotes must not fill orders",()=>{
 assert.throws(()=>checkQuote({...makeQuote(),marketStatus:"CLOSED"}),/MARKET_CLOSED/);
 assert.throws(()=>checkQuote({...makeQuote(),tradeable:false}),/REFERENCE_QUOTE_UNAVAILABLE/);
 assert.throws(()=>checkQuote({...makeQuote(),asOf:null}),/REFERENCE_QUOTE_UNAVAILABLE/);
});
test("HFM average-cost accounting releases fractional cost conservatively",()=>{
 assert.equal(realizedCost("10","101005","4"),40402n);
 assert.equal(realizedCost("10","101005","10"),101005n);
 assert.throws(()=>realizedCost("6","60000","7"),/INSUFFICIENT_SHARES/);
});

test("authenticated stock API forwards normalized requestKey to buy and sell execution",()=>{
 const source=require("node:fs").readFileSync(require("node:path").join(__dirname,"../stock-internal-engine.js"),"utf8");
 assert.match(source,/transact\(c,user\.id,\{symbol:o\.symbol,side:o\.side,qty:o\.qty,requestKey:o\.id\}/);
 const requestKey="00000000-0000-4000-8000-000000000007";
 for(const side of ["BUY","SELL"]){
  const validated=checkOrder({symbol:"005930",side,qty:2,requestKey});
  assert.deepEqual(checkOrder({symbol:validated.symbol,side:validated.side,qty:validated.qty,requestKey:validated.id}),validated);
 }
});
