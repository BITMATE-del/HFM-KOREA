"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {paneCSS,selectPageScript,selectSymbolScript,MODES}=require("../layout.cjs");
test("native HTS packages local workspace instead of loading home page as the main window",()=>{
 const main=fs.readFileSync(path.join(__dirname,"../main.js"),"utf8");
 const pkg=JSON.parse(fs.readFileSync(path.join(__dirname,"../package.json"),"utf8"));
 assert.match(main,/WebContentsView/);
 assert.match(main,/loadFile\(path\.join\(__dirname,"workspace\.html"\)\)/);
 assert.match(main,/contextIsolation:true/);
 assert.match(main,/sandbox:true/);
 assert.match(main,/nodeIntegration:false/);
 assert.ok(pkg.build.files.includes("workspace.html"));
 assert.ok(pkg.build.files.includes("preload.js"));
 assert.ok(pkg.build.files.includes("layout.cjs"));
 assert.ok(pkg.build.files.includes("workspace.js"));
 assert.equal(pkg.build.productName,"HFM KOREA HTS");
});
test("chart, order and positions have individually isolated presentation styles",()=>{
 assert.deepEqual([...MODES],["chart","order","positions"]);
 const chart=paneCSS("chart"),order=paneCSS("order"),positions=paneCSS("positions");
 assert.match(chart,/chart-panel/);
 assert.match(chart,/order-panel/);
 assert.match(order,/order-panel/);
 assert.match(order,/chart-panel/);
 assert.match(positions,/bottom-panel/);
 assert.throws(()=>paneCSS("evil"),/UNKNOWN_PANE/);
});
test("only safe market navigation and instrument selectors are accepted",()=>{
 for(const p of ["futures","stocks"])assert.match(selectPageScript(p),new RegExp(p));
 for(const sym of ["NQ","MNQ","ES","005930"])assert.match(selectSymbolScript(sym),new RegExp(sym));
 for(const value of ['";alert(1)//',"../../../",'<img>',"nq"])assert.throws(()=>selectSymbolScript(value),/INVALID_SYMBOL/);
 assert.throws(()=>selectPageScript("admin"),/UNKNOWN_PAGE/);
});
test("workspace only talks to restricted preload methods",()=>{
 const page=fs.readFileSync(path.join(__dirname,"../workspace.html"),"utf8");
 const preload=fs.readFileSync(path.join(__dirname,"../preload.js"),"utf8");
 assert.match(page,/HTS TERMINAL/);
 assert.match(page,/chartSlot/);
 assert.match(page,/orderSlot/);
 assert.match(page,/positionsSlot/);
 assert.match(preload,/contextBridge/);
 assert.doesNotMatch(preload,/exposeInMainWorld\(["']require/);
});