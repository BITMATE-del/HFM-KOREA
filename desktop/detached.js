"use strict";
const slot=document.getElementById("panelSlot");
const selector=document.getElementById("symbol"),checkbox=document.querySelector("#linked input");
let last=null;
function fit(){
 const rect=slot.getBoundingClientRect();
 window.panel.layout({x:Math.max(0,Math.round(rect.x)),y:Math.max(0,Math.round(rect.y)),
  width:Math.max(0,Math.round(rect.width)),height:Math.max(0,Math.round(rect.height))});
}
window.panel.onState(state=>{
 if(!state||typeof state!=="object")return;
 last=state;
 document.getElementById("kindLabel").textContent=({chart:"차트",order:"주문·호가",positions:"보유 포지션"}[state.kind]||"HTS");
 selector.hidden=state.kind==="positions";
 document.getElementById("linked").hidden=state.kind==="positions";
 checkbox.checked=!!state.linked;
 if(state.symbol&&selector.querySelector('option[value="'+CSS.escape(state.symbol)+'"]'))selector.value=state.symbol;
 document.getElementById("shellNote").textContent=state.ready?"":(state.kind==="order"?"주문하려면 로그인이 필요합니다. 상단의 메인창 버튼을 눌러 로그인해 주세요.":"이 기능을 이용하려면 메인 창에서 로그인해 주세요.");
 fit();
});
selector.addEventListener("change",()=>window.panel.choose(selector.value));
checkbox.addEventListener("change",()=>window.panel.link(checkbox.checked));
document.getElementById("refresh").addEventListener("click",()=>window.panel.refresh());
document.getElementById("main").addEventListener("click",()=>window.panel.focusMain());
window.addEventListener("resize",fit);
new ResizeObserver(fit).observe(slot);
window.panel.ready();requestAnimationFrame(fit);
