"use strict";

// Safe, deterministic presentation-only adjustments for the existing authenticated WTS.
// No trading, order, wallet or settlement logic is copied to the desktop client.
const MODES=Object.freeze(["chart","order","positions"]);
const pages=Object.freeze(["futures","stocks"]);
const BASE=`
:root{color-scheme:light}
html,body,#root{min-height:100%!important;max-width:none!important;background:#f6f9fd!important}
#platform{min-height:100%!important}
#platform .global-header,#platform .notice-strip,#platform #sidebar,#platform #futures-watchlist{display:none!important}
#platform .shell{display:block!important;min-height:100%!important;padding:0!important;margin:0!important;width:100%!important}
#platform #main-content{width:100%!important;max-width:none!important;min-width:0!important;padding:10px!important;margin:0!important;display:block!important}
#platform .page-head{margin-bottom:8px!important}
#platform .trading-layout{min-height:0!important}
#platform .panel{box-shadow:none!important}
#platform .page-sub{font-size:11px!important}
#platform #modal-root{position:relative;z-index:9999}
`;
const panes={
 chart:`
#platform .trade-header,#platform .order-panel,#platform .orderbook-panel,#platform .bottom-panel{display:none!important}
#platform .trading-layout{display:block!important;grid-template-columns:minmax(0,1fr)!important}
#platform .chart-panel{display:block!important;width:100%!important;max-width:none!important;min-height:calc(100vh - 122px)!important;grid-column:1/-1!important}
#platform .chart-stage{min-height:calc(100vh - 300px)!important}
#platform .hfm-market-chart-stage{min-height:calc(100vh - 320px)!important}
`,
 order:`
#platform .page-head,#platform .trade-header,#platform .chart-panel,#platform .orderbook-panel,#platform .bottom-panel{display:none!important}
#platform .trading-layout{display:block!important;grid-template-columns:minmax(0,1fr)!important}
#platform .order-panel{display:block!important;width:100%!important;max-width:none!important;grid-column:1/-1!important}
#platform .order-body{display:block!important}
#platform #main-content{padding:7px!important}
`,
 positions:`
#platform .page-head,#platform .trade-header,#platform .trading-layout{display:none!important}
#platform .bottom-panel{display:block!important;min-height:100%!important;margin:0!important}
#platform #main-content{padding:6px!important}
`
};
function paneCSS(pane){
 if(!MODES.includes(pane))throw Error("UNKNOWN_PANE");
 return BASE+panes[pane];
}
function selectPageScript(page){
 if(!pages.includes(page))throw Error("UNKNOWN_PAGE");
 return `(()=>{const b=document.querySelector('.nav-item[data-page="${page}"]');if(b)b.click();return !!b})()`;
}
function selectSymbolScript(symbol,label="",market=""){
 if(typeof symbol!=="string"||!(/^[A-Z]{1,8}$/.test(symbol)||/^\d{6}$/.test(symbol)))throw Error("INVALID_SYMBOL");
 if(typeof label!=="string"||label.length>80||typeof market!=="string"||market.length>40)throw Error("INVALID_SYMBOL_METADATA");
 const id=JSON.stringify(symbol),name=JSON.stringify(label),exchange=JSON.stringify(market);
 return `(()=>{if(typeof window.HFMNavigateWatchSymbol==='function'){window.HFMNavigateWatchSymbol(${id},${name},${exchange});return true}const b=document.querySelector('[data-watch="'+${id}+'"]');if(b){b.click();return true}return false})()`;
}
module.exports={MODES,paneCSS,selectPageScript,selectSymbolScript};
