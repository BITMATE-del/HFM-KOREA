"use strict";
/*
 * Windows NSIS update coordinator. Does not access accounts, orders or trading APIs.
 * Only a trusted, explicitly published HFM-KOREA GitHub Release can be installed.
 */
const OWNER="BITMATE-del", REPO="HFM-KOREA";
const CHECK_INTERVAL=30*60*1000;
function shouldCheckUpdates({packaged,platform,portable}){
 return !!packaged&&platform==="win32"&&!portable;
}
function safeVersion(value){
 return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value||""))?String(value):"";
}
function normalizeError(error){
 return String(error?.message||error||"업데이트를 확인할 수 없습니다.").slice(0,180);
}
function initAutoUpdate({app,ipcMain,send,autoUpdater,logger=console}){
 if(!shouldCheckUpdates({packaged:app.isPackaged,platform:process.platform,portable:!!process.env.PORTABLE_EXECUTABLE_FILE})){
  send("hts:update",{status:"unsupported",message:process.env.PORTABLE_EXECUTABLE_FILE?"무설치형은 수동 업데이트 방식입니다.":"자동 업데이트는 Windows 설치형 프로그램에서 지원합니다.",version:app.getVersion()});
  return {enabled:false};
 }
 let downloaded=false,installing=false,checking=false,latest="";
 const emit=(status,details={})=>send("hts:update",{status,version:app.getVersion(),...details});
 autoUpdater.autoDownload=true;
 // A user who selects "나중에" keeps trading until normal app exit.
 // No forced process quit; electron-updater verifies release metadata SHA512.
 autoUpdater.autoInstallOnAppQuit=true;
 autoUpdater.allowPrerelease=false;
 autoUpdater.allowDowngrade=false;
 autoUpdater.setFeedURL({provider:"github",owner:OWNER,repo:REPO,private:false});
 const check=async()=>{
  if(checking||installing)return;
  checking=true;emit("checking",{message:"업데이트 확인 중"});
  try{await autoUpdater.checkForUpdates()}
  catch(e){emit("error",{message:normalizeError(e)});logger.warn("[hts-updater] check failed:",normalizeError(e))}
  finally{checking=false}
 };
 autoUpdater.on("checking-for-update",()=>emit("checking",{message:"업데이트 확인 중"}));
 autoUpdater.on("update-available",info=>{
  latest=safeVersion(info?.version);
  emit("available",{latest,message:"새 버전을 다운로드하고 있습니다."});
 });
 autoUpdater.on("update-not-available",()=>emit("current",{message:"최신 버전입니다."}));
 autoUpdater.on("download-progress",progress=>emit("downloading",{
  latest,
  percent:Math.max(0,Math.min(100,Math.round(Number(progress?.percent)||0))),
  message:"업데이트 다운로드 중"
 }));
 autoUpdater.on("update-downloaded",info=>{
  downloaded=true;latest=safeVersion(info?.version)||latest;
  emit("downloaded",{latest,percent:100,message:"새 버전을 설치할 준비가 되었습니다."});
 });
 autoUpdater.on("error",err=>{
  // Error is nonfatal; never block the existing trading screen.
  emit("error",{message:normalizeError(err)});
  logger.warn("[hts-updater] nonfatal:",normalizeError(err));
 });
 // No renderer-controlled quitAndInstall IPC: the main process must verify sender.
 const install=()=>{
  if(!downloaded||installing)return false;
  installing=true;
  emit("installing",{latest,message:"업데이트 적용을 위해 프로그램을 다시 시작합니다."});
  try{autoUpdater.quitAndInstall(false,true);return true}
  catch(e){installing=false;emit("error",{message:normalizeError(e)});return false}
 };
 const timer=setInterval(check,CHECK_INTERVAL);
 if(typeof timer.unref==="function")timer.unref();
 setTimeout(check,5000);
 return {enabled:true,check,install,get downloaded(){return downloaded}};
}
module.exports={OWNER,REPO,CHECK_INTERVAL,shouldCheckUpdates,safeVersion,normalizeError,initAutoUpdate};
