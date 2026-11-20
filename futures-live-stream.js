"use strict";
/*
 * One licensed Massive upstream WebSocket per Railway instance.
 * Clients receive authenticated, read-only SSE data from selected contracts.
 * Does not influence order execution, price validation, balances, or settlement.
 */
const {WebSocket}=require("ws");
const MAX_LISTENERS=150;
const RETRY_MS=5000;
function normalizeSecondAggregate(message,now=Date.now()){
 if(!message||message.ev!=="A"||typeof message.sym!=="string")return null;
 const time=Number(message.s),open=Number(message.o),high=Number(message.h),
  low=Number(message.l),close=Number(message.c),volume=Number(message.v||0);
 if(!Number.isSafeInteger(time)||time<now-20000||time>now+1500)return null;
 if(![open,high,low,close,volume].every(Number.isFinite)||open<=0||close<=0||
 high<Math.max(open,close)||low>Math.min(open,close)||volume<0)return null;
 return {contract:message.sym,timestamp:time,open,high,low,close,volume};
}
function createBridge({apiKey,getContract,enabled=true,logger=console}){
 let socket=null,authorized=false,retry=null,closing=false;
 const clients=new Map(),registered=new Set();
 const emit=(res,type,body)=>{
  if(res.writableEnded||res.destroyed)return;
  try{res.write("event: "+type+"\ndata: "+JSON.stringify(body)+"\n\n")}catch{}
 };
 const notify=(product,type,body)=>{
  const receivers=clients.get(product);if(!receivers)return;
  for(const client of receivers)emit(client.res,type,body);
 };
 const activeTickers=()=>[...new Set([...clients.values()].flatMap(c=>[...c].map(x=>x.contract)))];
 const subscribe=tickers=>{
  if(!authorized||!socket||socket.readyState!==WebSocket.OPEN)return;
  const pending=tickers.filter(x=>!registered.has(x));
  if(!pending.length)return;
  try{socket.send(JSON.stringify({action:"subscribe",params:pending.map(x=>"A."+x).join(",")}));
   for(const x of pending)registered.add(x);
  }catch(error){logger.warn("FUTURES_LIVE_SUBSCRIBE",String(error.message).slice(0,70))}
 };
 const connected=()=>socket&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(socket.readyState);
 const start=()=>{
  if(closing||!enabled||!apiKey||connected()||!activeTickers().length)return;
  authorized=false;registered.clear();
  const ws=new WebSocket("wss://socket.massive.com/futures",{perMessageDeflate:false,handshakeTimeout:8000});
  socket=ws;
  ws.on("open",()=>{if(socket===ws)ws.send(JSON.stringify({action:"auth",params:apiKey}))});
  ws.on("message",raw=>{
   let messages;
   try{const parsed=JSON.parse(String(raw));messages=Array.isArray(parsed)?parsed:[parsed]}catch{return}
   for(const message of messages){
    if(message?.ev==="status"){
     if(message.status==="auth_success"){
      authorized=true;
      subscribe(activeTickers());
      for(const product of clients.keys())notify(product,"status",{status:"connected",source:"MASSIVE_FUTURES_AGG_1SEC"});
     }else if(/auth_failed|unauthorized|not_authorized|error/.test(String(message.status||""))){
      authorized=false;
      for(const product of clients.keys())notify(product,"status",{status:"unavailable",reason:String(message.status||"ENTITLEMENT").slice(0,65)});
     }
     continue;
    }
    const bar=normalizeSecondAggregate(message);
    if(!bar)continue;
    for(const [product,receivers] of clients){
     for(const client of receivers){
      if(client.contract!==bar.contract)continue;
      emit(client.res,"bar",{type:"bar",product,...bar,source:"MASSIVE_FUTURES_AGG_1SEC"});
     }
    }
   }
  });
  ws.on("error",error=>logger.warn("FUTURES_LIVE_SOCKET",String(error.message||"error").slice(0,80)));
  ws.on("close",()=>{
   if(socket!==ws)return;
   socket=null;authorized=false;registered.clear();
   for(const product of clients.keys())notify(product,"status",{status:"disconnected"});
   if(!closing&&activeTickers().length){
    retry=setTimeout(()=>{retry=null;start()},RETRY_MS);
    retry.unref?.();
   }
  });
 };
 async function route(req,res,url,{auth,allowedProducts}){
  if(url.pathname!=="/api/futures/live")return false;
  if(req.method!=="GET"){res.writeHead(405);res.end();return true}
  const member=await auth(req);
  if(!member){res.writeHead(401,{"Content-Type":"application/json"});res.end('{"error":"LOGIN_REQUIRED"}');return true}
  const product=String(url.searchParams.get("product")||"NQ").toUpperCase();
  if(!allowedProducts.has(product)){res.writeHead(400);res.end("INVALID_PRODUCT");return true}
  if(!enabled||!apiKey){res.writeHead(503,{"Content-Type":"application/json"});res.end('{"error":"LICENSED_STREAM_UNAVAILABLE"}');return true}
  let contract;
  try{contract=await getContract(product)}catch{res.writeHead(503);res.end("CONTRACT_UNAVAILABLE");return true}
  if(!/^[A-Z0-9]{2,12}$/.test(contract||"")){res.writeHead(503);res.end("CONTRACT_UNAVAILABLE");return true}
  const active=[...clients.values()].reduce((n,x)=>n+x.size,0);
  if(active>=MAX_LISTENERS){res.writeHead(503);res.end("TOO_MANY_LISTENERS");return true}
  res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no","X-Content-Type-Options":"nosniff"});
  res.flushHeaders?.();
  const client={res,contract};
  const set=clients.get(product)||new Set();set.add(client);clients.set(product,set);
  emit(res,"status",{status:authorized?"connected":"connecting",product,contract});
  subscribe([contract]);start();
  const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(": heartbeat\n\n")},15000);
  heartbeat.unref?.();
  res.on("close",()=>{
   clearInterval(heartbeat);set.delete(client);
   if(!set.size)clients.delete(product);
  });
  return true;
 }
 function shutdown(){
  closing=true;clearTimeout(retry);
  if(socket)socket.close();
  for(const receivers of clients.values())for(const client of receivers)client.res.end();
  clients.clear();
 }
 return {route,shutdown};
}
module.exports={normalizeSecondAggregate,createBridge};
