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

const strongBase="\n/* Explicitly outrank the WTS structural CSS in each isolated desktop pane. */\nhtml body #platform.platform>header.global-header,\nhtml body #platform.platform .shell>#sidebar.sidebar,\nhtml body #platform.platform .shell>.watchlist,\nhtml body #platform.platform .notice-strip,\nhtml body #platform.platform .account-overview,\nhtml body #platform.platform .page-head,\nhtml body #platform.platform .trade-header,\nhtml body #platform.platform .stock-tabs,\nhtml body #platform.platform .stock-tabbar,\nhtml body #platform.platform .stock-info-panel,\nhtml body #platform.platform .hfm-stock-tabs,\nhtml body #platform.platform .hfm-stock-panel{display:none!important}\nhtml body #platform.platform .shell{\n display:block!important;grid-template-columns:none!important;grid-template-rows:none!important;\n min-height:100vh!important;max-width:100%!important;width:100%!important;padding:0!important;margin:0!important;\n}\nhtml body #platform.platform .shell>.main-panel{\n display:block!important;grid-column:auto!important;grid-row:auto!important;\n max-width:100%!important;width:100%!important;min-width:0!important;padding:0!important;margin:0!important;\n}\nhtml body #platform.platform #main-content{display:block!important;max-width:100%!important;width:100%!important;padding:0!important;margin:0!important;min-width:0!important}\nhtml body #platform.platform .trading-layout{\n display:block!important;grid-template-columns:none!important;max-width:100%!important;width:100%!important;\n padding:0!important;margin:0!important;min-width:0!important;\n}\nhtml body #platform.platform #modal-root{z-index:9999!important}\n";
const strongPanes={"chart":"html body #platform.platform .trading-layout>.order-panel,html body #platform.platform .trading-layout>.orderbook-panel,html body #platform.platform .bottom-panel{display:none!important}\nhtml body #platform.platform .trading-layout>.chart-panel{\ndisplay:flex!important;flex-direction:column!important;grid-column:auto!important;grid-row:auto!important;\nwidth:100%!important;max-width:100%!important;min-height:calc(100vh - 2px)!important;height:auto!important;border:0!important}\nhtml body #platform.platform .hfm-market-chart-stage{flex:1!important;height:calc(100vh - 120px)!important;min-height:350px!important}\n","order":"html body #platform.platform .trading-layout>.chart-panel,html body #platform.platform .trading-layout>.orderbook-panel,html body #platform.platform .bottom-panel{display:none!important}\nhtml body #platform.platform .trading-layout>.order-panel{\ndisplay:block!important;grid-column:auto!important;grid-row:auto!important;\nwidth:100%!important;max-width:100%!important;min-height:0!important;border:0!important}\nhtml body #platform.platform .trading-layout .order-body{display:block!important;padding:12px!important;width:100%!important}\nhtml body #platform.platform .trading-layout .order-fields{margin-bottom:16px!important}\nhtml body #platform.platform .trading-layout .order-info{margin-bottom:15px!important}\nhtml body #platform.platform .trading-layout .trade-buttons{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:12px!important}\n","positions":"html body #platform.platform .trading-layout{display:none!important}\nhtml body #platform.platform .bottom-panel{display:block!important;width:100%!important;min-height:0!important;margin:0!important;border:0!important}\nhtml body #platform.platform .bottom-panel .table-scroll{overflow:auto!important;width:100%!important}\n"};
const loginPaneCSS=`
/* Only desktop login view. Authentication is still performed by HFM's existing API. */
html body #auth.auth-wrap{background:#091e30!important;min-height:100vh!important}
html body #auth .auth-feature{background:linear-gradient(145deg,#071625,#153c5e)!important}
html body #auth .auth-side{background:#f4f7fb!important}
html body #auth .auth-box{border:1px solid #dae4ee!important;border-radius:9px!important;box-shadow:0 14px 36px #142f4a14!important}
html body #auth #login-form input{border-radius:5px!important}
html body #auth #login-form button[type="submit"]{border-radius:5px!important}
`;
function paneCSS(pane){
 if(!MODES.includes(pane))throw Error("UNKNOWN_PANE");
 return BASE+loginPaneCSS+panes[pane]+strongBase+strongPanes[pane];
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
