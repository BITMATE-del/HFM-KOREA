"use strict";
/** Same listed-company directory as HFM margin's PUBLIC_DIRECTORY fallback.
 * Search is for KOSPI/KOSDAQ symbols. This does not establish current tradability.
 */
let cache=null,inflight=null;
const CODE=/^[0-9]{6}$/;
async function loadDirectory(){
 if(cache&&Date.now()-cache.updated<60*60*1000)return cache.items;
 if(inflight)return inflight;
 inflight=(async()=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),9500);
  try{
   const res=await fetch("https://aikstockdata.com/data/public/quotes.json",{signal:controller.signal,headers:{Accept:"application/json","User-Agent":"HFM-Futures-StockDirectory/1.0"}});
   if(!res.ok)throw Error("STOCK_DIRECTORY_HTTP_"+res.status);
   const payload=await res.json();
   const rows=Array.isArray(payload?.items)?payload.items:[];
   const found=new Map();
   for(const row of rows){
    const code=String(row["종목코드"]||"").padStart(6,"0"),name=String(row["종목명"]||"").trim(),market=String(row.mrktCtg||"");
    if(!CODE.test(code)||!name||name.length>100||!["KOSPI","KOSDAQ"].includes(market))continue;
    found.set(code,{code,name,market});
   }
   if(found.size<1000)throw Error("STOCK_DIRECTORY_INCOMPLETE");
   cache={updated:Date.now(),items:[...found.values()]};return cache.items;
  }finally{clearTimeout(timer)}
 })().catch(e=>{if(cache)return cache.items;throw e}).finally(()=>{inflight=null});
 return inflight;
}
async function search(query="",page=1){
 const all=await loadDirectory();
 const q=String(query).trim().toLocaleLowerCase("ko-KR").slice(0,60);
 const n=Math.max(1,Math.min(100,Number(page)||1));
 const found=q?all.filter(s=>(s.code+" "+s.name).toLocaleLowerCase("ko-KR").includes(q)):all;
 found.sort((a,b)=>{
  if(!q)return a.code.localeCompare(b.code);
  const score=x=>x.code===q||x.name.toLocaleLowerCase("ko-KR")===q?0:x.code.startsWith(q)||x.name.toLocaleLowerCase("ko-KR").startsWith(q)?1:2;
  return score(a)-score(b)||a.name.localeCompare(b.name,"ko-KR");
 });
 return {source:"PUBLIC_DIRECTORY",quoteAvailable:false,total:found.length,page:n,pageSize:100,items:found.slice((n-1)*100,n*100),updatedAt:cache.updated};
}
async function find(code){
 if(!CODE.test(String(code)))return null;
 const all=await loadDirectory();return all.find(v=>v.code===code)||null;
}
module.exports={search,find,loadDirectory,CODE};
