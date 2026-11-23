"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const updater=require("../updater.cjs");

test("updater is enabled only for packaged Windows NSIS installations",()=>{
 assert.equal(updater.shouldCheckUpdates({packaged:true,platform:"win32",portable:false}),true);
 for(const props of [
  {packaged:false,platform:"win32",portable:false},
  {packaged:true,platform:"linux",portable:false},
  {packaged:true,platform:"win32",portable:true}
 ])assert.equal(updater.shouldCheckUpdates(props),false);
});
test("release origin and semver strings are fixed and validated",()=>{
 assert.equal(updater.OWNER,"BITMATE-del");
 assert.equal(updater.REPO,"HFM-KOREA");
 for(const value of ["0.3.0","1.2.34","2.1.0-rc.1"])assert.equal(updater.safeVersion(value),value);
 for(const value of ["../../../etc/passwd","https://evil.tld","v1.2.3","0.2"])assert.equal(updater.safeVersion(value),"");
});
test("desktop package always includes CSS and Electron updater, excluding trading modules",()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(__dirname,"../package.json"),"utf8"));
 assert.equal(pkg.version,"0.4.0");
 assert.equal(pkg.build.appId,"kr.co.hfmkorea.hts");
 assert.ok(pkg.build.files.includes("hts-theme.css"));
 assert.ok(pkg.build.files.includes("updater.cjs"));
 assert.ok(pkg.dependencies["electron-updater"]);
 assert.deepEqual(pkg.build.publish,[{provider:"github",owner:"BITMATE-del",repo:"HFM-KOREA",releaseType:"release"}]);
 const main=fs.readFileSync(path.join(__dirname,"../main.js"),"utf8");
 assert.match(main,/fromWorkspace\(e\)\)updaterControl\.install/);
 assert.match(main,/initAutoUpdate/);
 const ui=fs.readFileSync(path.join(__dirname,"../workspace.html"),"utf8");
 assert.match(ui,/id="updateProgress"/);
 assert.match(ui,/id="updateInstall"/);
 assert.match(ui,/hts-theme\.css/);
});
test("updates never call new trading APIs, and never force quit while downloading",()=>{
 const src=fs.readFileSync(path.join(__dirname,"../updater.cjs"),"utf8");
 assert.doesNotMatch(src,/\/api\/|stocks_balance|DELETE FROM|futures_order/);
 assert.match(src,/autoInstallOnAppQuit=true/);
 assert.match(src,/downloaded\|\|installing/);
 assert.match(src,/autoUpdater\.quitAndInstall\(false,true\)/);
});
