"use strict";
/* HFM KOREA: real, paginated KRX directory. Sidebar no longer hardcodes 3 domestic stocks. */
(()=> {
 const side=document.getElementById("futures-watchlist");
 if(!side)return;
 const search=document.getElementById("watch-search");
 const futures=document.getElementById("watch-futures-items");
 const fHead=document.getElementById("watch-futures-heading");
 const stocks=document.getElementById("watch-stocks-items");
 const total=document.getElementById("watch-stock-total");
 const more=document.getElementById("watch-load-more");
 let query="",page=0,all=0,busy=false,last=false,seq=0,timer;
 const escape=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const codeOk=code=>/^\d{6}$/.test(String(code));
 function selectCurrent(){
  const current=window.HFMCurrentWatchSymbol?.();
  side.querySelectorAll("[data-watch]").forEach(button=>button.classList.toggle("selected",button.dataset.watch===current));
 }
 function setStatus(msg){
  if(!msg){const el=stocks.querySelector(".watch-status");if(el)el.remove();return}
  let el=stocks.querySelector(".watch-status");
  if(!el){el=document.createElement("div");el.className="watch-status";stocks.appendChild(el)}
  el.textContent=msg;
 }
 function updateFutureMatches(){
  const key=query.toLocaleLowerCase("ko-KR");
  let found=0;
  futures.querySelectorAll("[data-watch]").forEach(b=>{
   const visible=!key||b.textContent.toLocaleLowerCase("ko-KR").includes(key);
   b.hidden=!visible;b.style.display=visible?"":"none";
   if(visible)found++;
  });
  fHead.hidden=!!key&&!found;fHead.style.display=key&&!found?"none":"";
 }
 function begin(q){
  query=q.trim().slice(0,60);page=0;all=0;last=false;busy=false;seq++;
  stocks.replaceChildren();
  more.hidden=true;more.classList.add("hidden");
  total.textContent="목록 조회 중";
  updateFutureMatches();
  load();
 }
 async function load(){
  if(busy||last)return;
  const epoch=seq,requested=page+1,term=query;
  busy=true;
  more.disabled=true;
  setStatus("주식 종목을 불러오는 중...");
  try{
   const resp=await fetch("/api/stocks/catalog?q="+encodeURIComponent(term)+"&page="+requested,{cache:"no-store"});
   const data=await resp.json();
   if(!resp.ok||!Array.isArray(data.items))throw Error("CATALOG_UNAVAILABLE");
   if(epoch!==seq)return;
   page=requested;
   all=Math.max(0,Number(data.total)||0);
   const rows=data.items.filter(r=>codeOk(r.code)&&typeof r.name==="string");
   setStatus("");
   if(rows.length){
    stocks.insertAdjacentHTML("beforeend",rows.map(r=>'<button class="watch-btn" type="button" data-watch="'+escape(r.code)+'" data-watch-name="'+escape(r.name)+'" data-watch-market="'+escape(r.market)+'"><span>'+escape(r.name)+'</span><small>'+escape(r.code)+'</small></button>').join(""));
   }
   if(!rows.length&&page===1)setStatus("일치하는 국내주식이 없습니다.");
   last=rows.length===0||page*100>=all;
   total.textContent=all.toLocaleString("ko-KR")+"종목";
   more.hidden=last;more.classList.toggle("hidden",last);
   selectCurrent();
  }catch(err){
   if(epoch!==seq)return;
   setStatus("종목 목록을 불러오지 못했습니다. 다시 시도해 주세요.");
   total.textContent="조회 실패";
   more.textContent="다시 조회";
   more.hidden=false;more.classList.remove("hidden");
  }finally{
   if(epoch===seq){busy=false;more.disabled=false}
  }
 }
 function maybeMore(){
  if(!busy&&!last&&side.scrollTop+side.clientHeight>=side.scrollHeight-330)load();
 }
 search.addEventListener("input",()=>{
  clearTimeout(timer);timer=setTimeout(()=>begin(search.value),280);
 });
 side.addEventListener("scroll",maybeMore,{passive:true});
 more.addEventListener("click",load);
 side.addEventListener("click",e=>{
  const item=e.target.closest("[data-watch]");
  if(!item)return;
  const code=item.dataset.watch;
  if(!code)return;
  window.HFMNavigateWatchSymbol?.(code,item.dataset.watchName,item.dataset.watchMarket);
  selectCurrent();
 });
 window.addEventListener("hfm:watch-symbol",selectCurrent);
 begin("");
})();
