"use strict";
const http=require("node:http");
const fs=require("node:fs");
const path=require("node:path");
const root=__dirname;
const mime={".html":"text/html; charset=utf-8",".js":"application/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".txt":"text/plain; charset=utf-8"};

/* Massive Futures Basic — server-only credential verification.
 * Public endpoint exposes no contract prices or licensed market data.
 * Cached for at least 90s to protect the 5-calls/minute Basic quota.
 */
const massiveProbe={at:0,result:null,pending:null};
async function checkMassive(){
 const now=Date.now();
 if(massiveProbe.result && now-massiveProbe.at<90000)return massiveProbe.result;
 if(massiveProbe.pending)return massiveProbe.pending;
 massiveProbe.pending=(async()=>{
  const key=process.env.MASSIVE_API_KEY;
  if(!key)return {connected:false,code:"MISSING_KEY",plan:"basic",recency:"8h",checkedAt:new Date().toISOString()};
  const ctl=new AbortController(),timeout=setTimeout(()=>ctl.abort(),6500);
  try{
   const response=await fetch("https://api.massive.com/futures/v1/contracts?product_code=NQ&limit=1",{
    headers:{"Authorization":"Bearer "+key,"Accept":"application/json"},signal:ctl.signal
   });
   let code="PROVIDER_ERROR";
   if(response.status===401||response.status===403)code="AUTH_OR_ENTITLEMENT";
   else if(response.status===429)code="RATE_LIMIT";
   else if(response.ok){const json=await response.json();code=json.status==="OK"?"OK":"PROVIDER_RESPONSE"}
   return {connected:code==="OK",code,plan:"basic",recency:"8h",checkedAt:new Date().toISOString()};
  }catch(error){return {connected:false,code:error.name==="AbortError"?"TIMEOUT":"NETWORK_ERROR",plan:"basic",recency:"8h",checkedAt:new Date().toISOString()}}
  finally{clearTimeout(timeout)}
 })();
 try{const result=await massiveProbe.pending;massiveProbe.at=Date.now();massiveProbe.result=result;return result}
 finally{massiveProbe.pending=null}
}
function jsonResponse(res,status,data){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Access-Control-Allow-Origin":"same-origin"});res.end(JSON.stringify(data))}
const host="0.0.0.0",port=Number(process.env.PORT||3000);
http.createServer(async (req,res)=>{
 try{
  const url=new URL(req.url,"http://localhost");
  if(url.pathname==="/api/futures/provider-status"){
   if(req.method!=="GET")return jsonResponse(res,405,{ok:false,code:"METHOD_NOT_ALLOWED"});
   const status=await checkMassive();return jsonResponse(res,status.connected?200:503,{ok:status.connected,provider:"massive",...status})
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
}).listen(port,host,()=>console.log("HFM KOREA Futures web listening on "+port));
