"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {evaluate,validateQuote,settleAccount,createWorker}=require("../futures-auto-liquidation");
const now=Date.now();
function quote(symbol,bid,ask,time=now){return{symbol,contract:symbol+"Z6",source:"MASSIVE_FUTURES",licensed:true,marketOpen:true,asOf:new Date(time).toISOString(),bid,ask}}
function position(id,symbol,side,entry,qty=1){return{id,symbol,side,entry_price:entry,qty}}
test("trigger only when total futures equity including closing fees <= zero",()=>{
 const pos=[position("p1","NQ","BUY",22000)];
 const healthy=evaluate(100000,pos,{NQ:quote("NQ",21999,21999.25)},now);
 assert.equal(healthy.liquidate,false);
 assert.equal(healthy.equity,70500);
 const stop=evaluate(28000,pos,{NQ:quote("NQ",21999,21999.25)},now);
 assert.equal(stop.equity,-1500);
 assert.equal(stop.liquidate,true);
});
test("all positions are evaluated as one account, profitable positions offset losses",()=>{
 const positions=[position("a","NQ","BUY",22000),position("b","MNQ","BUY",22000)];
 const quotes={NQ:quote("NQ",21998,21998.25),MNQ:quote("MNQ",21999,21999.25)};
 const plan=evaluate(60000,positions,quotes,now);
 assert.equal(plan.equity,60000-57500+(-2800-1500));
 assert.equal(plan.liquidate,true);
 assert.equal(plan.settlements.length,2);
});
test("unlicensed, delayed and invalid top-of-book cannot force-close",()=>{
 const pos=[position("p","NQ","BUY",22000)];
 for(const q of [quote("NQ",21990,21990.25,now-16000),{...quote("NQ",21990,21990.25),licensed:false},
   {...quote("NQ",21990,21990.25),bid:21991,ask:21990},null]){
  assert.equal(validateQuote(q,"NQ",now),null);
  assert.equal(evaluate(10000,pos,{NQ:q},now),null);
 }
});
test("stop-out closes all open positions, cancels held entries, and audit records uncollectible deficit",async()=>{
 const queries=[],wallet={balance:20000};
 const positions=[position("p1","NQ","BUY",22000),position("p2","MNQ","BUY",22000)];
 const client={
  async query(sql,args=[]){
   queries.push({sql,args});
   if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK")return{rowCount:0,rows:[]};
   if(sql.startsWith("SELECT futures_balance FROM hf_wallets"))return{rowCount:1,rows:[{futures_balance:wallet.balance}]};
   if(sql.startsWith("SELECT * FROM hf_futures_internal_positions"))return{rowCount:positions.length,rows:positions};
   if(sql.startsWith("INSERT INTO hf_futures_internal_orders"))return{rowCount:1,rows:[{id:args[0]}]};
   if(sql.startsWith("UPDATE hf_futures_internal_positions"))return{rowCount:1,rows:[{id:args[1]}]};
   if(sql.startsWith("UPDATE hf_wallets SET futures_balance=")){wallet.balance=Number(args[0]);return{rowCount:1,rows:[{futures_balance:wallet.balance}]}};
   return{rowCount:1,rows:[]};
  },
  release(){}
 };
 const pool={connect:async()=>client};
 const result=await settleAccount(pool,5,{NQ:quote("NQ",21998,21998.25),MNQ:quote("MNQ",21998,21998.25)},{now,logger:{warn(){}}});
 assert.equal(result.status,"liquidated");
 assert.equal(result.positions,2);
 assert.equal(wallet.balance,0);
 assert.equal(queries.filter(x=>x.sql.startsWith("INSERT INTO hf_futures_internal_orders")).length,2);
 assert.equal(queries.filter(x=>x.sql.startsWith("INSERT INTO hf_wallet_ledger")).length,2);
 const aud=queries.filter(x=>x.sql.startsWith("INSERT INTO hf_audit"));
 assert.equal(aud.length,2);
 assert.ok(aud.some(x=>JSON.parse(x.args[2]).uncollectibleKrw>0));
 assert.ok(queries.some(x=>x.sql.includes("status='CANCELLED'")));
 assert.equal(queries.at(-1).sql,"COMMIT");
});
test("healthy account is never mutated or closed",async()=>{
 const queries=[],pool={async connect(){return{async query(sql){queries.push(sql);if(sql.startsWith("SELECT futures_balance"))return{rowCount:1,rows:[{futures_balance:1000000}]};if(sql.startsWith("SELECT * FROM hf_futures_internal_positions"))return{rowCount:1,rows:[position("a","NQ","BUY",22000)]};return{rowCount:0,rows:[]}},release(){}}}};
 const result=await settleAccount(pool,5,{NQ:quote("NQ",22000,22000.25)},{now});
 assert.equal(result.status,"healthy");
 assert.equal(queries.at(-1),"ROLLBACK");
 assert.ok(!queries.some(x=>x.startsWith("UPDATE")||x.startsWith("INSERT")));
});
test("server executes stop-out only with licensed live quotes; no new external order routes",()=>{
 const src=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
 assert.match(src,/futuresAutoLiquidation\.createWorker/);
 assert.match(src,/stopOutWorker\.run\(\)/);
 assert.match(src,/MASSIVE_FUTURES_PAID!=="true"/);
 const engine=fs.readFileSync(path.join(__dirname,"../futures-auto-liquidation.js"),"utf8");
 assert.match(engine,/FOR UPDATE/);
 assert.match(engine,/FUTURES_AUTO_LIQUIDATION/);
 assert.doesNotMatch(engine,/\/api\/futures\/internal\/order|\/api\/stocks\/internal/);
});

test("stop-out worker scans beyond the first 100 accounts without starving later users",async()=>{
 const seen=[];
 const pool={
  async query(sql,args=[]){
   if(sql.startsWith("SELECT DISTINCT user_id")){const rows=Array.from({length:101},(_,i)=>({user_id:String(i+1)})).filter(x=>BigInt(x.user_id)>BigInt(args[0])).slice(0,100);return {rowCount:rows.length,rows}}
   if(sql.startsWith("SELECT DISTINCT symbol"))return{rowCount:0,rows:[]};
   throw Error("UNEXPECTED_SQL");
  },
  async connect(){return{async query(sql,args=[]){
   if(sql==="BEGIN"||sql==="ROLLBACK")return{rowCount:0,rows:[]};
   if(sql.startsWith("SELECT futures_balance FROM hf_wallets")){seen.push(Number(args[0]));return{rowCount:0,rows:[]}}
   throw Error("UNEXPECTED_SQL");
  },release(){}}}
 };
 const worker=createWorker({pool,ensure:async()=>{},quoteProvider:async()=>null,logger:{warn(){},error(){}}});
 const first=await worker.run(),second=await worker.run();
 assert.equal(first.scanned,100);
 assert.equal(second.scanned,1);
 assert.equal(new Set(seen).size,101);
 assert.ok(seen.includes(101));
});
