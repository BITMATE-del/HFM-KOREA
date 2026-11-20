"use strict";
(function(global){
 const instances=new WeakMap();
 const cache=new Map();
 function legend(el,text){
  let status=el.querySelector(".hfm-market-chart-status");
  if(!status){status=document.createElement("div");status.className="hfm-market-chart-status";el.appendChild(status)}
  status.textContent=text;
 }
 function barsFor(series,stock){
  const map=new Map();
  for(const x of series){
   const t=x.time;
   if(!(typeof t==="number"||typeof t==="string"))continue;
   const open=Number(x.open),close=Number(x.close),high=Number(x.high),low=Number(x.low);
   const vol=Math.max(0,Number(x.vol??x.volume??0));
   if(![open,close,high,low,vol].every(Number.isFinite)||open<=0||close<=0||high<Math.max(open,close)||low>Math.min(open,close))continue;
   map.set(String(t),{time:t,open,close,high,low,vol});
  }
  return [...map.values()].sort((a,b)=>String(a.time).localeCompare(String(b.time))).slice(-25000);
 }
 function average(data,n){
  let sum=0;
  return data.map((bar,i)=>{
   sum+=bar.close;if(i>=n)sum-=data[i-n].close;
   return {time:bar.time,value:sum/Math.min(i+1,n)}
  });
 }
 function dispose(el){
  const old=instances.get(el);
  if(!old)return;
  old.observer?.disconnect();
  old.chart?.remove();
  instances.delete(el);
 }
 function mount(el,{symbol,tf,dark=false,stock=false,series=[],source="",feedError=""}={}){
  if(!el)return;
  const library=global.LightweightCharts;
  if(!library?.createChart||!library.CandlestickSeries){
   legend(el,"차트 엔진을 불러오는 중입니다. 연결 상태를 확인해 주세요.");
   return;
  }
  const data=barsFor(series,stock);
  const key=[symbol,tf,dark?"dark":"light",source].join("|");
  const signature=[data.length,data[0]?.time,data.at(-1)?.time,data.at(-1)?.open,data.at(-1)?.high,data.at(-1)?.low,data.at(-1)?.close,data.at(-1)?.vol].join("|");
  const old=instances.get(el);
  if(old?.key===key && old?.signature===signature)return;
  // Incremental live candle updates avoid rebuilding thousands of history bars every second.
  if(old?.key===key && data.length && old.firstTime===data[0].time &&
    (data.length===old.count||data.length===old.count+1) &&
    (data.length===old.count?old.lastTime===data.at(-1).time:old.lastTime===data.at(-2).time)){
   const last=data.at(-1),scale=old.chart.timeScale(),range=scale.getVisibleLogicalRange();
   const atRight=!range||range.to>=old.count-12;
   old.candles.update({time:last.time,open:last.open,high:last.high,low:last.low,close:last.close});
   old.volume.update({time:last.time,value:last.vol,color:last.close>=last.open?"#ed768a":"#6d91e6"});
   for(const [i,period] of [5,20,60].entries()){
    const values=data.slice(-period),averageValue=values.reduce((sum,bar)=>sum+bar.close,0)/values.length;
    old.lines[i].update({time:last.time,value:averageValue});
   }
   old.signature=signature;old.count=data.length;old.firstTime=data[0].time;old.lastTime=data.at(-1).time;old.lastTime=last.time;
   if(atRight)scale.scrollToRealTime();
   return;
  }
  if(old?.key===key && data.length){
   const scale=old.chart.timeScale(),range=scale.getVisibleLogicalRange();
   const atRight=!range||range.to>=old.count-12;
   const candlesData=data.map(x=>({time:x.time,open:x.open,high:x.high,low:x.low,close:x.close}));
   old.candles.setData(candlesData);
   old.volume.setData(data.map(x=>({time:x.time,value:x.vol,color:x.close>=x.open?"#ed768a":"#6d91e6"})));
   for(const [i,period] of [5,20,60].entries())old.lines[i].setData(average(data,period));
   old.signature=signature;old.count=data.length;
   if(atRight)scale.scrollToRealTime();
   else if(range)scale.setVisibleLogicalRange(range);
   return;
  }
  if(old)dispose(el);
  el.replaceChildren();
  if(data.length===0){
   legend(el,stock?"해당 시간대의 확인된 시세 데이터가 없습니다.":feedError?"시세를 불러오지 못했습니다. 잠시 후 다시 연결합니다.":"실시간 시세를 연결 중입니다…");
   el.dataset.chartStatus="unavailable";
   return;
  }
  el.dataset.chartStatus="ready";
  const target=document.createElement("div");target.className="hfm-market-chart-canvas";el.appendChild(target);
  const colorUp="#ef5972",colorDown="#4b73e6";
  let chart;
  try{
   chart=library.createChart(target,{
    width:Math.max(260,target.clientWidth||el.clientWidth),
    height:Math.max(290,target.clientHeight||el.clientHeight),
    layout:{background:{type:library.ColorType.Solid,color:dark?"#111827":"#ffffff"},textColor:dark?"#bdc9dd":"#8899b2",fontFamily:"Arial, 'Malgun Gothic', sans-serif",fontSize:11},
    grid:{vertLines:{color:dark?"#263248":"#f1f4f8"},horzLines:{color:dark?"#263248":"#f1f4f8"}},
    rightPriceScale:{borderVisible:false,scaleMargins:{top:.1,bottom:.22}},
    timeScale:{borderVisible:false,timeVisible:tf!=="일봉",secondsVisible:false,barSpacing:8,rightOffset:5,fixLeftEdge:false},
    crosshair:{mode:library.CrosshairMode.Normal,vertLine:{color:"#b2c2e4",labelBackgroundColor:"#3865ad"},horzLine:{color:"#b2c2e4",labelBackgroundColor:"#3865ad"}},
    localization:{locale:"ko-KR"},
    handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:true},
    handleScale:{mouseWheel:true,pinch:true}
   });
   const candles=chart.addSeries(library.CandlestickSeries,{upColor:colorUp,downColor:colorDown,borderUpColor:colorUp,borderDownColor:colorDown,wickUpColor:colorUp,wickDownColor:colorDown});
   candles.setData(data.map(x=>({time:x.time,open:x.open,high:x.high,low:x.low,close:x.close})));
   const vol=chart.addSeries(library.HistogramSeries,{priceFormat:{type:"volume"},priceScaleId:"volume",lastValueVisible:false,priceLineVisible:false});
   chart.priceScale("volume").applyOptions({scaleMargins:{top:.80,bottom:0}});
   vol.setData(data.map(x=>({time:x.time,value:x.vol,color:x.close>=x.open?"#ed768a":"#6d91e6"})));
   const lines=[];
   for(const [period,color]of [[5,"#e1a54e"],[20,"#c85986"],[60,"#6379cc"]]){
    const line=chart.addSeries(library.LineSeries,{color,lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
    line.setData(average(data,period));lines.push(line);
   }
   // Open on readable recent candles rather than fitting thousands of history bars.
   const focusLatest=()=>chart.timeScale().setVisibleLogicalRange({from:Math.max(0,data.length-80),to:data.length+5});
   focusLatest();
   requestAnimationFrame(()=>{if(target.isConnected)focusLatest()});
   const observer=new ResizeObserver(()=>{
    if(!target.isConnected)return;
    chart.applyOptions({width:Math.max(260,target.clientWidth),height:Math.max(290,target.clientHeight)});
   });
   observer.observe(target);
   instances.set(el,{chart,observer,key,signature,count:data.length,firstTime:data[0].time,lastTime:data.at(-1).time,candles,volume:vol,lines});
  }catch(err){
   chart?.remove();
   console.warn("HFM_CHART_RENDER_FAILED",String(err?.message||"unavailable").slice(0,70));
   el.replaceChildren();legend(el,"차트를 표시할 수 없습니다. 차트 엔진 연결을 확인해 주세요.");
  }
 }
 global.HFMMarketChart=Object.freeze({mount,dispose});
})(window);
