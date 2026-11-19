"use strict";
const symbols=[
 {code:"NQ",name:"나스닥 100"},{code:"MNQ",name:"마이크로 나스닥"},
 {code:"ES",name:"S&P 500"},{code:"MES",name:"마이크로 S&P"},
 {code:"GC",name:"금 선물"},{code:"MGC",name:"마이크로 금"},
 {code:"CL",name:"WTI 원유"},{code:"HSI",name:"항셍지수"}
];
let signedIn=false,activePage="futures",selectedSymbol="NQ",pendingLayout=false;
const $=id=>document.getElementById(id);
function renderSymbols(){
 const q=$("symbolSearch").value.trim().toLocaleLowerCase("ko-KR");
 const list=$("symbols");list.replaceChildren();
 const filtered=symbols.filter(s=>(s.code+" "+s.name).toLocaleLowerCase("ko-KR").includes(q));
 for(const item of filtered){
  const b=document.createElement("button");b.className=selectedSymbol===item.code?"active":"";
  b.type="button";b.innerHTML="<b>"+item.name+"</b><small>"+item.code+"</small>";
  b.addEventListener("click",()=>{
   selectedSymbol=item.code;$("chartTitle").textContent=item.name;
   renderSymbols();window.hts.symbol(item.code);
  });list.append(b);
 }
 if(!filtered.length){const p=document.createElement("p");p.textContent="일치하는 종목이 없습니다.";p.style.cssText="font-size:12px;color:#8192aa;padding:10px";list.append(p)}
}
function bounds(id){
 const r=$(id).getBoundingClientRect();
 return {x:Math.max(0,Math.round(r.x)),y:Math.max(0,Math.round(r.y)),width:Math.max(0,Math.round(r.width)),height:Math.max(0,Math.round(r.height))};
}
function dispatchLayout(){
 pendingLayout=false;
 const layout=signedIn?{chart:bounds("chartSlot"),order:bounds("orderSlot"),positions:bounds("positionsSlot")}:{chart:bounds("loginSurface"),order:null,positions:null};
 window.hts.layout(layout);
}
function scheduleLayout(){if(!pendingLayout){pendingLayout=true;requestAnimationFrame(dispatchLayout)}}
function setSignedIn(value){
 signedIn=!!value;
 $("loginSurface").hidden=signedIn;
 $("dashboard").hidden=!signedIn;
 $("connectState").classList.toggle("ready",signedIn);
 $("connectLabel").textContent=signedIn?"거래 서버 연결됨":"회원 로그인 필요";
 $("statusText").textContent=signedIn?"차트 · 주문 · 포지션 분리형 HTS":"HFM KOREA 거래 서버 연결";
 scheduleLayout();
}
document.querySelectorAll("[data-mode]").forEach(button=>button.addEventListener("click",()=>{
 activePage=button.dataset.mode;
 document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("active",b===button));
 // A stock symbol is selected via the authenticated HFM stock search in the chart pane.
 if(activePage==="stocks")$("chartTitle").textContent="국내주식";
 else $("chartTitle").textContent=symbols.find(s=>s.code===selectedSymbol)?.name||selectedSymbol;
 window.hts.page(activePage);
}));
document.querySelectorAll("[data-popout]").forEach(b=>b.addEventListener("click",()=>window.hts.popout(b.dataset.popout)));
$("refresh").addEventListener("click",()=>window.hts.refresh());
$("preset").addEventListener("click",()=>{document.body.classList.toggle("compact");scheduleLayout();});
$("symbolSearch").addEventListener("input",renderSymbols);
window.addEventListener("resize",scheduleLayout);
new ResizeObserver(scheduleLayout).observe($("surface"));
new ResizeObserver(scheduleLayout).observe($("dashboard"));
window.hts.onAuth(setSignedIn);
window.hts.onStatus(s=>{
 if(s?.message)$("statusText").textContent=s.message;
 if(s?.offline){$("connectState").classList.remove("ready");$("connectLabel").textContent="서버 재연결 필요";}
});
renderSymbols();
scheduleLayout();
