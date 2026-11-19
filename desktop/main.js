"use strict";
const path=require("node:path");
const {app,BrowserWindow,WebContentsView,Menu,shell,dialog,session,screen,ipcMain}=require("electron");
const {HOME_URL,isTrustedAppUrl,isExternalAllowed}=require("./config.cjs");
const {MODES,paneCSS,selectPageScript,selectSymbolScript}=require("./layout.cjs");

app.setAppUserModelId("kr.co.hfmkorea.hts");
if(!app.requestSingleInstanceLock())app.quit();

let windowRef=null,authenticated=false,activePage="futures",activeSymbol="NQ",quitting=false;
const panes=new Map(),positions={chart:null,order:null,positions:null};
const popouts=new Set();
let authTimer=null;

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
async function navigatePane(name,page){
 const pane=panes.get(name);if(!pane||pane.webContents.isDestroyed())return;
 try{await pane.webContents.executeJavaScript(selectPageScript(page),true)}
 catch(e){console.warn("HTS navigation:",name,e.message)}
}
async function chooseSymbol(symbol,label="",market=""){
 activeSymbol=symbol;
 const work=[...panes.entries()].filter(([name])=>name==="chart"||name==="order"||name==="positions");
 for(const [,view] of work){
  if(view.webContents.isDestroyed()||!isTrustedAppUrl(view.webContents.getURL()))continue;
  try{await view.webContents.executeJavaScript(selectSymbolScript(symbol,label,market),true)}catch{}
 }
 send("hts:symbol-changed",{symbol,label});
}
async function onPaneLoaded(name,contents){
 if(!isTrustedAppUrl(contents.getURL()))return;
 try{
  await contents.insertCSS(paneCSS(name));
  if(name!=="chart"||authenticated){
   // Account restore uses the original authenticated backend and may finish asynchronously.
   setTimeout(()=>navigatePane(name,activePage),1100);
  }
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
    for(const name of ["order","positions"])navigatePane(name,activePage);
   }
   applyBounds();
  }
  if(loggedIn&&activePage==="stocks"){
   const current=await chart.webContents.executeJavaScript(
    "typeof window.HFMCurrentWatchSymbol==='function'?window.HFMCurrentWatchSymbol():''",true).catch(()=>"");
   if(/^\\d{6}$/.test(current)&&current!==activeSymbol){
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
function popout(kind){
 if(!MODES.includes(kind))return;
 const display=screen.getPrimaryDisplay().workAreaSize;
 const w=new BrowserWindow({
  title:"HFM KOREA HTS · "+({chart:"차트",order:"주문",positions:"포지션"}[kind]),
  width:kind==="chart"?Math.min(1100,display.width):kind==="order"?460:Math.min(1050,display.width),
  height:kind==="chart"?Math.min(780,display.height):kind==="order"?780:460,
  minWidth:kind==="chart"?660:kind==="order"?375:640,minHeight:340,
  backgroundColor:"#f6f9fd",autoHideMenuBar:true,
  webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:false}
 });
 popouts.add(w);w.on("closed",()=>popouts.delete(w));
 const wc=w.webContents;trustedNavigation(wc);
 wc.on("did-finish-load",async()=>{
  if(!isTrustedAppUrl(wc.getURL()))return;
  try{await wc.insertCSS(paneCSS(kind));setTimeout(()=>wc.executeJavaScript(selectPageScript(activePage),true).catch(()=>{}),1100)}
  catch(e){console.warn("HTS popout layout:",e.message)}
 });
 wc.loadURL(HOME_URL).catch(()=>{});
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
 send("hts:status",{message:page==="stocks"?"국내주식 HTS 작업공간":"해외선물 HTS 작업공간"});
}
function refreshPanes(){
 for(const pane of panes.values())if(!pane.webContents.isDestroyed())pane.webContents.loadURL(HOME_URL).catch(()=>{});
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
ipcMain.on("hts:symbol",(e,symbol)=>{if(fromWorkspace(e)&&/^(?:[A-Z]{1,8}|\d{6})$/.test(symbol))chooseSymbol(symbol)});
ipcMain.on("hts:refresh",e=>{if(fromWorkspace(e))refreshPanes()});
ipcMain.on("hts:reconnect",e=>{if(fromWorkspace(e))refreshPanes()});
ipcMain.on("hts:popout",(e,kind)=>{if(fromWorkspace(e))popout(kind)});
ipcMain.on("hts:preset",e=>{if(fromWorkspace(e))applyBounds()});

app.on("second-instance",()=>{
 if(!windowRef)return;
 if(windowRef.isMinimized())windowRef.restore();
 windowRef.focus();
});
app.on("before-quit",()=>{quitting=true});
app.whenReady().then(()=>{
 session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 session.defaultSession.setPermissionCheckHandler(()=>false);
 loadWorkspace();
 app.on("activate",()=>{if(!BrowserWindow.getAllWindows().length)loadWorkspace()});
}).catch(console.error);
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit()});
