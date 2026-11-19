"use strict";
const path=require("node:path");
const {app,BrowserWindow,Menu,shell,dialog,session,screen}=require("electron");
const {HOME_URL,isTrustedAppUrl,isExternalAllowed,browserNavScript}=require("./config.cjs");

const APP_ID="kr.co.veltro.hts";
app.setAppUserModelId(APP_ID);
if(!app.requestSingleInstanceLock())app.quit();

let windowRef=null;
let offline=false;
let reconnecting=false;
let quitting=false;

async function showOffline(){
 if(quitting||!windowRef||windowRef.isDestroyed()||offline)return;
 offline=true;
 await windowRef.loadFile(path.join(__dirname,"offline.html")).catch(()=>{});
 updateTitle();
}
function updateTitle(){
 if(!windowRef||windowRef.isDestroyed())return;
 windowRef.setTitle(offline?"VELTRO HTS · 연결 확인":"VELTRO HTS");
}
async function connect(){
 if(!windowRef||windowRef.isDestroyed()||reconnecting)return;
 reconnecting=true;
 offline=false;
 try{await windowRef.loadURL(HOME_URL)}catch{await showOffline()}
 finally{reconnecting=false;updateTitle()}
}
function go(page){
 if(!windowRef||windowRef.isDestroyed())return;
 const code=browserNavScript(page);
 if(!isTrustedAppUrl(windowRef.webContents.getURL())){
  connect();return;
 }
 windowRef.webContents.executeJavaScript(code,true).catch(()=>{});
}
function createMenu(){
 const menu=Menu.buildFromTemplate([
  {label:"거래",submenu:[
   {label:"해외선물",accelerator:"CmdOrCtrl+1",click:()=>go("futures")},
   {label:"국내주식",accelerator:"CmdOrCtrl+2",click:()=>go("stocks")},
   {label:"시세·종목",accelerator:"CmdOrCtrl+3",click:()=>go("quotes")},
   {label:"주문·포지션",accelerator:"CmdOrCtrl+4",click:()=>go("orders")},
   {label:"지갑·자산",accelerator:"CmdOrCtrl+5",click:()=>go("wallet")}
  ]},
  {label:"화면",submenu:[
   {label:"새로고침",accelerator:"F5",click:()=>windowRef?.webContents.reload()},
   {label:"서버 다시 연결",accelerator:"CmdOrCtrl+Shift+R",click:connect},
   {type:"separator"},
   {label:"확대",role:"zoomIn",accelerator:"CmdOrCtrl+Plus"},
   {label:"축소",role:"zoomOut",accelerator:"CmdOrCtrl+-"},
   {label:"기본 배율",role:"resetZoom",accelerator:"CmdOrCtrl+0"},
   {type:"separator"},
   {label:"전체 화면",role:"togglefullscreen",accelerator:"F11"}
  ]},
  {label:"프로그램",submenu:[
   {label:"서버 연결 상태",click:()=>dialog.showMessageBox(windowRef,{
    type:"info",title:"VELTRO HTS",message:offline?"서버 연결이 필요합니다.":"프로그램이 거래 서버에 연결되어 있습니다.",
    detail:"회원 로그인, 시세 및 주문은 기존 VELTRO 서버에서 처리됩니다.",buttons:["확인"]
   })},
   {type:"separator"},
   {label:"프로그램 종료",role:"quit"}
  ]}
 ]);
 Menu.setApplicationMenu(menu);
}
function createWindow(){
 const display=screen.getPrimaryDisplay().workAreaSize;
 windowRef=new BrowserWindow({
  title:"VELTRO HTS",
  width:Math.min(1560,display.width),height:Math.min(960,display.height),
  minWidth:900,minHeight:620,
  backgroundColor:"#edf2f8",show:false,autoHideMenuBar:false,
  webPreferences:{
   nodeIntegration:false,
   contextIsolation:true,
   sandbox:true,
   webSecurity:true,
   allowRunningInsecureContent:false,
   spellcheck:false
  }
 });
 const contents=windowRef.webContents;
 contents.setWindowOpenHandler(({url})=>{
  if(isExternalAllowed(url))shell.openExternal(url).catch(()=>{});
  return {action:"deny"};
 });
 const preventUntrusted=(event,url)=>{if(!isTrustedAppUrl(url))event.preventDefault()};
 contents.on("will-navigate",preventUntrusted);
 contents.on("will-redirect",preventUntrusted);
 contents.on("did-finish-load",()=>{
  const current=contents.getURL();
  if(isTrustedAppUrl(current)){offline=false;updateTitle()}
 });
 contents.on("did-fail-load",(_event,code,_description,url,isMainFrame)=>{
  if(code!==-3&&isMainFrame&&isTrustedAppUrl(url))showOffline();
 });
 contents.on("render-process-gone",()=>showOffline());
 contents.on("before-input-event",(event,input)=>{
  // Prevent accidental development console access in a distributed trading client.
  if(input.key==="F12"||(input.control&&input.shift&&input.key.toLowerCase()==="i"))
   event.preventDefault();
 });
 windowRef.once("ready-to-show",()=>windowRef?.show());
 windowRef.on("closed",()=>windowRef=null);
 createMenu();
 connect();
}
app.on("second-instance",()=>{
 if(!windowRef)return;
 if(windowRef.isMinimized())windowRef.restore();
 windowRef.focus();
});
app.on("before-quit",()=>{quitting=true});
app.whenReady().then(()=>{
 session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
 session.defaultSession.setPermissionCheckHandler(()=>false);
 createWindow();
 app.on("activate",()=>{if(!BrowserWindow.getAllWindows().length)createWindow()});
});
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit()});
