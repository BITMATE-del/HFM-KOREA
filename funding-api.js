"use strict";
/* HFM FUTURES: funding requests + two-account ledger (not external bank payments). */
const {randomUUID}=require("node:crypto");
const core=require("./app-api");
const {pool,auth}=core;
const statements=[
"CREATE TABLE IF NOT EXISTS hf_wallets(user_id BIGINT PRIMARY KEY REFERENCES hf_users(id),futures_balance BIGINT NOT NULL DEFAULT 0 CHECK(futures_balance>=0),stocks_balance BIGINT NOT NULL DEFAULT 0 CHECK(stocks_balance>=0),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS hf_funding_requests(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES hf_users(id),kind VARCHAR(12) NOT NULL CHECK(kind IN ('DEPOSIT','WITHDRAW','TRANSFER')),account VARCHAR(12) NOT NULL CHECK(account IN ('FUTURES','STOCKS')),amount BIGINT NOT NULL CHECK(amount>=1000 AND amount<=1000000000),status VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),request_key UUID NOT NULL,reviewed_by BIGINT REFERENCES hf_users(id),reviewed_at TIMESTAMPTZ,review_note VARCHAR(500) NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,request_key))",
"CREATE INDEX IF NOT EXISTS hf_funding_status ON hf_funding_requests(status,created_at DESC)",
"CREATE TABLE IF NOT EXISTS hf_wallet_ledger(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES hf_users(id),request_id BIGINT NOT NULL REFERENCES hf_funding_requests(id),account VARCHAR(12) NOT NULL CHECK(account IN ('FUTURES','STOCKS')),delta BIGINT NOT NULL,balance_after BIGINT NOT NULL CHECK(balance_after>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(request_id,account))"
];
let ready=null;
async function ensure(){if(!ready)ready=(async()=>{await core.ensureReady();const c=await pool.connect();try{await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(18202,2027)");for(const sql of statements)await c.query(sql);await c.query("COMMIT")}catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}})().catch(e=>{ready=null;throw e});return ready}
function json(res,status,body){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(JSON.stringify(body))}
async function read(req){let size=0;const bufs=[];for await(const p of req){size+=p.length;if(size>8000)throw Error("BODY_TOO_LARGE");bufs.push(p)}try{const a=JSON.parse(Buffer.concat(bufs).toString());if(!a||Array.isArray(a)||typeof a!=="object")throw Error();return a}catch{throw Error("INVALID_JSON")}}
const fields="id,user_id,kind,account,amount,status,reviewed_by,reviewed_at,review_note,created_at";
function serialize(row){return {id:String(row.id),kind:row.kind,account:row.account,amount:String(row.amount),status:row.status,reviewNote:row.review_note,createdAt:row.created_at,reviewedAt:row.reviewed_at}}
async function wallet(c,user){await c.query("INSERT INTO hf_wallets(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING",[user]);return (await c.query("SELECT futures_balance,stocks_balance FROM hf_wallets WHERE user_id=$1 FOR UPDATE",[user])).rows[0]}
async function append(c,id,request,account,delta){
 const col=account==="FUTURES"?"futures_balance":"stocks_balance";
 const upd=await c.query("UPDATE hf_wallets SET "+col+"="+col+"+$1,updated_at=NOW() WHERE user_id=$2 AND "+col+"+$1>=0 RETURNING "+col+" AS balance",[String(delta),id]);
 if(!upd.rowCount)throw Error("INSUFFICIENT_BALANCE");
 await c.query("INSERT INTO hf_wallet_ledger(user_id,request_id,account,delta,balance_after) VALUES($1,$2,$3,$4,$5)",[id,request,account,String(delta),String(upd.rows[0].balance)]);
}
async function route(req,res,url){
 const p=url.pathname;if(!p.startsWith("/api/wallet/")&&!p.startsWith("/api/admin/funding"))return false;
 try{
  await ensure();
  if(req.method!=="GET"&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host){json(res,403,{error:"ORIGIN_MISMATCH"});return true}
  const u=await auth(req);if(!u){json(res,401,{error:"LOGIN_REQUIRED"});return true}
  const isAdmin=p.startsWith("/api/admin/");
  if(isAdmin&&u.role!=="ADMIN"){json(res,403,{error:"ADMIN_REQUIRED"});return true}
  const b=req.method==="POST"?await read(req):{};
  if(p==="/api/wallet/status"&&req.method==="GET"){
   await pool.query("INSERT INTO hf_wallets(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING",[u.id]);
   const r=(await pool.query("SELECT futures_balance,stocks_balance,updated_at FROM hf_wallets WHERE user_id=$1",[u.id])).rows[0];
   const pending=await pool.query("SELECT account,COALESCE(SUM(amount),0)::bigint AS amount FROM hf_funding_requests WHERE user_id=$1 AND kind='WITHDRAW' AND status='PENDING' GROUP BY account",[u.id]);
   return json(res,200,{futuresBalance:String(r.futures_balance),stocksBalance:String(r.stocks_balance),pendingWithdrawals:Object.fromEntries(pending.rows.map(x=>[x.account,String(x.amount)])),updatedAt:r.updated_at}),true;
  }
  if(p==="/api/wallet/requests"&&req.method==="GET"){
   const r=await pool.query("SELECT "+fields+" FROM hf_funding_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 100",[u.id]);
   return json(res,200,{items:r.rows.map(serialize)}),true;
  }
  if(p==="/api/wallet/requests"&&req.method==="POST"){
   const kind=String(b.kind||""),account=String(b.account||""),amount=Number(b.amount),key=String(b.requestKey||"");
   if(!["DEPOSIT","WITHDRAW","TRANSFER"].includes(kind)||!["FUTURES","STOCKS"].includes(account)||!Number.isSafeInteger(amount)||amount<1000||amount>1e9||!/^[0-9a-f-]{36}$/i.test(key)){json(res,400,{error:"INVALID_REQUEST"});return true}
   const c=await pool.connect();let newId,finalStatus;
   try{
    await c.query("BEGIN");const w=await wallet(c,u.id);
    const ex=await c.query("SELECT id,kind,account,amount,status FROM hf_funding_requests WHERE user_id=$1 AND request_key=$2",[u.id,key]);
    if(ex.rowCount){
     const row=ex.rows[0];
     if(row.kind!==kind||row.account!==account||Number(row.amount)!==amount){await c.query("ROLLBACK");return json(res,409,{error:"IDEMPOTENCY_CONFLICT"}),true}
     await c.query("COMMIT");return json(res,200,{ok:true,id:String(row.id),status:row.status,duplicate:true}),true;
    }
    if(kind!=="DEPOSIT"){
     const col=account==="FUTURES"?"futures_balance":"stocks_balance";
     const balance=BigInt(w[col]);
     const pending=await c.query("SELECT COALESCE(SUM(amount),0)::bigint AS amount FROM hf_funding_requests WHERE user_id=$1 AND account=$2 AND kind='WITHDRAW' AND status='PENDING'",[u.id,account]);
     if(balance-BigInt(pending.rows[0].amount)<BigInt(amount)){await c.query("ROLLBACK");return json(res,409,{error:"INSUFFICIENT_BALANCE"}),true}
    }
    const status=kind==="TRANSFER"?"APPROVED":"PENDING";
    const r=await c.query("INSERT INTO hf_funding_requests(user_id,kind,account,amount,status,request_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[u.id,kind,account,amount,status,key]);
    newId=r.rows[0].id;finalStatus=status;
    if(kind==="TRANSFER"){await append(c,u.id,newId,account,-BigInt(amount));await append(c,u.id,newId,account==="FUTURES"?"STOCKS":"FUTURES",BigInt(amount))}
    await c.query("INSERT INTO hf_audit(actor_id,action,target) VALUES($1,$2,$3)",[u.id,"FUNDING_"+kind,String(newId)]);
    await c.query("COMMIT");
   }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
   return json(res,201,{ok:true,id:String(newId),status:finalStatus}),true;
  }
  if(p==="/api/admin/funding"&&req.method==="GET"){
   const r=await pool.query("SELECT f.*,u.username,u.full_name FROM hf_funding_requests f JOIN hf_users u ON u.id=f.user_id ORDER BY CASE WHEN f.status='PENDING' THEN 0 ELSE 1 END,f.id DESC LIMIT 250");
   return json(res,200,{items:r.rows.map(x=>({...serialize(x),username:x.username,name:x.full_name}))}),true;
  }
  const match=p.match(/^\/api\/admin\/funding\/(\d+)\/decision$/);
  if(match&&req.method==="POST"){
   const decision=String(b.decision||""),note=String(b.note||"").trim();
   if(!["APPROVED","REJECTED"].includes(decision)||note.length>500||(decision==="APPROVED"&&b.verified!==true)){json(res,400,{error:"CONFIRM_VERIFICATION_REQUIRED"});return true}
   const c=await pool.connect();
   try{
    await c.query("BEGIN");
    const r=await c.query("SELECT * FROM hf_funding_requests WHERE id=$1 FOR UPDATE",[match[1]]);
    if(!r.rowCount){await c.query("ROLLBACK");return json(res,404,{error:"REQUEST_NOT_FOUND"}),true}
    const x=r.rows[0];
    if(x.status!=="PENDING"){await c.query("ROLLBACK");return json(res,409,{error:"ALREADY_REVIEWED"}),true}
    await wallet(c,x.user_id);
    if(decision==="APPROVED"){
     if(x.kind==="TRANSFER")throw Error("INVALID_FUNDING_STATE");
     if(x.kind==="DEPOSIT")await append(c,x.user_id,x.id,x.account,BigInt(x.amount));
     if(x.kind==="WITHDRAW")await append(c,x.user_id,x.id,x.account,-BigInt(x.amount));
    }
    await c.query("UPDATE hf_funding_requests SET status=$1,reviewed_by=$2,reviewed_at=NOW(),review_note=$3 WHERE id=$4",[decision,u.id,note,x.id]);
    await c.query("INSERT INTO hf_audit(actor_id,action,target) VALUES($1,$2,$3)",[u.id,"FUNDING_"+decision,String(x.id)]);
    await c.query("COMMIT");
   }catch(e){await c.query("ROLLBACK").catch(()=>{});if(e.message==="INSUFFICIENT_BALANCE"){json(res,409,{error:"INSUFFICIENT_BALANCE"});return true}throw e}finally{c.release()}
   return json(res,200,{ok:true}),true;
  }
  json(res,404,{error:"NOT_FOUND"});return true;
 }catch(e){
  console.error("FUNDING_API_ERROR",String(e.message).slice(0,80));
  json(res,["BODY_TOO_LARGE","INVALID_JSON"].includes(e.message)?400:503,{error:["BODY_TOO_LARGE","INVALID_JSON"].includes(e.message)?e.message:"SERVICE_UNAVAILABLE"});return true;
 }
}
module.exports={route,ensure};
