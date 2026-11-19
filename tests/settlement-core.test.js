"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const x=require("../settlement-core");
test("NQ long 4 tick gain at 1400 KRW/USD, 2 contracts",()=>assert.equal(x.pnlKrw({symbol:"NQ",side:"BUY",entry:22000,exit:22001,qty:2,krwPerUsd:1400}),56000));
test("MNQ short profit",()=>assert.equal(x.pnlKrw({symbol:"MNQ",side:"SELL",entry:22001,exit:22000,qty:1,krwPerUsd:1400}),2800));
test("NQ short loss with fee",()=>assert.deepEqual(x.settlementPlan({symbol:"NQ",side:"SELL",entry:22000,exit:22001,qty:1,krwPerUsd:1400}),{grossPnlKrw:-28000,feeKrw:1500,netPnlKrw:-29500,releasedMarginKrw:3000000}));
test("ES ticks must match .25",()=>{assert.throws(()=>x.toTicks("ES",5500.13),/INVALID_TICK_PRICE/);assert.equal(x.toTicks("ES",5500.25)-x.toTicks("ES",5500),1)});
test("CL tick size",()=>{assert.equal(x.toTicks("CL",80.01)-x.toTicks("CL",80),1);assert.throws(()=>x.toTicks("CL",80.015),/INVALID_TICK_PRICE/)});
test("margin accounting excludes pending withdrawals",()=>assert.equal(x.availableMargin({balanceKrw:8000000,lockedKrw:3000000,pendingWithdrawalsKrw:2000000}),3000000));
test("negative/unsafe balance rejected",()=>assert.throws(()=>x.availableMargin({balanceKrw:-1,lockedKrw:0}),/INVALID_BALANCE/));
test("licensed fresh quote accepted",()=>{const now=Date.parse("2026-11-18T09:00:00Z");const q=x.checkQuote({symbol:"NQ",price:22000,asOf:new Date(now-1200).toISOString(),receivedAt:new Date(now-500).toISOString(),now,source:"CME_LICENSED",licensed:true});assert.equal(q.price,22000)});
test("stale quote rejected",()=>{const now=Date.parse("2026-11-18T09:00:00Z");assert.throws(()=>x.checkQuote({symbol:"NQ",price:22000,asOf:new Date(now-6000).toISOString(),receivedAt:new Date(now-1000).toISOString(),now,source:"CME_LICENSED",licensed:true}),/QUOTE_STALE/)});
test("unlicensed quote rejected, regardless of freshness",()=>assert.throws(()=>x.checkQuote({symbol:"NQ",price:22000,asOf:new Date().toISOString(),receivedAt:new Date().toISOString(),source:"MASSIVE_BASIC",licensed:false}),/QUOTE_ENTITLEMENT_REQUIRED/));
test("market closed rejected",()=>assert.throws(()=>x.checkQuote({symbol:"NQ",price:22000,asOf:new Date().toISOString(),receivedAt:new Date().toISOString(),source:"CME_LICENSED",licensed:true,sessionOpen:false}),/MARKET_CLOSED/));
test("future timestamp rejected",()=>{const now=Date.parse("2026-11-18T09:00:00Z");assert.throws(()=>x.checkQuote({symbol:"NQ",price:22000,asOf:new Date(now+7000).toISOString(),receivedAt:new Date(now).toISOString(),now,source:"CME_LICENSED",licensed:true}),/QUOTE_FUTURE_TIMESTAMP/)});
test("unsupported symbol and qty rejected",()=>{assert.throws(()=>x.marginFor("HSI",1),/UNSUPPORTED_CONTRACT/);assert.throws(()=>x.marginFor("NQ",0),/INVALID_QTY/)});

test("official CME NQ tick is 0.25 points worth $5 and MNQ is worth $0.50",()=>{
 const nq=x.nasdaqReference("NQ"),mnq=x.nasdaqReference("MNQ");
 assert.equal(nq.tickSize,.25);assert.equal(nq.tickValueUsd,5);
 assert.equal(mnq.tickSize,.25);assert.equal(mnq.tickValueUsd,.5);
 assert.equal(x.specFor("NQ").mult*x.specFor("NQ").tickUnits/x.specFor("NQ").scale,5);
 assert.equal(x.specFor("MNQ").mult*x.specFor("MNQ").tickUnits/x.specFor("MNQ").scale,.5);
 assert.equal(x.pnlKrw({symbol:"NQ",side:"BUY",entry:22000,exit:22000.25,qty:1,krwPerUsd:1400}),7000);
 assert.equal(x.pnlKrw({symbol:"MNQ",side:"BUY",entry:22000,exit:22000.25,qty:1,krwPerUsd:1400}),700);
});
test("CME nonmember exchange fees are separate from platform broker commission",()=>{
 assert.equal(x.nasdaqReference("NQ",1).exchangeFeePerSideUsd,1.38);
 assert.equal(x.nasdaqReference("NQ",1).exchangeFeeRoundTripUsd,2.76);
 assert.equal(x.nasdaqReference("MNQ",1).exchangeFeeRoundTripUsd,.70);
 assert.equal(x.nasdaqReference("MNQ",2).exchangeFeeRoundTripUsd,1.40);
 assert.equal(x.feesFor(1),1500);
});
