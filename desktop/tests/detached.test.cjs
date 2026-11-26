"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const {normalizeRect,sanitizeLayout,createLayoutStore}=require("../layout-store.cjs");
test("detached windows persist valid screen coordinates and distinct per-chart symbols",()=>{
 const data=sanitizeLayout({panes:[
  {kind:"chart",symbol:"NQ",page:"futures",linked:true,rect:{x:-800,y:30,width:890,height:700}},
  {kind:"chart",symbol:"GC",page:"futures",linked:false,rect:{x:1400,y:100,width:710,height:630}},
  {kind:"order",symbol:"ES",page:"futures",linked:true,rect:{x:0,y:0,width:455,height:750}},
  {kind:"positions",symbol:"NQ",page:"futures",rect:{x:50,y:50,width:1100,height:420}}
 ]});
 assert.equal(data.panes.length,4);
 assert.deepEqual(data.panes.map(x=>x.symbol),["NQ","GC","ES","NQ"]);
 assert.equal(data.panes[1].linked,false);
 assert.equal(data.panes[0].rect.x,-800);
});
test("corrupt or invalid layout data are ignored and never used as scripts",()=>{
 assert.equal(normalizeRect({x:0,y:0,width:-5,height:300}),null);
 assert.equal(normalizeRect({x:0,y:0,width:8000,height:300}),null);
 const value=sanitizeLayout({panes:[
  {kind:"evil",symbol:"NQ",rect:{x:0,y:0,width:800,height:600}},
  {kind:"chart",symbol:"../../etc/passwd",rect:{x:0,y:0,width:800,height:600}},
  {kind:"chart",symbol:"005930",page:"stocks",linked:false,rect:{x:0,y:0,width:800,height:600}}
 ]});
 assert.equal(value.panes.length,2);
 assert.equal(value.panes[0].symbol,"NQ");
 assert.equal(value.panes[1].page,"stocks");
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"hfm-panel-test-"));
 try{
  const storage=createLayoutStore(tmp);
  storage.save(value);
  assert.deepEqual(storage.load(),value);
  fs.writeFileSync(path.join(tmp,"hts-workspace-v1.json"),"{garbled","utf8");
  assert.deepEqual(storage.load().panes,[]);
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
});
test("native detached panel shells are bundled and sandboxed",()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(__dirname,"../package.json"),"utf8"));
 for(const name of ["detached.html","detached.js","detached-preload.js","layout-store.cjs"])
  assert.ok(pkg.build.files.includes(name));
 assert.equal(pkg.version,"0.4.2");
 const main=fs.readFileSync(path.join(__dirname,"../main.js"),"utf8");
 assert.match(main,/new WebContentsView/);
 assert.match(main,/function createDetached/);
 assert.match(main,/detached\.set\(id,record\)/);
 assert.match(main,/restoreDetached\(\)/);
 assert.match(main,/record\.linked/);
 assert.match(main,/saveDetachedLayout\(\)/);
 assert.match(main,/fromDetached\(event\)/);
 assert.match(main,/contextIsolation:true,sandbox:true,webSecurity:true/);
 assert.match(main,/await enforcePane\(record\.kind,wc\)/);
 const shell=fs.readFileSync(path.join(__dirname,"../detached.html"),"utf8");
 assert.match(shell,/id="panelSlot"/);
 assert.match(shell,/메인 종목 연동/);
 assert.match(shell,/id="authGate"/);
 assert.match(shell,/id="loginNow"/);
 const renderer=fs.readFileSync(path.join(__dirname,"../detached.js"),"utf8");
 assert.match(renderer,/authGate"\)\.hidden=!!state\.ready/);
 assert.match(renderer,/loginNow"\)\.addEventListener/);
 const preload=fs.readFileSync(path.join(__dirname,"../detached-preload.js"),"utf8");
 assert.match(preload,/contextBridge\.exposeInMainWorld/);
 assert.doesNotMatch(preload,/require\("pg"\)|fetch\(.*api\/futures\/internal/);
});
