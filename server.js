"use strict";
const http=require("node:http");
const fs=require("node:fs");
const path=require("node:path");
const root=__dirname;
const appApi=require("./app-api");
const fundingApi=require("./funding-api");
const tradingApi=require("./trading-api");
const futuresInternal=require("./futures-internal-engine");
const futuresAutoLiquidation=require("./futures-auto-liquidation");
const futuresLiveStream=require("./futures-live-stream");
const memberAdmin=require("./member-admin-api");
const stockDirectory=require("./stock-directory");
const stockEngine=require("./stock-internal-engine");
const sandboxSettlement=require("./sandbox-settlement");
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
 return {provider:"massive",plan:"unverified",code,...extra};
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
 if(cached && now-cached.at<(path.startsWith("/futures/v1/trades/")||path.startsWith("/futures/v1/quotes/")?3500:path.startsWith("/futures/v1/aggs/")?15000:180000))return cached.value;
 if(massiveState.pending.has(id))return massiveState.pending.get(id);
 if(now<massiveState.nextAt)return {code:"COOLDOWN",ok:false,retryAfter:Math.ceil((massiveState.nextAt-now)/1000)};
 // Globally serialized across all check routes, leaving room under 5/minute.
 massiveState.nextAt=now+(process.env.MASSIVE_FUTURES_PAID==="true"?0:16000);
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
async function executionQuote(symbol){
 if(process.env.MASSIVE_FUTURES_PAID!=="true")throw Error("REFERENCE_QUOTE_UNAVAILABLE");
 if(!VALID_PRODUCTS.has(symbol))throw Error("INVALID_ORDER");
 const date=new Date(Date.now()-8*60*60*1000).toISOString().slice(0,10);
 const contracts=await massiveFetch("/futures/v1/contracts",{product_code:symbol,date,active:"true",type:"single",limit:"100",sort:"ticker.asc"});
 if(!contracts.ok)throw Error("CONTRACTS_UNAVAILABLE");
 const contract=chooseContract(contracts.results,symbol);
 if(!contract)throw Error("NO_ACTIVE_CONTRACT");
 const quotes=await massiveFetch("/futures/v1/quotes/"+encodeURIComponent(contract.ticker),{sort:"timestamp.desc",limit:"10"});
 if(!quotes.ok)throw Error("REFERENCE_QUOTE_UNAVAILABLE");
 for(const row of quotes.results){
  const bid=Number(row.bid_price),ask=Number(row.ask_price);
  if(!(bid>0&&ask>0&&bid<=ask))continue;
  try{
   const milliseconds=Number(BigInt(String(row.timestamp))/1000000n);
   if(!Number.isSafeInteger(milliseconds)||milliseconds>Date.now()+1000||Date.now()-milliseconds>15000)continue;
   return {symbol,contract:contract.ticker,bid,ask,asOf:new Date(milliseconds).toISOString(),source:"MASSIVE_FUTURES",licensed:true,marketOpen:true};
  }catch{}
 }
 throw Error("REFERENCE_QUOTE_STALE");
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
  latestClose:valid[0]?.close??null,minutesOld:lastMs?Math.round((Date.now()-lastMs)/60000):null,
  freshness:lastMs?(Date.now()-lastMs<180000?"RECENT":Date.now()-lastMs<900000?"UP_TO_15_MIN_DELAY":Date.now()-lastMs<32400000?"LONG_DELAY":"HISTORICAL"):"UNKNOWN",
  checkedAt:new Date().toISOString()
 });
}
async function checkMassive(){
 const key=process.env.MASSIVE_API_KEY;
 if(!key)return publicDiagnostic("MISSING_KEY",{connected:false});
 const result=await massiveFetch("/futures/v1/contracts",{product_code:"NQ",limit:"1"});
 return publicDiagnostic(result.code,{connected:result.ok,checkedAt:new Date().toISOString(),...(result.retryAfter?{retryAfter:result.retryAfter}:{})});
}

/* Domestic stocks: independent read-only port of HFM margin quote/chart adapters.
   NAVER unofficial quote and sampled 1-minute chart; no account/trade/DB access.
   Responses deliberately carry source and timestamp for freshness checks. */
const stockCache=new Map(), stockPending=new Map();
const STOCK_CODE=/^[0-9]{6}$/;
let stockCatalogCache=null,stockCatalogPending=null;
async function stockCatalog(q){
 if(!stockCatalogCache||Date.now()-stockCatalogCache.at>3600000){
  if(!stockCatalogPending)stockCatalogPending=(async()=>{
   const raw=await stockHttp("https://aikstockdata.com/data/public/quotes.json");
   const rows=Array.isArray(raw?.items)?raw.items:[];
   const symbols=rows.map(row=>({code:String(row["종목코드"]||"").padStart(6,"0"),name:String(row["종목명"]||""),market:String(row.mrktCtg||"")}))
    .filter(x=>STOCK_CODE.test(x.code)&&x.name.length>0&&x.name.length<100&&["KOSPI","KOSDAQ"].includes(x.market));
   if(symbols.length<1000)throw Error("STOCK_CATALOG_INCOMPLETE");
   stockCatalogCache={at:Date.now(),items:symbols};return symbols;
  })().finally(()=>{stockCatalogPending=null});
  await stockCatalogPending;
 }
 const query=String(q||"").trim().toLowerCase().slice(0,60);
 const matching=query?stockCatalogCache.items.filter(x=>(x.code+" "+x.name).toLowerCase().includes(query)):stockCatalogCache.items;
 return {source:"PUBLIC_DIRECTORY",quoteAvailable:false,total:matching.length,items:matching.slice(0,40)};
}

function stockNumber(v){const n=Number(String(v??"").replace(/,/g,""));return Number.isFinite(n)?n:NaN}
async function stockCached(key,age,load){
 const old=stockCache.get(key);if(old&&Date.now()-old.at<age)return old.value;
 if(stockPending.has(key))return stockPending.get(key);
 const job=(async()=>{const value=await load();stockCache.set(key,{at:Date.now(),value});if(stockCache.size>90){const k=stockCache.keys().next().value;stockCache.delete(k)}return value})().finally(()=>stockPending.delete(key));
 stockPending.set(key,job);return job;
}
async function stockHttp(url,accept="application/json"){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7800);
 try{
  const response=await fetch(url,{headers:{"Accept":accept,"User-Agent":"Mozilla/5.0 (compatible; HFMKoreaFutures/1.0)"},signal:controller.signal});
  if(!response.ok)throw Error("STOCK_UPSTREAM_HTTP_"+response.status);
  return accept==="application/json"?response.json():response.text();
 }finally{clearTimeout(timer)}
}
function stockMarketOpen(){
 const d=new Date(Date.now()+9*3600000),day=d.getUTCDay(),minute=d.getUTCHours()*60+d.getUTCMinutes();
 return day>=1&&day<=5&&minute>=540&&minute<930;
}
async function stockQuote(code){
 return stockCached("q:"+code,12000,async()=>{
  let row,price,previousClose,rawTime="";
  try{
   const response=await stockHttp("https://polling.finance.naver.com/api/realtime/domestic/stock/"+code);
   row=response?.datas?.find(x=>x.itemCode===code);
   if(!row)throw Error("QUOTE_NOT_FOUND");
   price=stockNumber(row.closePrice);previousClose=price-stockNumber(row.compareToPreviousClosePrice);
   rawTime=String(row.localTradedAt||"");
  }catch{
   const response=await stockHttp("https://polling.finance.naver.com/api/realtime?query="+encodeURIComponent("SERVICE_ITEM:"+code));
   row=response?.result?.areas?.flatMap(x=>x.datas||[]).find(x=>String(x.cd)===code);
   if(!row)throw Error("QUOTE_NOT_FOUND");
   price=stockNumber(row.nv);previousClose=stockNumber(row.sv);
   if(!(previousClose>0))previousClose=price-stockNumber(row.cv);
   rawTime=String(row.localTradedAt||row.tradedAt||"");
  }
  if(!Number.isSafeInteger(price)||price<=0||!Number.isSafeInteger(previousClose)||previousClose<=0)throw Error("QUOTE_INVALID");
  const ts=Date.parse(rawTime);
  return {symbol:code,price,previousClose,change:price-previousClose,rate:(price-previousClose)/previousClose*100,
   asOf:Number.isFinite(ts)?new Date(ts).toISOString():null,marketStatus:stockMarketOpen()?"REGULAR_SESSION":"CLOSED",
   source:"NAVER_UNOFFICIAL",tradeable:stockMarketOpen()&&Number.isFinite(ts)&&Date.now()-ts>=-5000&&Date.now()-ts<=60000};
 });
}
async function stockCandles(code,period){
 const sizes={minute1:1,minute3:3,minute5:5,minute15:15,minute60:60,day:0,week:0,month:0,year:0};
 if(!Object.prototype.hasOwnProperty.call(sizes,period))throw Error("INVALID_PERIOD");
 const size=sizes[period];
 return stockCached("c:"+code+":"+period,size?45000:300000,async()=>{
  if(!size){
   const timeframe=period==="day"?"day":period==="week"?"week":"month";
   const xml=await stockHttp("https://fchart.stock.naver.com/sise.nhn?symbol="+code+"&timeframe="+timeframe+"&count=1500&requestType=0","application/xml");
   const bars=[];
   for(const m of xml.matchAll(/<item\s+data="([0-9]{8}\|[^"]+)"\s*\/>/g)){
    const a=m[1].split("|");if(a.length<6)continue;
    const [date,open,high,low,close,volume]=[a[0],...a.slice(1,6).map(stockNumber)];
    if(!(open>0&&high>=Math.max(open,close)&&low<=Math.min(open,close)&&volume>=0))continue;
    bars.push({time:date.slice(0,4)+"-"+date.slice(4,6)+"-"+date.slice(6,8),open,high,low,close,volume});
   }
   if(!bars.length)throw Error("STOCK_CHART_EMPTY");
   if(period==="year"){
    const aggregated=new Map();
    for(const bar of bars){
     const year=bar.time.slice(0,4)+"-01-01",prev=aggregated.get(year);
     if(!prev)aggregated.set(year,{time:year,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume});
     else{prev.high=Math.max(prev.high,bar.high);prev.low=Math.min(prev.low,bar.low);prev.close=bar.close;prev.volume+=bar.volume}
    }
    return {symbol:code,period,source:"NAVER_MONTHLY_AGGREGATED",approximateOHLC:false,candles:[...aggregated.values()].slice(-100),asOf:new Date().toISOString()};
   }
   return {symbol:code,period,source:"NAVER_DAILY_UNOFFICIAL",approximateOHLC:false,candles:bars.slice(-1200),asOf:new Date().toISOString()};
  }
  const xml=await stockHttp("https://fchart.stock.naver.com/sise.nhn?symbol="+code+"&timeframe=minute&count=3000&requestType=0","application/xml");
  const bars=[];let lastDay="",priorAccum=0,prevPrice=0;
  for(const m of xml.matchAll(/<item\s+data="([0-9]{12}\|[^"]+)"\s*\/>/g)){
   const a=m[1].split("|"),d=a[0],price=stockNumber(a[4]),acc=stockNumber(a[5]);
   if(!/^\d{12}$/.test(d)||!Number.isSafeInteger(price)||price<=0||!Number.isFinite(acc))continue;
   const day=d.slice(0,8),min=Number(d.slice(8,10))*60+Number(d.slice(10,12));
   const bucket=Math.floor(min/size)*size;
   const time=Math.floor((Date.UTC(Number(day.slice(0,4)),Number(day.slice(4,6))-1,Number(day.slice(6,8)),0,bucket)-32400000)/1000);
   const sameDay=day===lastDay,volume=sameDay?Math.max(0,acc-priorAccum):Math.max(0,acc);
   if(!sameDay)prevPrice=0;
   lastDay=day;priorAccum=acc;
   const open=sameDay&&prevPrice>0?prevPrice:price;prevPrice=price;
   const previous=bars[bars.length-1];
   if(previous&&previous.time===time){previous.high=Math.max(previous.high,price);previous.low=Math.min(previous.low,price);previous.close=price;previous.volume+=volume}
   else bars.push({time,open,high:Math.max(open,price),low:Math.min(open,price),close:price,volume});
  }
  if(!bars.length)throw Error("STOCK_CHART_EMPTY");
  return {symbol:code,period,source:"NAVER_MINUTE_LAST_PRICE",approximateOHLC:true,candles:bars.slice(-1200),asOf:new Date().toISOString()};
 });
}
const liveChartStream=futuresLiveStream.createBridge({
 apiKey:process.env.MASSIVE_API_KEY,
 enabled:process.env.MASSIVE_FUTURES_PAID==="true",
 async getContract(product){
  const date=new Date(Date.now()-8*60*60*1000).toISOString().slice(0,10);
  const response=await massiveFetch("/futures/v1/contracts",{product_code:product,date,active:"true",type:"single",limit:"100",sort:"ticker.asc"});
  if(!response.ok)throw Error(response.code||"CONTRACTS_UNAVAILABLE");
  return chooseContract(response.results,product)?.ticker||"";
 }
});
const host="0.0.0.0",port=Number(process.env.PORT||3000);
http.createServer(async (req,res)=>{
 try{
  const url=new URL(req.url,"http://localhost");
  if(await memberAdmin.route(req,res,url))return;
  if(await stockEngine.route(req,res,url,stockQuote))return;
  if(await futuresInternal.route(req,res,url,executionQuote))return;
  if(await tradingApi.route(req,res,url))return;
  if(await fundingApi.route(req,res,url))return;
  if(await appApi.route(req,res,url))return;
  if(await liveChartStream.route(req,res,url,{auth:appApi.auth,allowedProducts:VALID_PRODUCTS}))return;
  if(url.pathname==="/api/stocks/catalog"){
   if(req.method!=="GET")return jsonResponse(res,405,{error:"METHOD_NOT_ALLOWED"});
   try{return jsonResponse(res,200,await stockDirectory.search(url.searchParams.get("q")||"",url.searchParams.get("page")||1))}
   catch(e){console.warn("STOCK_CATALOG_ERROR",String(e.message).slice(0,55));return jsonResponse(res,503,{error:"STOCK_CATALOG_UNAVAILABLE"})}
  }
  if(url.pathname==="/api/stocks/details"){
   if(req.method!=="GET")return jsonResponse(res,405,{error:"METHOD_NOT_ALLOWED"});
   const code=url.searchParams.get("symbol")||"";
   if(!STOCK_CODE.test(code))return jsonResponse(res,400,{error:"INVALID_SYMBOL"});
   try{
    const listed=await stockDirectory.find(code);
    if(!listed)return jsonResponse(res,404,{error:"STOCK_SYMBOL_NOT_LISTED"});
    const [q,d]=await Promise.allSettled([stockQuote(code),stockCandles(code,"day")]);
    const quote=q.status==="fulfilled"?q.value:null,history=d.status==="fulfilled"?d.value.candles:[];
    if(!quote&&!history.length)return jsonResponse(res,503,{error:"STOCK_DETAIL_UNAVAILABLE"});
    const last=history[history.length-1],high52=history.slice(-252).reduce((m,x)=>Math.max(m,x.high),0),low52=history.slice(-252).reduce((m,x)=>Math.min(m,x.low),Number.MAX_VALUE);
    return jsonResponse(res,200,{symbol:code,name:listed.name,market:listed.market,source:"NAVER_PUBLIC",asOf:quote?.asOf||last?.time||null,
     price:quote?.price??last?.close??null,previousClose:quote?.previousClose??null,
     open:last?.open??null,high:last?.high??null,low:last?.low??null,volume:last?.volume??null,
     high52:history.length?high52:null,low52:history.length?low52:null,
     marketCap:null,per:null,pbr:null,tradingValue:null,listedShares:null,eps:null,bps:null,tradeable:false});
   }catch(e){console.warn("STOCK_DETAILS_ERROR",String(e.message).slice(0,70));return jsonResponse(res,503,{error:"STOCK_DETAIL_UNAVAILABLE"})}
  }
  if(url.pathname==="/api/stocks/quote"||url.pathname==="/api/stocks/intraday"){
   if(req.method!=="GET")return jsonResponse(res,405,{error:"METHOD_NOT_ALLOWED"});
   const symbol=url.searchParams.get("symbol")||"";
   if(!STOCK_CODE.test(symbol))return jsonResponse(res,400,{error:"INVALID_SYMBOL"});
   try{if(!await stockDirectory.find(symbol))return jsonResponse(res,404,{error:"STOCK_SYMBOL_NOT_LISTED"})}
   catch{return jsonResponse(res,503,{error:"STOCK_CATALOG_UNAVAILABLE"})}
   const period=url.searchParams.get("period")||"minute1";
   if(url.pathname.endsWith("/intraday")&&!["minute1","minute3","minute5","minute15","minute60","day","week","month","year"].includes(period))return jsonResponse(res,400,{error:"INVALID_PERIOD"});
   try{
    const output=url.pathname.endsWith("/quote")?await stockQuote(symbol):await stockCandles(symbol,period);
    return jsonResponse(res,200,output);
   }catch(e){
    console.warn("STOCK_FEED_ERROR",{kind:url.pathname.endsWith("/quote")?"quote":"chart",symbol,reason:String(e.message||"UNAVAILABLE").slice(0,55)});
    return jsonResponse(res,503,{error:"STOCK_DATA_UNAVAILABLE",symbol});
   }
  }
  if(url.pathname==="/api/futures/top-of-book"){
   if(req.method!=="GET")return jsonResponse(res,405,{error:"METHOD_NOT_ALLOWED"});
   const member=await appApi.auth(req);
   if(!member)return jsonResponse(res,401,{error:"LOGIN_REQUIRED"});
   const product=(url.searchParams.get("product")||"NQ").toUpperCase();
   if(!VALID_PRODUCTS.has(product))return jsonResponse(res,400,{error:"INVALID_FUTURES_SYMBOL"});
   const contractDate=new Date(Date.now()-8*60*60*1000).toISOString().slice(0,10);
   const contracts=await massiveFetch("/futures/v1/contracts",{product_code:product,date:contractDate,active:"true",type:"single",limit:"100",sort:"ticker.asc"});
   if(!contracts.ok)return jsonResponse(res,503,{error:"CONTRACTS_UNAVAILABLE",reason:contracts.code});
   const chosen=chooseContract(contracts.results,product);
   if(!chosen)return jsonResponse(res,404,{error:"NO_ACTIVE_CONTRACT"});
   const quotes=await massiveFetch("/futures/v1/quotes/"+encodeURIComponent(chosen.ticker),{sort:"timestamp.desc",limit:"10"});
   if(!quotes.ok)return jsonResponse(res,503,{error:"TOP_OF_BOOK_UNAVAILABLE",reason:quotes.code});
   const item=quotes.results.find(q=>Number(q?.bid_price)>0&&Number(q?.ask_price)>0
     &&Number.isSafeInteger(Number(q?.bid_size))&&Number.isSafeInteger(Number(q?.ask_size))
     &&Number(q.bid_size)>=0&&Number(q.ask_size)>=0&&Number(q.bid_price)<=Number(q.ask_price));
   if(!item)return jsonResponse(res,200,{product,contract:chosen.ticker,level:1,available:false,reason:"NO_VALID_TOP_OF_BOOK"});
   let asOf=null,ageSeconds=null;
   try{
    const ms=Number(BigInt(String(item.timestamp))/1000000n);
    if(Number.isSafeInteger(ms)&&ms>0&&ms<=Date.now()+60000){asOf=new Date(ms).toISOString();ageSeconds=Math.max(0,Math.floor((Date.now()-ms)/1000))}
   }catch{}
   const fresh=ageSeconds!==null&&ageSeconds<60;
   return jsonResponse(res,200,{product,contract:chosen.ticker,level:1,available:fresh,
    stale:!fresh,asOf,ageSeconds,
    ...(fresh?{bid:{price:Number(item.bid_price),size:Number(item.bid_size)},
               ask:{price:Number(item.ask_price),size:Number(item.ask_size)}}:{})});
  }
  // Read-only live trade samples for the in-progress chart candle; not used for order execution.
  if(url.pathname==="/api/futures/chart-trades"){
   if(req.method!=="GET")return jsonResponse(res,405,{error:"METHOD_NOT_ALLOWED"});
   const member=await appApi.auth(req);
   if(!member)return jsonResponse(res,401,{error:"LOGIN_REQUIRED"});
   const product=(url.searchParams.get("product")||"NQ").toUpperCase();
   if(!VALID_PRODUCTS.has(product))return jsonResponse(res,400,{error:"INVALID_FUTURES_SYMBOL"});
   if(process.env.MASSIVE_FUTURES_PAID!=="true")return jsonResponse(res,503,{error:"REALTIME_TRADE_FEED_DISABLED"});
   const contractDate=new Date(Date.now()-8*60*60*1000).toISOString().slice(0,10);
   const contracts=await massiveFetch("/futures/v1/contracts",{product_code:product,date:contractDate,active:"true",type:"single",limit:"100",sort:"ticker.asc"});
   if(!contracts.ok)return jsonResponse(res,503,{error:"CONTRACTS_UNAVAILABLE",reason:contracts.code});
   const chosen=chooseContract(contracts.results,product);
   if(!chosen)return jsonResponse(res,404,{error:"NO_ACTIVE_CONTRACT"});
   const output=await massiveFetch("/futures/v1/trades/"+encodeURIComponent(chosen.ticker),{sort:"timestamp.desc",limit:"200"});
   if(!output.ok)return jsonResponse(res,503,{error:"CHART_TRADE_FEED_UNAVAILABLE",reason:output.code});
   const now=Date.now(),trades=[];
   for(const x of output.results){
    const price=Number(x.price),size=Number(x.size||0);
    let timestamp;try{timestamp=Number(BigInt(String(x.timestamp))/1000000n)}catch{continue}
    if(!Number.isSafeInteger(timestamp)||timestamp>now+1000||timestamp<now-10*60*1000||
      !Number.isFinite(price)||price<=0||!Number.isFinite(size)||size<0)continue;
    trades.push({timestamp,price,size,sequence:String(x.sequence_number||x.report_sequence||"").slice(0,40)});
   }
   trades.sort((a,b)=>a.timestamp-b.timestamp||a.sequence.localeCompare(b.sequence));
   const latest=trades.at(-1)?.timestamp||null;
   const ageSeconds=latest===null?null:Math.max(0,Math.floor((now-latest)/1000));
   return jsonResponse(res,200,{product,contract:chosen.ticker,source:"MASSIVE_FUTURES_TRADES",
    delayed:ageSeconds===null||ageSeconds>15,ageSeconds,trades,updatedAt:new Date(now).toISOString()});
  }
  if(url.pathname==="/api/futures/market"){
   if(req.method!=="GET")return jsonResponse(res,405,{error:"METHOD_NOT_ALLOWED"});
   const member=await appApi.auth(req);
   if(!member)return jsonResponse(res,401,{error:"LOGIN_REQUIRED"});
   const product=(url.searchParams.get("product")||"NQ").toUpperCase();
   const period=url.searchParams.get("period")||"1min";
   const intervals=new Set(["1min","5min","15min","1hour","1session"]);
   if(!VALID_PRODUCTS.has(product)||!intervals.has(period))return jsonResponse(res,400,{error:"INVALID_FUTURES_PERIOD_OR_SYMBOL"});
   // Align contract lookup with the successful Massive diagnostic date.
   const beforeRaw=url.searchParams.get("before");
   const before=beforeRaw===null?null:Number(beforeRaw);
   if(beforeRaw!==null&&(!Number.isSafeInteger(before)||before<1491177600||before>Math.floor(Date.now()/1000)))
    return jsonResponse(res,400,{error:"INVALID_HISTORY_CURSOR"});
   const date=new Date(before===null?Date.now()-8*60*60*1000:before*1000).toISOString().slice(0,10);
   const contracts=await massiveFetch("/futures/v1/contracts",{product_code:product,date,active:"true",type:"single",limit:"100",sort:"ticker.asc"});
   if(!contracts.ok)return jsonResponse(res,503,{error:"CONTRACTS_UNAVAILABLE",reason:contracts.code});
   const chosen=chooseContract(contracts.results,product);
   if(!chosen)return jsonResponse(res,404,{error:"NO_ACTIVE_CONTRACT"});
   const aggregateParams={resolution:period,sort:"window_start.desc",limit:period==="1session"?"3000":"5000"};
   if(before!==null)aggregateParams["window_start.lt"]=String(BigInt(before)*1000000000n);
   const bars=await massiveFetch("/futures/v1/aggs/"+encodeURIComponent(chosen.ticker),aggregateParams);
   if(!bars.ok)return jsonResponse(res,503,{error:"FUTURES_BARS_UNAVAILABLE",reason:bars.code});
   const items=bars.results.map(x=>{
    let time;try{time=Number(BigInt(String(x.window_start))/1000000000n)}catch{return null}
    const open=Number(x.open),high=Number(x.high),low=Number(x.low),close=Number(x.close),volume=Number(x.volume||0);
    if(!Number.isSafeInteger(time)||time<1000000000||![open,high,low,close,volume].every(Number.isFinite)||
       open<=0||close<=0||high<Math.max(open,close)||low>Math.min(open,close)||volume<0)return null;
    return {time,open,high,low,close,volume};
   }).filter(Boolean).sort((a,b)=>a.time-b.time).filter((x,i,all)=>!i||x.time!==all[i-1].time);
   if(!items.length)return jsonResponse(res,503,{error:"FUTURES_BARS_EMPTY"});
   const latest=items[items.length-1],oldMs=Date.now()-latest.time*1000;
   return jsonResponse(res,200,{product,contract:chosen.ticker,period,source:"MASSIVE_FUTURES",
    quote:{price:latest.close,asOf:new Date(latest.time*1000).toISOString(),ageSeconds:Math.max(0,Math.floor(oldMs/1000)),
     fresh:oldMs<180000,previousClose:items.length>1?items[items.length-2].close:null},
    candles:items,updatedAt:new Date().toISOString()});
  }
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
  if(url.pathname==="/vendor/lightweight-charts.js"){const vendor=path.join(root,"node_modules","lightweight-charts","dist","lightweight-charts.standalone.production.js");if(!fs.existsSync(vendor))return jsonResponse(res,503,{error:"CHART_LIBRARY_UNAVAILABLE"});res.writeHead(200,{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"public, max-age=86400","X-Content-Type-Options":"nosniff"});return fs.createReadStream(vendor).pipe(res)}
  const p=url.pathname==="/health"?"/health":url.pathname==="/"?"/index.html":url.pathname;
  let filepath=path.resolve(root,"."+decodeURIComponent(p));
  if(!filepath.startsWith(root+path.sep)){res.writeHead(403);return res.end("Forbidden")}
  if(p==="/health"){res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});return res.end(JSON.stringify({ok:true,service:"hfm-futures-web"}))}
  if(!fs.existsSync(filepath)||!fs.statSync(filepath).isFile()){res.writeHead(404);return res.end("Not Found")}
  const ext=path.extname(filepath).toLowerCase();
  if(!mime[ext]){res.writeHead(404);return res.end("Not Found")}
  res.writeHead(200,{"Content-Type":mime[ext],"X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"strict-origin-when-cross-origin","Cache-Control":ext===".html"?"no-cache":"public, max-age=300"});
  fs.createReadStream(filepath).pipe(res)
 }catch(err){res.writeHead(400);res.end("Bad Request")}
}).listen(port,host,()=>{console.log("HFM KOREA Futures web listening on "+port);
const stopOutWorker=futuresAutoLiquidation.createWorker({
 pool:appApi.pool,ensure:futuresInternal.ensure,quoteProvider:executionQuote
});
let stopOutBusy=false;
setInterval(async()=>{
 if(stopOutBusy||process.env.MASSIVE_FUTURES_PAID!=="true")return;
 stopOutBusy=true;
 try{
  const state=await stopOutWorker.run();
  if(state.liquidated)console.warn("FUTURES_STOP_OUT_COMPLETED",JSON.stringify(state));
 }catch(error){console.warn("FUTURES_STOP_OUT_WORKER",String(error.code||error.message).slice(0,95))}
 finally{stopOutBusy=false}
},12000).unref();
let pendingMatcherBusy=false;
setInterval(async()=>{
 if(pendingMatcherBusy||process.env.MASSIVE_FUTURES_PAID!=="true")return;
 pendingMatcherBusy=true;
 try{await futuresInternal.matchPending(executionQuote)}catch(e){console.warn("FUTURES_MATCH_WORKER",String(e.message).slice(0,80))}
 finally{pendingMatcherBusy=false}
},12000).unref();
appApi.ensureReady().then(async()=>{console.log("HFM_DATABASE_READY");await fundingApi.ensure();console.log("HFM_WALLET_DB_READY");await memberAdmin.ensure();console.log("HFM_MEMBER_ADMIN_DB_READY");await tradingApi.ensure();console.log("HFM_TRADING_DB_READY");await stockEngine.ensure();console.log("HFM_STOCK_ENGINE_DB_READY");await futuresInternal.ensure();console.log("HFM_FUTURES_INTERNAL_DB_READY");const futuresSmoke=await futuresInternal.rollbackSmoke();console.log("HFM_FUTURES_INTERNAL_SMOKE",JSON.stringify(futuresSmoke));const stockSmoke=await stockEngine.rollbackSmoke();console.log("HFM_STOCK_ENGINE_SMOKE",JSON.stringify(stockSmoke));await sandboxSettlement.initSchema(appApi.pool);console.log("HFM_SANDBOX_DB_READY");const settlementResult=await sandboxSettlement.rollbackSmoke(appApi.pool);console.log("HFM_SANDBOX_SETTLEMENT_SMOKE",JSON.stringify(settlementResult));try{const base="http://127.0.0.1:"+port;const endpoints=["/health","/api/auth/me","/api/notices"];const checks=[];for(const path of endpoints){const r=await fetch(base+path,{signal:AbortSignal.timeout(5500)});const j=await r.json();checks.push({path,status:r.status,valid:path==="/api/auth/me"?j.authenticated===false:path==="/api/notices"?Array.isArray(j.items):j.ok===true})}for(const path of ["/api/wallet/status","/api/admin/members"]){const r=await fetch(base+path,{signal:AbortSignal.timeout(5500)});const j=await r.json();checks.push({path,status:r.status,valid:r.status===401&&j.error==="LOGIN_REQUIRED"})}
for(const path of ["/api/trading/state","/api/admin/trading/orders","/api/admin/trading/positions"]){const resp=await fetch(base+path,{signal:AbortSignal.timeout(5000)});const j=await resp.json();checks.push({path,status:resp.status,valid:resp.status===401&&j.error==="LOGIN_REQUIRED"})}
for(const endpoint of ["/api/admin/member-tools/1","/api/admin/member-tools/1/adjustments"]){const r=await fetch(base+endpoint,{signal:AbortSignal.timeout(5000)});const j=await r.json();checks.push({path:endpoint,status:r.status,valid:r.status===403&&j.error==="ADMIN_REQUIRED"})}
const blockedMutation=await fetch(base+"/api/admin/member-tools/1/restrictions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:true,futures:true,stocks:true,funding:true}),signal:AbortSignal.timeout(5000)});checks.push({path:"POST /api/admin/member-tools/1/restrictions (unauthenticated)",status:blockedMutation.status,valid:blockedMutation.status===403});
const invalid=await fetch(base+"/api/auth/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:"x",password:"weak"}),signal:AbortSignal.timeout(5500)});checks.push({path:"POST /api/auth/register (invalid)",status:invalid.status,valid:invalid.status===400});
console.log("HFM_API_SMOKE",JSON.stringify(checks))}catch(e){console.error("HFM_API_SMOKE_FAILED",String(e.message).slice(0,80))}}).catch(e=>console.error("HFM_DATABASE_ERROR",String(e.message).slice(0,80)));setTimeout(()=>checkMassive().then(s=>console.log("MASSIVE_CONNECTIVITY",JSON.stringify({code:s.code,connected:s.connected||false,checkedAt:s.checkedAt}))).catch(()=>console.log("MASSIVE_CONNECTIVITY",JSON.stringify({code:"PROBE_FAILED",connected:false}))),1200),setTimeout(()=>checkContracts("NQ").then(r=>console.log("MASSIVE_CONTRACTS_CHECK",JSON.stringify({code:r.code,product:r.product,ticker:r.ticker,contractsFound:r.contractsFound}))).catch(()=>console.log("MASSIVE_CONTRACTS_CHECK",JSON.stringify({code:"CHECK_FAILED"}))),19000),setTimeout(()=>checkBars("NQ").then(r=>console.log("MASSIVE_AGGREGATES_CHECK",JSON.stringify({code:r.code,product:r.product,ticker:r.ticker,validatedBars:r.validatedBars,latestBarAt:r.latestBarAt,latestClose:r.latestClose,minutesOld:r.minutesOld,freshness:r.freshness}))).catch(()=>console.log("MASSIVE_AGGREGATES_CHECK",JSON.stringify({code:"CHECK_FAILED"}))),39000),setTimeout(()=>stockDirectory.search("삼성전자").then(d=>console.log("HFM_STOCK_DIRECTORY_CHECK",JSON.stringify({ok:d.items.some(x=>x.code==="005930"),total:d.total,page:d.page,matched:d.items.slice(0,3)}))).catch(e=>console.log("HFM_STOCK_DIRECTORY_CHECK",JSON.stringify({ok:false,reason:String(e.message).slice(0,70)}))),6500),setTimeout(()=>stockQuote("005930").then(q=>console.log("HFM_STOCK_QUOTE_CHECK",JSON.stringify({code:"OK",symbol:q.symbol,price:q.price,source:q.source,asOf:q.asOf}))).catch(e=>console.log("HFM_STOCK_QUOTE_CHECK",JSON.stringify({code:"ERROR",reason:String(e.message).slice(0,55)}))),5500),setTimeout(()=>stockEngine.rollbackLiveQuoteSmoke(stockQuote).then(x=>console.log("HFM_STOCK_LIVE_EXECUTION_SMOKE",JSON.stringify(x))).catch(e=>console.warn("HFM_STOCK_LIVE_EXECUTION_SMOKE",JSON.stringify({ok:false,code:e.code||String(e.message).slice(0,60)}))),10500),setTimeout(()=>stockCandles("005930","minute1").then(b=>console.log("HFM_STOCK_CANDLE_CHECK",JSON.stringify({code:"OK",bars:b.candles.length,source:b.source}))).catch(e=>console.log("HFM_STOCK_CANDLE_CHECK",JSON.stringify({code:"ERROR",reason:String(e.message).slice(0,55)}))),8500)});
