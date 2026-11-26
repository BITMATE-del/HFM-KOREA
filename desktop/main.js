"use strict";
const path=require("node:path");
const {app,BrowserWindow,WebContentsView,Menu,shell,dialog,session,screen,ipcMain}=require("electron");
const {HOME_URL,isTrustedAppUrl,isExternalAllowed}=require("./config.cjs");
const {MODES,paneCSS,selectPageScript,selectSymbolScript}=require("./layout.cjs");
const {initAutoUpdate}=require("./updater.cjs");
const {createLayoutStore,normalizeRect,SYMBOL}=require("./layout-store.cjs");

app.setAppUserModelId("kr.co.hfmkorea.hts");
if(!app.requestSingleInstanceLock())app.quit();

let windowRef=null,authenticated=false,activePage="futures",activeSymbol="NQ",quitting=false;
const panes=new Map(),positions={chart:null,order:null,positions:null};
const popouts=new Set();
const detached=new Map();
let layoutStore=null,restoringPanels=false;
let authTimer=null;
let updaterControl={enabled:false};
let promptedVersion="";
function updateNotice(name,state){
 send(name,state);
 if(name!=="hts:update"||state?.status!=="downloaded"||!windowRef||windowRef.isDestroyed())return;
 const version=state.latest||"new";
 if(promptedVersion===version)return;
 promptedVersion=version;
 dialog.showMessageBox(windowRef,{
  type:"info",title:"HFM KOREA HTS 업데이트",
  message:"새로운 버전 v"+version+"의 다운로드가 완료되었습니다.",
  detail:"지금 재시작하면 업데이트를 적용합니다. 나중에 선택하면 거래 화면을 계속 이용할 수 있습니다. 정상 종료 시 업데이트가 적용될 수 있습니다.",
  buttons:["지금 재시작","나중에"],defaultId:1,cancelId:1,noLink:true
 }).then(result=>{
  if(result.response===0)updaterControl.install?.();
 }).catch(e=>console.warn("HTS update prompt:",e.message));
}


function send(name,value){
 if(windowRef&&!windowRef.isDestroyed()&&!windowRef.webContents.isDestroyed())windowRef.webContents.send(name,value);
}
function trustedNavigation(contents){
 contents.setWindowOpenHandler(({url})=>{
  if(isExternalAllowed(url))shell.openExternal(url).catch(()=>{});
  return {action:"deny"};
 });
 contents.on("will-navigate",(event,url)=>{if(!isTrustedAppUrl(url))event.preventDefault()});
 contents.on("will-redirect",(event,url)=>{if(!isTrustedAppUrl(url))event.preventDefault()});
}
function applyBounds(){
 if(!windowRef||windowRef.isDestroyed())return;
 for(const name of MODES){
  const pane=panes.get(name),r=positions[name];
  if(!pane)continue;
  if(!r||!r.width||!r.height||(name!=="chart"&&!authenticated)){
   pane.setVisible(false);continue;
  }
  pane.setBounds({x:r.x,y:r.y,width:r.width,height:r.height});
  pane.setVisible(true);
 }
}
async function enforcePane(name,contents){
 if(!isTrustedAppUrl(contents.getURL()))return;
 try{
  const css=paneCSS(name);
  // insertCSS is also applied to the authenticated WTS after a full navigation.
  // A document-owned style survives WTS DOM rewrites and takes the highest cascade priority.
  await contents.insertCSS(css);
  await contents.executeJavaScript(
   "(()=>{let e=document.getElementById('hfm-hts-pane-css');if(!e){e=document.createElement('style');e.id='hfm-hts-pane-css';document.head.appendChild(e)}e.textContent="+JSON.stringify(css)+";return true})()",true
  );
 }catch(e){console.warn("HTS pane styling failed:",name,e.message)}
}
async function navigatePane(name,page){
 const pane=panes.get(name);if(!pane||pane.webContents.isDestroyed()||!isTrustedAppUrl(pane.webContents.getURL()))return;
 const wc=pane.webContents;
 try{
  const ready=await wc.executeJavaScript(
   "Boolean(document.querySelector('#platform:not(.hidden) .nav-item[data-page=\\\""+page+"\\\"]'))",true);
  if(!ready)return;
  await wc.executeJavaScript(selectPageScript(page),true);
  await enforcePane(name,wc);
 }catch(e){console.warn("HTS navigation:",name,e.message)}
}
async function chooseSymbol(symbol,label="",market=""){
 activeSymbol=symbol;
 const work=[...panes.entries()].filter(([name])=>name==="chart"||name==="order"||name==="positions");
 for(const [,view] of work){
  if(view.webContents.isDestroyed()||!isTrustedAppUrl(view.webContents.getURL()))continue;
  try{await view.webContents.executeJavaScript(selectSymbolScript(symbol,label,market),true)}catch{}
 }
 for(const record of detached.values()){
  if(record.linked){
   record.symbol=symbol;record.page=/^\\d{6}$/.test(symbol)?"stocks":activePage;
   navigateDetached(record).catch(()=>{});
  }
 }
 send("hts:symbol-changed",{symbol,label});
}
async function onPaneLoaded(name,contents){
 if(!isTrustedAppUrl(contents.getURL()))return;
 try{
  await enforcePane(name,contents);
  // The backend may restore the cookie asynchronously; navigation and pane CSS are
  // retried after the page becomes authenticated, not just once at a fixed delay.
  setTimeout(()=>navigatePane(name,activePage),1200);
  if(name==="chart")pollAuthentication();
 }catch(e){console.warn("HTS layout failed:",name,e.message)}
}
function createPane(name){
 if(panes.has(name)||!windowRef||windowRef.isDestroyed())return;
 const pane=new WebContentsView({webPreferences:{
  nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,
  allowRunningInsecureContent:false,spellcheck:false
 }});
 panes.set(name,pane);
 windowRef.contentView.addChildView(pane);
 pane.setVisible(false);
 const wc=pane.webContents;
 trustedNavigation(wc);
 wc.on("did-finish-load",()=>onPaneLoaded(name,wc));
 wc.on("did-fail-load",(_event,code,_description,url,isMainFrame)=>{
  if(code!==-3&&isMainFrame&&isTrustedAppUrl(url)){
   send("hts:status",{offline:true,message:"거래 서버 연결을 확인해 주세요."});
   if(name==="chart")setTimeout(()=>{if(!quitting&&!wc.isDestroyed())wc.loadFile(path.join(__dirname,"offline.html")).catch(()=>{})},200);
  }
 });
 wc.on("render-process-gone",()=>send("hts:status",{offline:true,message:"거래 화면이 종료됐습니다. 새로고침을 눌러 주세요."}));
 wc.on("before-input-event",(event,input)=>{
  if(input.key==="F12"||(input.control&&input.shift&&input.key.toLowerCase()==="i"))event.preventDefault();
 });
 wc.loadURL(HOME_URL).catch(e=>send("hts:status",{offline:true,message:"HTS 서버 접속 실패: "+e.message}));
 applyBounds();
}
async function pollAuthentication(){
 const chart=panes.get("chart");
 if(!chart||chart.webContents.isDestroyed()||!isTrustedAppUrl(chart.webContents.getURL()))return;
 try{
  const loggedIn=await chart.webContents.executeJavaScript(
   "Boolean(document.querySelector('#platform')&&!document.querySelector('#platform').classList.contains('hidden'))",true);
  if(loggedIn!==authenticated){
   authenticated=loggedIn;
   send("hts:auth",authenticated);
   if(authenticated){
    createPane("order");createPane("positions");
    for(const name of MODES)navigatePane(name,activePage);
    restoreDetached();
   }
   applyBounds();
  }
  for(const record of detached.values()){
   arrangeDetached(record);
   tellDetached(record);
  }
  if(loggedIn){
   // Newly initialized views often finish account restoration after did-finish-load.
   for(const name of ["order","positions"]){
    const view=panes.get(name);
    if(!view||view.webContents.isDestroyed()||!isTrustedAppUrl(view.webContents.getURL()))continue;
    const current=await view.webContents.executeJavaScript(
     "document.querySelector('.nav-item.selected')?.dataset.page||''",true).catch(()=>"");
    if(current!==activePage)navigatePane(name,activePage);
   }
  }
  if(loggedIn&&activePage==="stocks"){
   const current=await chart.webContents.executeJavaScript(
    "typeof window.HFMCurrentWatchSymbol==='function'?window.HFMCurrentWatchSymbol():''",true).catch(()=>"");
   if(/^\d{6}$/.test(current)&&current!==activeSymbol){
    activeSymbol=current;
    send("hts:symbol-changed",{symbol:current});
    for(const name of ["order","positions"]){
     const view=panes.get(name);
     if(view&&!view.webContents.isDestroyed()){
      view.webContents.executeJavaScript(selectSymbolScript(current),true).catch(()=>{});
     }
    }
   }
  }
 }catch{}
}
function loadWorkspace(){
 const display=screen.getPrimaryDisplay().workAreaSize;
 windowRef=new BrowserWindow({
  title:"HFM KOREA HTS · Professional Workspace",
  width:Math.min(1600,display.width),height:Math.min(1000,display.height),
  minWidth:980,minHeight:670,
  backgroundColor:"#eef2f8",show:false,autoHideMenuBar:true,
  webPreferences:{preload:path.join(__dirname,"preload.js"),nodeIntegration:false,
   contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:false}
 });
 const shellContents=windowRef.webContents;
 shellContents.setWindowOpenHandler(()=>({action:"deny"}));
 shellContents.on("will-navigate",(event,url)=>{if(!url.startsWith("file://"))event.preventDefault()});
 shellContents.on("did-finish-load",()=>{
  createPane("chart");
  send("hts:auth",authenticated);
 });
 windowRef.once("ready-to-show",()=>windowRef?.show());
 windowRef.on("resize",applyBounds);
 windowRef.on("closed",()=>{
  windowRef=null;
  for(const pane of panes.values())if(!pane.webContents.isDestroyed())pane.webContents.close();
  panes.clear();
  if(authTimer){clearInterval(authTimer);authTimer=null}
 });
 windowRef.loadFile(path.join(__dirname,"workspace.html")).catch(console.error);
 authTimer=setInterval(pollAuthentication,1800);
 createMenu();
}
function detachedRecords(){
 return [...detached.values()].filter(v=>!v.window.isDestroyed()).map(v=>({
  kind:v.kind,symbol:v.symbol,page:v.page,linked:v.linked,rect:v.window.getBounds()
 }));
}
function saveDetachedLayout(){
 if(!layoutStore||restoringPanels)return;
 try{layoutStore.save({panes:detachedRecords()})}catch(e){console.warn("HTS layout save:",e.message)}
}
function tellDetached(record){
 if(record.window.isDestroyed()||record.window.webContents.isDestroyed())return;
 record.window.webContents.send("hts:detached-state",{
  kind:record.kind,linked:record.linked,symbol:record.symbol,page:record.page,ready:authenticated
 });
}
function arrangeDetached(record){
 if(record.window.isDestroyed()||record.view.webContents.isDestroyed())return;
 const win=record.window,view=record.view;
 if(!authenticated){view.setVisible(false);return}
 const r=record.rect;
 if(!r||r.width<50||r.height<50){view.setVisible(false);return}
 const size=win.getContentBounds();
 view.setBounds({x:Math.max(0,Math.min(r.x,size.width)),y:Math.max(0,Math.min(r.y,size.height)),
  width:Math.max(0,Math.min(r.width,size.width-r.x)),
  height:Math.max(0,Math.min(r.height,size.height-r.y))});
 view.setVisible(true);
}
async function navigateDetached(record){
 const wc=record.view.webContents;
 if(wc.isDestroyed()||!isTrustedAppUrl(wc.getURL())||!authenticated)return;
 await enforcePane(record.kind,wc);
 await wc.executeJavaScript(selectPageScript(record.page),true).catch(()=>{});
 // A symbol can be chosen independently per chart. Never fake or synthesize quote data.
 if(SYMBOL.test(record.symbol)){
  await wc.executeJavaScript(selectSymbolScript(record.symbol),true).catch(()=>{});
 }
 await enforcePane(record.kind,wc);
 tellDetached(record);
}
function createDetached(kind,options={}){
 if(!MODES.includes(kind)||!authenticated||detached.size>=12)return;
 if(kind!=="chart"){
  const existing=[...detached.values()].find(v=>v.kind===kind&&!v.window.isDestroyed());
  if(existing){if(existing.window.isMinimized())existing.window.restore();existing.window.focus();return}
 }
 const display=screen.getPrimaryDisplay().workArea;
 const preferred=normalizeRect(options.rect);
 const defaults={chart:{width:900,height:640},order:{width:455,height:750},positions:{width:1000,height:440}}[kind];
 const win=new BrowserWindow({
  title:"HFM KOREA HTS · "+({chart:"차트",order:"주문·호가",positions:"보유 포지션"}[kind]),
  width:preferred?.width||Math.min(defaults.width,display.width),
  height:preferred?.height||Math.min(defaults.height,display.height),
  ...(preferred?{x:preferred.x,y:preferred.y}:{}),
  minWidth:kind==="order"?390:kind==="chart"?560:620,minHeight:kind==="positions"?270:390,
  backgroundColor:"#eef2f7",show:false,autoHideMenuBar:true,
  webPreferences:{preload:path.join(__dirname,"detached-preload.js"),nodeIntegration:false,
   contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:false}
 });
 const child=new WebContentsView({webPreferences:{
  nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:false
 }});
 win.contentView.addChildView(child);child.setVisible(false);
 const id=win.webContents.id;
 const record={window:win,view:child,kind,page:options.page==="stocks"?"stocks":options.page==="futures"?"futures":activePage,
  symbol:SYMBOL.test(options.symbol||"")?options.symbol:activeSymbol,
  linked:options.linked!==false,rect:null};
 detached.set(id,record);popouts.add(win);
 win.webContents.setWindowOpenHandler(()=>({action:"deny"}));
 win.webContents.on("will-navigate",(event,url)=>{if(!url.startsWith("file://"))event.preventDefault()});
 win.webContents.on("did-finish-load",()=>{tellDetached(record);arrangeDetached(record)});
 win.once("ready-to-show",()=>{win.show();tellDetached(record)});
 win.on("resize",()=>arrangeDetached(record));
 win.on("move",saveDetachedLayout);
 win.on("resized",saveDetachedLayout);
 win.on("closed",()=>{
  detached.delete(id);popouts.delete(win);
  if(!child.webContents.isDestroyed())child.webContents.close();
  if(!quitting)saveDetachedLayout();
 });
 const wc=child.webContents;
 trustedNavigation(wc);
 wc.on("did-finish-load",()=>{
  if(!isTrustedAppUrl(wc.getURL()))return;
  enforcePane(kind,wc).catch(()=>{});
  setTimeout(()=>navigateDetached(record).catch(()=>{}),1200);
 });
 wc.on("render-process-gone",()=>{if(!win.isDestroyed())win.setTitle("HFM KOREA HTS · 연결 확인 필요")});
 win.loadFile(path.join(__dirname,"detached.html")).catch(console.error);
 wc.loadURL(HOME_URL).catch(()=>{});
 if(!options.restoring)saveDetachedLayout();
 return record;
}
function popout(kind){return createDetached(kind)}
function restoreDetached(){
 if(!authenticated||!layoutStore||restoringPanels||detached.size)return;
 restoringPanels=true;
 try{
  for(const item of layoutStore.load().panes)createDetached(item.kind,{...item,restoring:true});
 }finally{restoringPanels=false}
}
function createMenu(){
 const menu=Menu.buildFromTemplate([
  {label:"시장",submenu:[
   {label:"해외선물",accelerator:"CmdOrCtrl+1",click:()=>setPage("futures")},
   {label:"국내주식",accelerator:"CmdOrCtrl+2",click:()=>setPage("stocks")}
  ]},
  {label:"HTS 창",submenu:[
   {label:"차트 별도 창",accelerator:"CmdOrCtrl+Shift+1",click:()=>popout("chart")},
   {label:"주문 별도 창",accelerator:"CmdOrCtrl+Shift+2",click:()=>popout("order")},
   {label:"보유 포지션 별도 창",accelerator:"CmdOrCtrl+Shift+3",click:()=>popout("positions")},
   {type:"separator"},
   {label:"새로고침",accelerator:"F5",click:refreshPanes},
   {label:"전체 화면",role:"togglefullscreen",accelerator:"F11"}
  ]},
  {label:"프로그램",submenu:[
   {label:"서버 연결 상태",click:()=>dialog.showMessageBox(windowRef,{type:"info",
    title:"HFM KOREA HTS",message:authenticated?"거래 서버에 연결되어 있습니다.":"회원 로그인을 확인해 주세요.",
    detail:"기존 회원·주문·체결·원장 API를 사용하며 HTS가 별도 주문을 생성하지 않습니다.",buttons:["확인"]})},
   {label:"종료",role:"quit"}
  ]}
 ]);
 Menu.setApplicationMenu(menu);
}
function setPage(page){
 if(!["futures","stocks"].includes(page))return;
 activePage=page;
 for(const name of MODES)navigatePane(name,page);
 for(const record of detached.values())if(record.linked){
  record.page=page;
  if(page==="futures"&&/^\\d{6}$/.test(record.symbol))record.symbol="NQ";
  navigateDetached(record).catch(()=>{});
 }

 send("hts:status",{message:page==="stocks"?"국내주식 HTS 작업공간":"해외선물 HTS 작업공간"});
}
function refreshPanes(){
 for(const pane of panes.values())if(!pane.webContents.isDestroyed())pane.webContents.loadURL(HOME_URL).catch(()=>{});
 for(const record of detached.values())if(!record.view.webContents.isDestroyed())record.view.webContents.loadURL(HOME_URL).catch(()=>{});
}
function fromWorkspace(event){return !!windowRef&&!windowRef.isDestroyed()&&event.sender===windowRef.webContents}
ipcMain.on("hts:layout",(event,rects)=>{
 if(!fromWorkspace(event)||!rects||typeof rects!=="object")return;
 for(const name of MODES){
  const r=rects[name];
  if(!r){positions[name]=null;continue}
  if([r.x,r.y,r.width,r.height].every(x=>Number.isInteger(x)&&x>=0)){
   positions[name]={x:r.x,y:r.y,width:Math.min(r.width,5000),height:Math.min(r.height,4000)};
  }
 }
 applyBounds();
});
ipcMain.on("hts:page",(e,page)=>{if(fromWorkspace(e))setPage(page)});
ipcMain.on("hts:symbol",(e,symbol,label="",market="")=>{
 if(fromWorkspace(e)&&typeof symbol==="string"&&/^(?:[A-Z]{1,8}|\d{6})$/.test(symbol)&&
 typeof label==="string"&&label.length<=80&&typeof market==="string"&&market.length<=40)chooseSymbol(symbol,label,market);
});
ipcMain.handle("hts:search-stocks",async(e,query)=>{
 if(!fromWorkspace(e)||!authenticated||typeof query!=="string")return [];
 const q=query.trim().slice(0,50);
 // Empty search returns the first catalog page rather than an empty watchlist.
 const view=panes.get("chart");
 if(!view||view.webContents.isDestroyed()||!isTrustedAppUrl(view.webContents.getURL()))return [];
 try{
  const script="(async()=>{const r=await fetch('/api/stocks/catalog?q='+encodeURIComponent("+JSON.stringify(q)+"),{credentials:'same-origin',cache:'no-store'});if(!r.ok)return [];const d=await r.json();return Array.isArray(d.items)?d.items.slice(0,35):[]})()";
  const results=await view.webContents.executeJavaScript(script,true);
  return Array.isArray(results)?results.filter(x=>/^\d{6}$/.test(String(x.code||""))).slice(0,35).map(x=>({
   code:String(x.code),name:String(x.name||x.code).slice(0,80),market:String(x.market||"KRX").slice(0,40)
  })):[];
 }catch{return []}
});
ipcMain.on("hts:update-check",e=>{if(fromWorkspace(e))updaterControl.check?.()});
ipcMain.on("hts:update-install",e=>{if(fromWorkspace(e))updaterControl.install?.()});
ipcMain.on("hts:refresh",e=>{if(fromWorkspace(e))refreshPanes()});
ipcMain.on("hts:reconnect",e=>{if(fromWorkspace(e))refreshPanes()});
ipcMain.on("hts:popout",(e,kind)=>{if(fromWorkspace(e))popout(kind)});
function fromDetached(event){
 const record=detached.get(event.sender.id);
 return record&&record.window.webContents===event.sender&&!record.window.isDestroyed()?record:null;
}
ipcMain.on("hts:detached-ready",e=>{const r=fromDetached(e);if(r){tellDetached(r);arrangeDetached(r)}});
ipcMain.on("hts:detached-layout",(e,rect)=>{
 const r=fromDetached(e);if(!r||!rect)return;
 const size=r.window.getContentBounds();
 if(![rect.x,rect.y,rect.width,rect.height].every(Number.isInteger))return;
 if(rect.x<0||rect.y<0||rect.width<0||rect.height<0||rect.x+rect.width>size.width+2||rect.y+rect.height>size.height+2)return;
 r.rect=rect;arrangeDetached(r);
});
ipcMain.on("hts:detached-symbol",(e,symbol)=>{
 const r=fromDetached(e);
 if(!r||r.kind!=="chart"&&r.kind!=="order"||!SYMBOL.test(symbol))return;
 r.symbol=symbol;r.page=/^\\d{6}$/.test(symbol)?"stocks":"futures";r.linked=false;
 navigateDetached(r).catch(()=>{});tellDetached(r);saveDetachedLayout();
});
ipcMain.on("hts:detached-link",(e,linked)=>{
 const r=fromDetached(e);if(!r||typeof linked!=="boolean")return;
 r.linked=linked;if(linked){r.symbol=activeSymbol;r.page=activePage;navigateDetached(r).catch(()=>{})}
 tellDetached(r);saveDetachedLayout();
});
ipcMain.on("hts:detached-refresh",e=>{const r=fromDetached(e);if(r&&!r.view.webContents.isDestroyed())r.view.webContents.loadURL(HOME_URL).catch(()=>{})});
ipcMain.on("hts:detached-focus-main",e=>{if(fromDetached(e)&&windowRef&&!windowRef.isDestroyed()){windowRef.show();windowRef.focus()}});

ipcMain.on("hts:preset",e=>{if(fromWorkspace(e))applyBounds()});

app.on("second-instance",()=>{
 if(!windowRef)return;
 if(windowRef.isMinimized())windowRef.restore();
 windowRef.focus();
});
app.on("before-quit",()=>{saveDetachedLayout();quitting=true});
app.whenReady().then(()=>{
 layoutStore=createLayoutStore(app.getPath("userData"));
 session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 session.defaultSession.setPermissionCheckHandler(()=>false);
 loadWorkspace();
 try{
  const {autoUpdater}=require("electron-updater");
  updaterControl=initAutoUpdate({app,send:updateNotice,autoUpdater});
 }catch(error){
  console.warn("HTS update initialization skipped:",String(error?.message||error).slice(0,100));
  send("hts:update",{status:"error",message:"업데이트 서비스에 연결할 수 없습니다.",version:app.getVersion()});
 }
 app.on("activate",()=>{if(!BrowserWindow.getAllWindows().length)loadWorkspace()});
}).catch(console.error);
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit()});
