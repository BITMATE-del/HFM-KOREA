"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const fs=require("node:fs");
const {Readable}=require("node:stream");
const source=fs.readFileSync(require.resolve("../trading-api"),"utf8");
function build(role="MEMBER"){
 const calls=[];
 const pool={
  connect:async()=>({query:async(sql)=>({rows:[],rowCount:0}),release:()=>{}}),
  query:async(sql)=>{
   calls.push(sql);
   if(sql.includes("FROM hf_orders WHERE user_id"))return {rows:[]};
   if(sql.includes("FROM hf_positions WHERE user_id"))return {rows:[]};
   if(sql.includes("FROM hf_fills WHERE user_id"))return {rows:[]};
   if(sql.includes("FROM hf_wallets WHERE user_id"))return {rows:[{futures_balance:"2500000",stocks_balance:"500000"}]};
   if(sql.includes("FROM hf_member_restrictions"))return {rows:[]};
   if(sql.includes("FROM hf_orders o JOIN hf_users"))return {rows:[]};
   if(sql.includes("FROM hf_positions p JOIN hf_users"))return {rows:[]};
   return {rows:[],rowCount:0};
  }
 };
 const core={pool,auth:async()=>({id:"44",role,username:"tester"}),ensureReady:async()=>{}};
 const funding={ensure:async()=>{}};
 const mod={exports:{}};
 vm.runInNewContext(source,{module:mod,require:x=>x==="./app-api"?core:x==="./funding-api"?funding:x==="./stock-directory"?{find:async(code)=>({code,name:"테스트 종목",market:"KOSPI"})}:x==="./stock-internal-engine"?{state:async()=>({enabled:false,orders:[],positions:[]})}:require(x),console,Buffer,Date,Number,String,Object,BigInt,Math,RegExp,Error,setTimeout},{filename:"trading-api.js"});
 return {route:mod.exports.route,calls};
}
async function request(route,path,method="GET",body){
 let status,bodyText;
 const res={writeHead:(s)=>{status=s},end:s=>{bodyText=s}};
 const chunks=body?[Buffer.from(JSON.stringify(body))]:[];
 const req=Readable.from(chunks);req.method=method;req.headers={};
 const handled=await route(req,res,new URL("http://localhost"+path));
 return {handled,status,data:JSON.parse(bodyText)};
}
test("authenticated member can load futures/stock shared trading state",async()=>{
 const {route,calls}=build();
 const r=await request(route,"/api/trading/state");
 assert.equal(r.status,200);
 assert.equal(r.data.wallet.futuresBalance,"2500000");
 assert.equal(r.data.wallet.stocksBalance,"500000");
 assert.deepEqual(Array.from(r.data.orders),[]);
 assert.ok(calls.some(x=>x.includes("FROM hf_orders WHERE user_id")));
});
test("non-admin cannot access admin trading state",async()=>{
 const {route}=build();
 const r=await request(route,"/api/admin/trading/orders");
 assert.equal(r.status,403);assert.equal(r.data.error,"ADMIN_REQUIRED");
});
test("admin can read protected orders",async()=>{
 const {route}=build("ADMIN");
 const r=await request(route,"/api/admin/trading/orders");
 assert.equal(r.status,200);assert.equal(r.data.executionEnabled,false);
});
test("market order remains blocked without live licensed quote",async()=>{
 const {route}=build();
 const r=await request(route,"/api/trading/orders","POST",{symbol:"NQ",side:"BUY",type:"MARKET",qty:1,requestKey:"00000000-0000-4000-8000-000000000001"});
 assert.equal(r.status,409);assert.equal(r.data.error,"MARKET_DATA_UNAVAILABLE");
});