"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const h=require("../config.cjs");

test("production HTS endpoint is HTTPS and origin-locked",()=>{
 assert.equal(h.HOME_URL,"https://hfm-futures-web-production.up.railway.app/");
 assert.equal(h.isTrustedAppUrl(h.HOME_URL),true);
 assert.equal(h.isTrustedAppUrl(h.HOME_URL+"?page=stocks"),true);
 for(const url of [
  "http://hfm-futures-web-production.up.railway.app/",
  "https://hfm-futures-web-production.up.railway.app.evil.test/",
  "https://evil.test/",
  "javascript:alert(1)","file:///etc/passwd","data:text/html,hello","about:blank",""
 ])assert.equal(h.isTrustedAppUrl(url),false,url);
});
test("desktop menus only navigate known authenticated trading pages",()=>{
 for(const p of ["futures","stocks","quotes","orders","wallet"]){
  const script=h.browserNavScript(p);
  assert.ok(script.includes('[data-page="'+p+'"]'));
  new vm.Script(script);
 }
 assert.throws(()=>h.browserNavScript("admin"),/UNKNOWN_PAGE/);
 assert.throws(()=>h.browserNavScript("');alert(1)//"),/UNKNOWN_PAGE/);
});
test("external window URLs have strict trusted HTTPS allowlist",()=>{
 assert.ok(h.isExternalAllowed("https://t.me/example"));
 assert.ok(h.isExternalAllowed("https://github.com/BITMATE-del/HFM-KOREA"));
 for(const url of ["http://t.me/test","https://t.me.evil.test","file:///C:/a.exe","https://evil.test","https://user:pass@t.me/test"])
  assert.equal(h.isExternalAllowed(url),false,url);
});
test("desktop main and fallback are valid and hardened",()=>{
 const main=fs.readFileSync(path.join(__dirname,"..","main.js"),"utf8");
 const offline=fs.readFileSync(path.join(__dirname,"..","offline.html"),"utf8");
 new vm.Script(main,{filename:"main.js"});
 assert.match(main,/nodeIntegration:false/);
 assert.match(main,/contextIsolation:true/);
 assert.match(main,/sandbox:true/);
 assert.match(main,/setWindowOpenHandler/);
 assert.match(main,/requestSingleInstanceLock/);
 assert.match(offline,/다시 연결/);
});

test("native HTS session checks the server, not only a visible login surface",()=>{
 const main=fs.readFileSync(path.join(__dirname,"../main.js"),"utf8");
 assert.match(main,/fetch\('\/api\/auth\/me'/);
 assert.match(main,/j\.authenticated===true/);
 assert.doesNotMatch(main,/Boolean\(document\.querySelector\('#platform'\)/);
});
