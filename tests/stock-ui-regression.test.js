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

test("stock order request accepts validated KRX codes and stable browser idempotency UUIDs",()=>{
 const engine=require("../stock-internal-engine");
 const requestKey="550e8400-e29b-41d4-a716-446655440000";
 assert.deepEqual(engine.checkOrder({symbol:"005930",side:"BUY",qty:1,requestKey}),{symbol:"005930",side:"BUY",qty:1,id:requestKey});
 assert.equal(engine.checkOrder({symbol:5930,side:"SELL",qty:"1",requestKey}).symbol,"005930");
 assert.throws(()=>engine.checkOrder({symbol:"005930",side:"BUY",qty:1}),/INVALID_STOCK_ORDER/);
});
