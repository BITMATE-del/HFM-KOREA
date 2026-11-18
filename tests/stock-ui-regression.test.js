"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
test("stock navigation must iterate querySelectorAll collections, never querySelector",()=>{
 const wrong=[...html.matchAll(/(?<!\$)\$\((['"])[^'"]+\1\)\.forEach/g)];
 assert.equal(wrong.length,0,wrong.map(x=>x[0]).join(", "));
 for(const selector of ["[data-stock-tab]","[data-stock-goto]","[data-stock-remove]","[data-goto-symbol]","[data-quote-page]"]){
  assert.ok(html.includes("$$('"+selector+"').forEach"),"Missing collection listener "+selector);
 }
});
test("account state fetch failure is not triggered by an ordinary view render error",()=>{
 assert.match(html,/try\{render\(\)\}catch\(viewError\)/);
 assert.match(html,/HFM_RENDER_ERROR/);
});
