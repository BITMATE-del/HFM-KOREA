"use strict";
/** TradingView Advanced Chart widget; display only, not a market-data or execution API. */
(function(global){
 const symbolMap=Object.freeze({
  NQ:"CME_MINI:NQ1!",MNQ:"CME_MINI:MNQ1!",
  ES:"CME_MINI:ES1!",MES:"CME_MINI:MES1!",
  GC:"COMEX:GC1!",MGC:"COMEX:MGC1!",
  CL:"NYMEX:CL1!",HSI:"HKEX:HSI1!",
  "005930":"KRX:005930","000660":"KRX:000660",
  "035420":"KRX:035420","005380":"KRX:005380"
 });
 const intervals=Object.freeze({"1분":"1","5분":"5","15분":"15","1시간":"60","일봉":"D"});
 const src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
 function clear(el){while(el.firstChild)el.removeChild(el.firstChild)}
 function mount(el,{symbol,interval="1분",theme="light"}={}){
  if(!el)return;
  const code=symbolMap[symbol]||symbolMap.NQ;
  const tf=intervals[interval]||"1",mode=theme==="dark"?"dark":"light";
  const key=[code,tf,mode].join("|");
  if(el.dataset.tvKey===key)return;
  el.dataset.tvKey=key;
  clear(el);
  const container=document.createElement("div");
  container.className="tradingview-widget-container";
  container.style.cssText="height:100%;width:100%;";
  const widget=document.createElement("div");
  widget.className="tradingview-widget-container__widget";
  widget.style.cssText="height:calc(100% - 22px);width:100%;";
  const credit=document.createElement("div");
  credit.className="tradingview-widget-copyright";
  const a=document.createElement("a");
  a.href="https://www.tradingview.com/symbols/"+encodeURIComponent(code.replace(":","-"))+"/";
  a.target="_blank";a.rel="noopener nofollow";a.textContent=code+" 차트";
  credit.appendChild(a);
  credit.appendChild(document.createTextNode(" by TradingView"));
  container.appendChild(widget);
  container.appendChild(credit);
  el.appendChild(container);
  const embed=document.createElement("script");
  embed.src=src;
  embed.async=true;
  embed.type="text/javascript";
  embed.textContent=JSON.stringify({
   autosize:true,symbol:code,interval:tf,timezone:"Asia/Seoul",theme:mode,
   style:"1",locale:"kr",backgroundColor:mode==="dark"?"#101722":"#ffffff",
   gridColor:mode==="dark"?"rgba(255,255,255,0.08)":"rgba(32,66,110,0.065)",
   allow_symbol_change:false,calendar:false,details:false,
   hide_side_toolbar:false,hide_top_toolbar:false,hide_legend:false,hide_volume:false,
   save_image:true,withdateranges:true,studies:[],compareSymbols:[]
  });
  embed.onerror=()=>{
   if(el.dataset.tvKey!==key)return;
   clear(el);
   const p=document.createElement("p");
   p.className="tv-chart-error";p.textContent="차트를 불러오지 못했습니다. 네트워크 또는 브라우저 설정을 확인해 주세요.";
   const link=document.createElement("a");
   link.target="_blank";link.rel="noopener noreferrer";link.href=a.href;link.textContent="TradingView에서 차트 보기";
   el.append(p,link);
  };
  container.appendChild(embed);
 }
 global.HFMTradingView=Object.freeze({mount,symbolMap,intervals});
})(window);
