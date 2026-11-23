"use strict";
const {contextBridge,ipcRenderer}=require("electron");
contextBridge.exposeInMainWorld("panel",Object.freeze({
 ready:()=>ipcRenderer.send("hts:detached-ready"),
 layout:rect=>ipcRenderer.send("hts:detached-layout",rect),
 choose:symbol=>ipcRenderer.send("hts:detached-symbol",symbol),
 link:value=>ipcRenderer.send("hts:detached-link",!!value),
 refresh:()=>ipcRenderer.send("hts:detached-refresh"),
 focusMain:()=>ipcRenderer.send("hts:detached-focus-main"),
 onState:fn=>{const cb=(_e,state)=>fn(state);ipcRenderer.on("hts:detached-state",cb);return()=>ipcRenderer.removeListener("hts:detached-state",cb)}
}));
