"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const file=name=>fs.readFileSync(path.join(__dirname,"..",name),"utf8");
test("existing admin password recovery is one-time, role-guarded and audited",()=>{
 const s=file("app-api.js");
 assert.match(s,/hf_admin_bootstrap_state/);
 assert.match(s,/row\.rows\[0\]\.role==="ADMIN"/);
 assert.match(s,/secret_fingerprint!==fingerprint/);
 assert.match(s,/DELETE FROM hf_sessions WHERE user_id=\$1/);
 assert.match(s,/ADMIN_BOOTSTRAP_PASSWORD_RESET/);
 assert.doesNotMatch(s,/console\.log\([^\n]*pwd/);
});
test("stock trading never forces a provider-ineligible price to be executed",()=>{
 const quote=file("server.js"),engine=file("stock-internal-engine.js");
 assert.match(quote,/tradeable:stockMarketOpen\(\)\&\&Number\.isFinite\(ts\)/);
 assert.match(engine,/const result=await transact\(c,user\.id,o,quote\)/);
 assert.doesNotMatch(engine,/transact\(c,user\.id,o,\{\.\.\.quote,tradeable:true\}/);
});
test("startup sandbox accounting uses the same contract margin policy as live trading",()=>{
 const s=file("sandbox-settlement.js");
 assert.match(s,/marginReservedKrw===calc\.marginFor\("NQ",1\)/);
 assert.doesNotMatch(s,/marginReservedKrw===3000000/);
});
