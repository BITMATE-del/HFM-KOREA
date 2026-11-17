/* HFM Futures chart: high-DPI, candle/volume, drag-zoom, cursor and analysis tools.
 * Existing offline quote data is deliberately NOT labeled as a Massive live feed.
 */
(function(){
 "use strict";
 const instances=new WeakMap();
 function render(canvas,raw,opt={}){
  if(!canvas||!Array.isArray(raw)||!raw.length)return;
  const parent=canvas.parentElement;const state={raw:raw.map((c,i)=>({...c,index:i})),opt,hover:-1,zoom:1,tool:"crosshair",points:[],lastPointer:null,raf:0};
  instances.set(canvas,state);
  const ctx=canvas.getContext("2d");
  const font='11px "Malgun Gothic", Arial, sans-serif';
  const fmt=v=>typeof opt.format==="function"?opt.format(v):Number(v).toLocaleString("en-US",{maximumFractionDigits:2});
  const col={up:"#2562d1",down:"#e24150",grid:"#e9edf4",ink:"#2a4264",muted:"#8192ac",teal:"#3bb7aa"};
  function resize(){
   if(!canvas.isConnected)return;
   const r=parent.getBoundingClientRect(),width=Math.max(280,Math.floor(r.width)),height=Math.max(260,Math.floor(r.height)),dpr=Math.min(2,window.devicePixelRatio||1);
   if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
   }
   ctx.setTransform(dpr,0,0,dpr,0,0);
   state.w=width;state.h=height;
  }
  function visible(){
   const n=Math.max(17,Math.min(raw.length,Math.round(raw.length/state.zoom)));
   return raw.slice(-n);
  }
  function layout(){
   const w=state.w,h=state.h;
   const left=14,right=Math.min(91,Math.max(75,w*.12)),top=18,bottom=31,volH=Math.max(57,Math.min(90,h*.19)),gap=13;
   const plotRight=w-right,priceBottom=h-bottom-volH-gap;
   return {left,right,top,bottom,volH,gap,plotRight,priceBottom,volumeTop:priceBottom+gap,plotW:plotRight-left,plotH:priceBottom-top};
  }
  function rounded(x,y,w,h,r,fill){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=fill;ctx.fill()}
  function draw(){
   if(!canvas.isConnected)return;
   resize();const {w,h}=state,L=layout(),all=visible(),min0=Math.min(...all.map(x=>x.low)),max0=Math.max(...all.map(x=>x.high));
   const spread=Math.max(max0-min0,Number(opt.tick||.25)*8),min=min0-spread*.095,max=max0+spread*.095,range=max-min;
   const y=v=>L.top+(max-v)/range*L.plotH;
   const step=L.plotW/all.length,bodyW=Math.max(2,Math.min(12,step*.60));
   ctx.clearRect(0,0,w,h);ctx.fillStyle="#fff";ctx.fillRect(0,0,w,h);
   ctx.lineWidth=1;ctx.font=font;ctx.textBaseline="middle";
   // vertical time grid + horizontal price levels
   for(let k=0;k<=5;k++){
    const xx=Math.round(L.left+L.plotW*k/5)+.5;
    ctx.strokeStyle=col.grid;ctx.beginPath();ctx.moveTo(xx,L.top);ctx.lineTo(xx,h-L.bottom);ctx.stroke();
    const candle=all[Math.min(all.length-1,Math.floor((all.length-1)*k/5))];
    const minute=Number(opt.tf==="5분"?5:opt.tf==="15분"?15:opt.tf==="1시간"?60:1);
    const mins=9*60+Math.max(0,all.indexOf(candle))*minute;
    const label=opt.tf==="일봉"?String(k+1)+"일":String(Math.floor(mins/60)%24).padStart(2,"0")+":"+String(mins%60).padStart(2,"0");
    ctx.fillStyle=col.muted;ctx.font=font;ctx.textAlign=k===0?"left":k===5?"right":"center";
    ctx.fillText(label,xx,h-13);
   }
   for(let k=0;k<=6;k++){
    const price=min+range*(6-k)/6,yy=Math.round(y(price))+.5;
    ctx.beginPath();ctx.moveTo(L.left,yy);ctx.lineTo(L.plotRight,yy);
    ctx.strokeStyle=col.grid;ctx.stroke();
    ctx.textAlign="left";ctx.fillStyle=col.ink;ctx.font=font;ctx.fillText(fmt(price),L.plotRight+10,yy);
   }
   // volume divider and bars
   ctx.strokeStyle="#dfe6f0";ctx.beginPath();ctx.moveTo(L.left,L.volumeTop-6);ctx.lineTo(L.plotRight,L.volumeTop-6);ctx.stroke();
   const maxVol=Math.max(1,...all.map(x=>x.vol||0));
   for(let i=0;i<all.length;i++){
    const bar=all[i],x=L.left+(i+.5)*step;
    const growing=bar.close>=bar.open;const color=growing?col.up:col.down;
    const volHeight=Math.max(1,(Number(bar.vol||0)/maxVol)*(L.volH-14));
    ctx.globalAlpha=.41;ctx.fillStyle=growing?"#4b9ad7":"#ed8994";
    ctx.fillRect(Math.round(x-bodyW*.38),L.volumeTop+L.volH-volHeight,Math.max(2,bodyW*.75),volHeight);
    ctx.globalAlpha=1;
    ctx.strokeStyle=color;ctx.lineWidth=Math.max(1,Math.min(1.5,step*.15));
    ctx.beginPath();ctx.moveTo(x,y(bar.high));ctx.lineTo(x,y(bar.low));ctx.stroke();
    const yTop=y(Math.max(bar.close,bar.open)),yBottom=y(Math.min(bar.close,bar.open));
    ctx.fillStyle=color;ctx.fillRect(Math.round(x-bodyW/2),yTop,bodyW,Math.max(1.5,yBottom-yTop));
   }
   ctx.font='bold 10px "Malgun Gothic",Arial,sans-serif';ctx.fillStyle=col.muted;ctx.textAlign="left";ctx.fillText("거래량",L.left+3,L.volumeTop+2);
   // current price guide uses chart close, not upstream real-time market data
   const last=all[all.length-1],lastY=Math.max(L.top+12,Math.min(L.priceBottom-13,y(last.close)));
   ctx.save();ctx.setLineDash([4,4]);ctx.strokeStyle=last.close>=last.open?col.up:col.down;ctx.globalAlpha=.8;
   ctx.beginPath();ctx.moveTo(L.left,lastY);ctx.lineTo(L.plotRight,lastY);ctx.stroke();ctx.restore();
   rounded(L.plotRight+2,lastY-12,w-L.plotRight-4,24,4,last.close>=last.open?col.up:col.down);
   ctx.font='bold 11px "Malgun Gothic",Arial,sans-serif';ctx.fillStyle="#fff";ctx.textAlign="center";ctx.fillText(fmt(last.close),L.plotRight+(w-L.plotRight)/2,lastY+.5);
   // cursor and inline OHLC info
   let hover=state.hover>=0?Math.min(all.length-1,state.hover):all.length-1;
   const bar=all[hover];
   ctx.textAlign="left";ctx.font='bold 11px "Malgun Gothic",Arial,sans-serif';ctx.fillStyle=col.ink;
   const hud="시 "+fmt(bar.open)+"    고 "+fmt(bar.high)+"    저 "+fmt(bar.low)+"    종 "+fmt(bar.close);
   ctx.fillText(hud,L.left+6,Math.max(9,L.top-7));
   if(state.lastPointer&&state.tool==="crosshair"&&state.lastPointer.x<=L.plotRight&&state.lastPointer.y<L.priceBottom){
    const {x,y:cy}=state.lastPointer;
    ctx.save();ctx.setLineDash([3,4]);ctx.strokeStyle="#8695ad";ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x,L.top);ctx.lineTo(x,h-L.bottom);ctx.moveTo(L.left,cy);ctx.lineTo(L.plotRight,cy);ctx.stroke();ctx.restore();
    const pv=max-(cy-L.top)/L.plotH*range;
    rounded(L.plotRight+3,cy-10,w-L.plotRight-6,20,3,"#304564");
    ctx.fillStyle="#fff";ctx.font='bold 10px Arial';ctx.textAlign="center";ctx.fillText(fmt(pv),L.plotRight+(w-L.plotRight)/2,cy);
   }
   // functional trendline and ruler
   if(state.points.length){
    ctx.lineWidth=1.7;ctx.strokeStyle="#245fbd";ctx.fillStyle="#245fbd";
    for(const p of state.points){ctx.beginPath();ctx.arc(p.x,p.y,3,0,Math.PI*2);ctx.fill()}
    if(state.points.length>=2){
     const [a,b]=state.points.slice(-2);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
     if(state.tool==="ruler"){
      const delta=(a.y-b.y)/L.plotH*range;rounded(Math.min(a.x,b.x),Math.min(a.y,b.y)-26,125,19,4,"#173d7b");
      ctx.fillStyle="#fff";ctx.font='bold 10px Arial';ctx.textAlign="left";ctx.fillText((delta>0?"+":"")+fmt(delta),Math.min(a.x,b.x)+8,Math.min(a.y,b.y)-16)
     }
    }
   }
   state.geom={all,L,y,min,max,step};
  }
  function schedule(){if(state.raf)return;state.raf=requestAnimationFrame(()=>{state.raf=0;draw()})}
  const tools=canvas.closest(".chart-stage")?.querySelector(".chart-drawing-tools");
  if(tools){tools.addEventListener("click",e=>{
   const btn=e.target.closest("[data-chart-tool]");if(!btn)return;
   state.tool=btn.dataset.chartTool;
   if(state.tool==="reset"){state.zoom=1;state.points=[];state.tool="crosshair"}
   tools.querySelectorAll("button").forEach(b=>b.classList.toggle("active",b.dataset.chartTool===state.tool));
   schedule();
  })}
  canvas.addEventListener("mousemove",e=>{
   const box=canvas.getBoundingClientRect();const x=e.clientX-box.left,y=e.clientY-box.top,g=state.geom;
   if(!g)return;
   state.hover=Math.max(0,Math.min(g.all.length-1,Math.floor((x-g.L.left)/g.step)));
   state.lastPointer={x,y};
   const label=canvas.parentElement.querySelector("#chart-hover-data");
   if(label){label.classList.add("visible");const c=g.all[state.hover];label.textContent="시 "+fmt(c.open)+"   고 "+fmt(c.high)+"   저 "+fmt(c.low)+"   종 "+fmt(c.close)}
   schedule();
  });
  canvas.addEventListener("mouseleave",()=>{state.lastPointer=null;state.hover=-1;canvas.parentElement.querySelector("#chart-hover-data")?.classList.remove("visible");schedule()});
  canvas.addEventListener("click",e=>{if(!["line","ruler"].includes(state.tool))return;const r=canvas.getBoundingClientRect(),g=state.geom;if(!g)return;state.points.push({x:Math.max(g.L.left,Math.min(g.L.plotRight,e.clientX-r.left)),y:Math.max(g.L.top,Math.min(g.L.priceBottom,e.clientY-r.top))});if(state.points.length>2)state.points=state.points.slice(-2);schedule()});
  canvas.addEventListener("wheel",e=>{e.preventDefault();state.zoom=Math.min(3.5,Math.max(1,state.zoom*(e.deltaY<0?1.12:.89)));state.hover=-1;schedule()},{passive:false});
  if(typeof ResizeObserver==="function"){const ro=new ResizeObserver(schedule);ro.observe(parent)}
  else window.addEventListener("resize",schedule,{passive:true});
  draw();
 }
 window.HFMChartPro={render};
})();