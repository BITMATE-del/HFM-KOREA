"use strict";
const symbols=[
 {code:"NQ",name:"나스닥 100"},{code:"MNQ",name:"마이크로 나스닥"},
 {code:"ES",name:"S&P 500"},{code:"MES",name:"마이크로 S&P"},
 {code:"GC",name:"금 선물"},{code:"MGC",name:"마이크로 금"},
 {code:"CL",name:"WTI 원유"},{code:"HSI",name:"항셍지수"}
];
let signedIn=false,activePage="futures",selectedSymbol="NQ",pendingLayout=false;
let stockMatches=[],stockRequest=0,stockTimer=null;
const $=id=>document.getElementById(id);
function renderSymbols(){
 const q=$("symbolSearch").value.trim().toLocaleLowerCase("ko-KR");
 const list=$("symbols");list.replaceChildren();
 const entries=activePage==="futures"
  ?symbols.filter(s=>(s.code+" "+s.name).toLocaleLowerCase("ko-KR").includes(q))
  :stockMatches.filter(s=>(s.code+" "+s.name+" "+s.market).toLocaleLowerCase("ko-KR").includes(q));
 for(const item of entries){
  const b=document.createElement("button");b.className=selectedSymbol===item.code?"active":"";
  b.type="button";
  const name=document.createElement("b");name.textContent=item.name;
  const code=document.createElement("small");code.textContent=item.code;
  b.append(name,code);
  b.addEventListener("click",()=>{
   selectedSymbol=item.code;$("chartTitle").textContent=item.name;
   renderSymbols();window.hts.symbol(item.code,item.name,item.market||"");
  });list.append(b);
 }
 if(!entries.length){
  const p=document.createElement("p");
  p.textContent=activePage==="stocks"&&!q?"국내주식 종목명 또는 종목코드를 검색하세요.":activePage==="stocks"?"검색 결과가 없습니다.":"일치하는 종목이 없습니다.";
  p.style.cssText="font-size:12px;color:#8192aa;padding:10px;line-height:1.7";
  list.append(p);
 }
}
async function fetchStockMatches(){
 if(activePage!=="stocks"||!signedIn)return;
 const q=$("symbolSearch").value.trim();
 const seq=++stockRequest;
 if(!q){stockMatches=[];renderSymbols();return}
 $("symbols").textContent="종목을 검색하고 있습니다...";
 try{
  const found=await window.hts.searchStocks(q);
  if(seq===stockRequest&&activePage==="stocks"){stockMatches=Array.isArray(found)?found:[];renderSymbols()}
 }catch{
  if(seq===stockRequest){stockMatches=[];renderSymbols()}
 }
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
 $("symbolSearch").value="";
 if(activePage==="stocks"){selectedSymbol="";stockMatches=[];renderSymbols()}
 else {selectedSymbol="NQ";renderSymbols();setTimeout(()=>window.hts.symbol("NQ","나스닥 100","CME"),500)}
}));
document.querySelectorAll("[data-popout]").forEach(b=>b.addEventListener("click",()=>window.hts.popout(b.dataset.popout)));
for(const [id,kind] of [["newChart","chart"],["newOrder","order"],["newPositions","positions"]])document.getElementById(id)?.addEventListener("click",()=>window.hts.popout(kind));
const updatePanel=$("updatePanel"),updateButton=$("updateButton");
const updateMessage=$("updateMessage"),updateProgress=$("updateProgress");
const updateInstall=$("updateInstall"),updateLater=$("updateLater");
let updateReady=false;
function showUpdatePanel(value){
 updatePanel.hidden=!value;updateButton.setAttribute("aria-expanded",String(!!value));
}
updateButton.addEventListener("click",()=>window.hts.updateCheck());
$("updateCheck").addEventListener("click",()=>window.hts.updateCheck());
updateLater.addEventListener("click",()=>showUpdatePanel(false));
updateInstall.addEventListener("click",()=>{if(updateReady)window.hts.updateInstall()});
window.hts.onUpdate?.(state=>{
 if(!state||typeof state!=="object")return;
 if(/^\\d+\\.\\d+\\.\\d+/.test(String(state.version||"")))
  $("versionLabel").textContent="v"+state.version;
 const current=state.version?("현재 v"+state.version):"";
 const latest=state.latest?(" · 최신 v"+state.latest):"";
 const captions={checking:"업데이트를 확인하고 있습니다.",available:"새 버전을 다운로드하고 있습니다.",
  downloading:"업데이트 다운로드 중",downloaded:"다운로드가 완료됐습니다.",current:"최신 버전입니다.",
  error:"업데이트 확인에 실패했습니다. 기존 프로그램은 계속 사용할 수 있습니다.",
  unsupported:"이 버전은 수동 업데이트 방식입니다.",installing:"프로그램을 종료하고 업데이트를 적용합니다."};
 const caption=captions[state.status]||"업데이트 상태를 확인할 수 없습니다.";
 updateMessage.textContent=caption+(state.status==="error"&&state.message?" ("+String(state.message).slice(0,90)+")":"")+"\n"+current+latest;
 const messages={checking:"업데이트 확인 중",available:"업데이트 다운로드",
  downloading:"다운로드 "+Math.round(Number(state.percent)||0)+"%",
  downloaded:"업데이트 준비 완료",current:"최신 버전",error:"업데이트 재확인",
  unsupported:"수동 업데이트",installing:"업데이트 적용 중"};
 updateButton.textContent=messages[state.status]||"업데이트";
 updateButton.title=caption;
 updateReady=state.status==="downloaded";
 updateProgress.hidden=state.status!=="downloading"&&state.status!=="downloaded";
 updateProgress.value=Math.max(0,Math.min(100,Number(state.percent)||0));
 updateInstall.hidden=!updateReady;
 updateLater.hidden=!updateReady;
 $("updateCheck").disabled=["checking","downloading","installing"].includes(state.status);
 // The native Windows dialog is used on download completion to avoid overlap with trading views.
 if(state.status==="error")$("updateCheck").disabled=false;
});
$("refresh").addEventListener("click",()=>window.hts.refresh());
$("preset").addEventListener("click",()=>{document.body.classList.toggle("compact");scheduleLayout();});
$("symbolSearch").addEventListener("input",()=>{
 if(activePage==="stocks"){clearTimeout(stockTimer);stockTimer=setTimeout(fetchStockMatches,230)}
 else renderSymbols();
});
window.addEventListener("resize",scheduleLayout);
new ResizeObserver(scheduleLayout).observe($("surface"));
new ResizeObserver(scheduleLayout).observe($("dashboard"));
window.hts.onAuth(setSignedIn);
window.hts.onSymbolChanged?.(item=>{
 if(!item||typeof item.symbol!=="string")return;
 selectedSymbol=item.symbol;
 if(item.label)$("chartTitle").textContent=item.label;
 renderSymbols();
});
window.hts.onStatus(s=>{
 if(s?.message)$("statusText").textContent=s.message;
 if(s?.offline){$("connectState").classList.remove("ready");$("connectLabel").textContent="서버 재연결 필요";}
});
renderSymbols();
scheduleLayout();
