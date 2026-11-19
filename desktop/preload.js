"use strict";
const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("hts",Object.freeze({
 layout:(rects)=>ipcRenderer.send("hts:layout",rects),
 page:(page)=>ipcRenderer.send("hts:page",page),
 symbol:(symbol)=>ipcRenderer.send("hts:symbol",symbol),
 refresh:()=>ipcRenderer.send("hts:refresh"),
 reconnect:()=>ipcRenderer.send("hts:reconnect"),
 popout:(kind)=>ipcRenderer.send("hts:popout",kind),
 preset:(name)=>ipcRenderer.send("hts:preset",name),
 onAuth:(fn)=>{const cb=(_event,value)=>fn(value);ipcRenderer.on("hts:auth",cb);return()=>ipcRenderer.removeListener("hts:auth",cb)},
 onStatus:(fn)=>{const cb=(_event,value)=>fn(value);ipcRenderer.on("hts:status",cb);return()=>ipcRenderer.removeListener("hts:status",cb)}
}));