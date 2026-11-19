"use strict";
const {URL}=require("node:url");

const HOME_URL="https://hfm-futures-web-production.up.railway.app/";
const HOME_ORIGIN=new URL(HOME_URL).origin;

const PAGES=Object.freeze({
 futures:"futures",
 stocks:"stocks",
 quotes:"quotes",
 orders:"orders",
 wallet:"wallet"
});
const ALLOWED_EXTERNAL_HOSTS=new Set(["t.me","telegram.me","github.com","www.github.com"]);

function isTrustedAppUrl(candidate){
 try{
  const u=new URL(candidate);
  return u.protocol==="https:"&&u.origin===HOME_ORIGIN;
 }catch{return false}
}
function isExternalAllowed(candidate){
 try{
  const u=new URL(candidate);
  return u.protocol==="https:"&&ALLOWED_EXTERNAL_HOSTS.has(u.hostname)
    &&!u.username&&!u.password;
 }catch{return false}
}
function browserNavScript(page){
 if(!Object.prototype.hasOwnProperty.call(PAGES,page))throw Error("UNKNOWN_PAGE");
 // The page is fixed from this allowlist, never interpolated from remote content.
 return "(()=>{const item=document.querySelector('.nav-item[data-page=\""+PAGES[page]+"\"]');if(item)item.click()})()";
}
module.exports={HOME_URL,HOME_ORIGIN,PAGES,isTrustedAppUrl,isExternalAllowed,browserNavScript};
