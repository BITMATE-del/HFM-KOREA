"use strict";
const http=require("node:http");
const fs=require("node:fs");
const path=require("node:path");
const root=__dirname;
const mime={".html":"text/html; charset=utf-8",".js":"application/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".txt":"text/plain; charset=utf-8"};

/* Massive Futures Basic diagnostics: no public OHLC/price redistribution.
 * Basic: 5 calls/minute, historical bars delayed by 8 hours.
 * All upstream requests share one rate limiter and one server-side cache.
 */
const VALID_PRODUCTS=new Set(["NQ","MNQ","ES","MES","GC","MGC","CL","MCL"]);
const massiveState={nextAt:0,cache:new Map(),pending:new Map(),lastError:null};
function jsonResponse(res,status,data){
 res.writeHead(status,{"Content-Type":"application/json; charset=utf-8",
  "Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
 res.end(JSON.stringify(data));
}
function publicDiagnostic(code,extra={}){
 return {provider:"massive",plan:"basic",live:false,priceDelay:"8h",code,...extra};
}
function chooseContract(contracts,product){
 const re=new RegExp("^"+product+"[FGHJKMNQUVXZ][0-9]{1,2}$");
 return contracts.filter(x=>x&&typeof x.ticker==="string"&&re.test(x.ticker)
  &&Number.isFinite(Number(x.days_to_maturity))&&Number(x.days_to_maturity)>=0)
  .sort((a,b)=>Number(a.days_to_maturity)-Number(b.days_to_maturity))[0]||null;
}
async function massiveFetch(path,params){
 const key=process.env.MASSIVE_API_KEY;
 if(!key)return {code:"MISSING_KEY",ok:false};
 const now=Date.now(),id=path+"?"+new URLSearchParams(params).toString();
 const cached=massiveState.cache.get(id);
 if(cached && now-cached.at<180000)return cached.value;
 if(massiveState.pending.has(id))return massiveState.pending.get(id);
 if(now<massiveState.nextAt)return {code:"COOLDOWN",ok:false,retryAfter:Math.ceil((massiveState.nextAt-now)/1000)};
 // Globally serialized across all check routes, leaving room under 5/minute.
 massiveState.nextAt=now+16000;
 const request=(async()=>{
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),7000);
  try{
   const url=new URL("https://api.massive.com"+path);
   for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
   url.searchParams.set("apiKey",key);
   const resp=await fetch(url,{headers:{"Accept":"application/json"},signal:ctl.signal});
   if(!resp.ok){
    return {ok:false,code:resp.status===429?"RATE_LIMIT":resp.status===401||resp.status===403?"AUTH_OR_ENTITLEMENT":resp.status===404?"NOT_FOUND":"PROVIDER_ERROR",httpStatus:resp.status};
   }
   const body=await resp.json();
   if(body.status!=="OK"||!Array.isArray(body.results))return {ok:false,code:"INVALID_RESPONSE"};
   const value={ok:true,code:"OK",results:body.results};
   massiveState.cache.set(id,{at:Date.now(),value});
   if(massiveState.cache.size>50){for(const [k,v] of massiveState.cache)if(Date.now()-v.at>180000)massiveState.cache.delete(k)}
   return value;
  }catch(e){return {ok:false,code:e.name==="AbortError"?"TIMEOUT":"NETWORK_ERROR"}}
  finally{clearTimeout(timer)}
 })();
 massiveState.pending.set(id,request);
 try{return await request}finally{massiveState.pending.delete(id)}
}
async function checkContracts(product){
 const date=new Date(Date.now()-8*60*60*1000).toISOString().slice(0,10);
 const result=await massiveFetch("/futures/v1/contracts",{
  product_code:product,date,active:"true",type:"single",limit:"100",sort:"ticker.asc"
 });
 if(!result.ok)return publicDiagnostic(result.code,result.retryAfter?{retryAfter:result.retryAfter}:{});
 const chosen=chooseContract(result.results,product);
 return publicDiagnostic(chosen?"OK":"NO_ACTIVE_CONTRACT",{
  checkedAt:new Date().toISOString(),product,contractsFound:result.results.length,
  ticker:chosen?.ticker||null,daysToMaturity:chosen?.days_to_maturity??null,
  lastTradeDate:chosen?.last_trade_date||null
 });
}
async function checkBars(product){
 const date=new Date(Date.now()-8*60*60*1000).toISOString().slice(0,10);
 const id="/futures/v1/contracts?"+new URLSearchParams({product_code:product,date,active:"true",type:"single",limit:"100",sort:"ticker.asc"}).toString();
 const cached=massiveState.cache.get(id);
 if(!cached||Date.now()-cached.at>=180000)return publicDiagnostic("CHECK_CONTRACTS_FIRST",{product});
 const chosen=chooseContract(cached.value.results,product);
 if(!chosen)return publicDiagnostic("NO_ACTIVE_CONTRACT",{product});
 const bars=await massiveFetch("/futures/v1/aggs/"+encodeURIComponent(chosen.ticker),{
  resolution:"1min",sort:"window_start.desc",limit:"5"
 });
 if(!bars.ok)return publicDiagnostic(bars.code,{product,ticker:chosen.ticker,...(bars.retryAfter?{retryAfter:bars.retryAfter}:{})});
 const valid=bars.results.filter(x=>Number.isFinite(x.open)&&Number.isFinite(x.high)&&Number.isFinite(x.low)&&Number.isFinite(x.close)&&Number.isFinite(Number(x.window_start)));
 // Timestamp from Massive is Unix nanoseconds, convert safely to milliseconds.
 const lastNs=valid.length?String(valid[0].window_start):null;
 const lastMs=lastNs?Number(BigInt(lastNs)/1000000n):null;
 return publicDiagnostic(valid.length?"OK":"NO_BARS",{
  product,ticker:chosen.ticker,validatedBars:valid.length,
  latestBarAt:lastMs?new Date(lastMs).toISOString():null,
  checkedAt:new Date().toISOString()
 });
}
async function checkMassive(){
 const key=process.env.MASSIVE_API_KEY;
 if(!key)return publicDiagnostic("MISSING_KEY",{connected:false});
 const result=await massiveFetch("/futures/v1/contracts",{product_code:"NQ",limit:"1"});
 return publicDiagnostic(result.code,{connected:result.ok,checkedAt:new Date().toISOString(),...(result.retryAfter?{retryAfter:result.retryAfter}:{})});
}
const host="0.0.0.0",port=Number(process.env.PORT||3000);
http.createServer(async (req,res)=>{
 try{
  const url=new URL(req.url,"http://localhost");
  if(url.pathname==="/api/futures/provider-status"){
   if(req.method!=="GET")return jsonResponse(res,405,{ok:false,code:"METHOD_NOT_ALLOWED"});
   const status=await checkMassive();
   return jsonResponse(res,status.connected?200:status.code==="COOLDOWN"?429:503,{ok:status.connected,...status});
  }
  if(url.pathname==="/api/futures/diagnostics"){
   if(req.method!=="GET")return jsonResponse(res,405,{ok:false,code:"METHOD_NOT_ALLOWED"});
   const product=(url.searchParams.get("product")||"NQ").toUpperCase();
   const stage=url.searchParams.get("stage")||"contracts";
   if(!VALID_PRODUCTS.has(product)||!["contracts","bars"].includes(stage))
    return jsonResponse(res,400,publicDiagnostic("INVALID_PARAMETER"));
   const status=stage==="contracts"?await checkContracts(product):await checkBars(product);
   return jsonResponse(res,status.code==="OK"?200:status.code==="COOLDOWN"?429:503,{
    ok:status.code==="OK",stage,...status
   });
  }
  const p=url.pathname==="/health"?"/api/health.js":url.pathname==="/"?"/index.html":url.pathname;
  let filepath=path.resolve(root,"."+decodeURIComponent(p));
  if(!filepath.startsWith(root+path.sep)){res.writeHead(403);return res.end("Forbidden")}
  if(p==="/health"){res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});return res.end(JSON.stringify({ok:true,service:"hfm-futures-web"}))}
  if(!fs.existsSync(filepath)||!fs.statSync(filepath).isFile()){res.writeHead(404);return res.end("Not Found")}
  const ext=path.extname(filepath).toLowerCase();
  if(!mime[ext]){res.writeHead(404);return res.end("Not Found")}
  res.writeHead(200,{"Content-Type":mime[ext],"X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"strict-origin-when-cross-origin","Cache-Control":ext===".html"?"no-cache":"public, max-age=300"});
  fs.createReadStream(filepath).pipe(res)
 }catch(err){res.writeHead(400);res.end("Bad Request")}
}).listen(port,host,()=>{console.log("HFM KOREA Futures web listening on "+port);setTimeout(()=>checkMassive().then(s=>console.log("MASSIVE_CONNECTIVITY",JSON.stringify({code:s.code,connected:s.connected||false,checkedAt:s.checkedAt}))).catch(()=>console.log("MASSIVE_CONNECTIVITY",JSON.stringify({code:"PROBE_FAILED",connected:false}))),1200),setTimeout(()=>checkContracts("NQ").then(r=>console.log("MASSIVE_CONTRACTS_CHECK",JSON.stringify({code:r.code,product:r.product,ticker:r.ticker,contractsFound:r.contractsFound}))).catch(()=>console.log("MASSIVE_CONTRACTS_CHECK",JSON.stringify({code:"CHECK_FAILED"}))),19000),setTimeout(()=>checkBars("NQ").then(r=>console.log("MASSIVE_AGGREGATES_CHECK",JSON.stringify({code:r.code,product:r.product,ticker:r.ticker,validatedBars:r.validatedBars,latestBarAt:r.latestBarAt}))).catch(()=>console.log("MASSIVE_AGGREGATES_CHECK",JSON.stringify({code:"CHECK_FAILED"}))),39000)});
