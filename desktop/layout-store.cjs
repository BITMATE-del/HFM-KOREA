"use strict";
const fs=require("node:fs");
const path=require("node:path");
const KINDS=new Set(["chart","order","positions"]);
const SYMBOL=/^(?:[A-Z]{1,8}|\d{6})$/;
function normalizeRect(rect,kind="chart"){
 if(!rect||![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite))return null;
 const width=Math.round(rect.width),height=Math.round(rect.height);
 if(width<320||height<220||width>6000||height>5000)return null;
 return {x:Math.round(rect.x),y:Math.round(rect.y),width,height};
}
function sanitizeLayout(value){
 const panes=Array.isArray(value?.panes)?value.panes:[];
 return {version:1,panes:panes.slice(0,12).filter(v=>KINDS.has(v?.kind)&&
  (v.kind==="chart"||v.kind==="order"||v.kind==="positions")).map(v=>({
   kind:v.kind,symbol:SYMBOL.test(v.symbol||"")?v.symbol:"NQ",
   page:v.page==="stocks"?"stocks":"futures",
   linked:v.linked!==false,rect:normalizeRect(v.rect,v.kind)
  })).filter(v=>v.rect)};
}
function createLayoutStore(userDataPath){
 const file=path.join(userDataPath,"hts-workspace-v1.json");
 function load(){
  try{return sanitizeLayout(JSON.parse(fs.readFileSync(file,"utf8")))}
  catch{return{version:1,panes:[]}}
 }
 function save(value){
  const data=sanitizeLayout(value);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+".tmp";
  fs.writeFileSync(temp,JSON.stringify(data,null,2),"utf8");
  fs.renameSync(temp,file);
  return data;
 }
 return {load,save};
}
module.exports={normalizeRect,sanitizeLayout,createLayoutStore,KINDS,SYMBOL};
