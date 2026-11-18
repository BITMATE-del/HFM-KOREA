"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const dir=require("../stock-directory");
test("KRX directory: HFM-style full symbol catalog, Korean search, paging, and validation",async()=>{
 const original=global.fetch;
 const data=Array.from({length:1250},(_,i)=>({"종목코드":String(i+10001).padStart(6,"0"),"종목명":"테스트기업 "+i,mrktCtg:i%2?"KOSPI":"KOSDAQ"}));
 data.push({"종목코드":"005930","종목명":"삼성전자",mrktCtg:"KOSPI"});
 data.push({"종목코드":"000660","종목명":"SK하이닉스",mrktCtg:"KOSPI"});
 data.push({"종목코드":"1234","종목명":"유효하지 않은 코드",mrktCtg:"KOSPI"});
 data.push({"종목코드":"987654","종목명":"상장 외 종목",mrktCtg:"UNKNOWN"});
 let requests=0;
 global.fetch=async url=>{requests++;assert.match(String(url),/aikstockdata\.com\/data\/public\/quotes\.json/);return {ok:true,json:async()=>({items:data})}};
 try{
  const first=await dir.search("",1);
  assert.equal(first.items.length,100);
  assert.equal(first.total,1252);
  assert.equal(first.page,1);
  const last=await dir.search("",13);
  assert.equal(last.items.length,52);
  const result=await dir.search("삼성전자");
  assert.equal(result.total,1);assert.equal(result.items[0].code,"005930");
  assert.equal((await dir.find("000660")).name,"SK하이닉스");
  assert.equal(await dir.find("bad"),null);
  assert.equal(await dir.find("999999"),null);
  assert.equal(requests,1,"one cached HTTP request must serve all reads");
 }finally{global.fetch=original}
});
