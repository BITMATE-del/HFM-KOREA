"use strict";
const core=require("./app-api"),funding=require("./funding-api"),calc=require("./settlement-core");
const {randomUUID}=require("node:crypto"),{pool,auth,passHash,encryptAccount,parseBirthday}=core;
const STATEMENTS=[
 "CREATE TABLE IF NOT EXISTS hf_admin_adjustments(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES hf_users(id),actor_id BIGINT NOT NULL REFERENCES hf_users(id),request_key UUID NOT NULL,account VARCHAR(12) NOT NULL CHECK(account IN ('FUTURES','STOCKS')),delta BIGINT NOT NULL CHECK(delta<>0),before_balance BIGINT NOT NULL,after_balance BIGINT NOT NULL CHECK(after_balance>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(actor_id,request_key))",
 "ALTER TABLE hf_wallet_ledger ALTER COLUMN request_id DROP NOT NULL",
 "ALTER TABLE hf_wallet_ledger ADD COLUMN IF NOT EXISTS admin_adjustment_id BIGINT UNIQUE REFERENCES hf_admin_adjustments(id)",
 "CREATE INDEX IF NOT EXISTS hf_admin_adjustments_user ON hf_admin_adjustments(user_id,created_at DESC)"
];
let ready;
async function ensure(){if(!ready)ready=(async()=>{await core.ensureReady();await funding.ensure();const c=await pool.connect();try{await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(18202,2030)");for(const sql of STATEMENTS)await c.query(sql);await c.query("COMMIT")}catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}})().catch(e=>{ready=null;throw e});return ready}
function json(res,status,data){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(data))}
async function body(req){let n=0;const parts=[];for await(const p of req){n+=p.length;if(n>16000)throw Error("BODY_TOO_LARGE");parts.push(p)}try{const b=JSON.parse(Buffer.concat(parts).toString());if(!b||Array.isArray(b)||typeof b!=="object")throw Error();return b}catch{throw Error("INVALID_JSON")}}
function cleanProfile(b,mode){
 const name=String(b.name||"").trim(),phone=String(b.phone||"").replace(/[-\s]/g,""),
  birth=b.birthDate?parseBirthday(b.birthDate):null,manager=String(b.managerName||"").trim(),
  bank=String(b.bank||"").trim(),holder=String(b.accountHolder||"").trim(),
  number=String(b.accountNumber||"").replace(/[\s-]/g,""),ref=String(b.referral||"").trim();
 if(name.length<2||name.length>80||!/^(?:010\d{8}|01[16789]\d{7,8})$/.test(phone)||
   (b.birthDate&&!birth)||manager.length>80||bank.length>80||holder.length>80||ref.length>40||
   (number&&!/^\d{8,20}$/.test(number)))throw Error("INVALID_MEMBER_INFO");
 if(mode==="create"&&(!birth||!bank||!number||!holder))throw Error("INVALID_MEMBER_INFO");
 return {name,phone,birth,manager,bank,holder,number,ref};
}
async function route(req,res,url){
 const p=url.pathname;if(!p.startsWith("/api/admin/member-tools/"))return false;
 try{
  await ensure();if(req.method!=="GET"&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return json(res,403,{error:"ORIGIN_MISMATCH"}),true;
  const actor=await auth(req);if(!actor||actor.role!=="ADMIN")return json(res,403,{error:"ADMIN_REQUIRED"}),true;
  const m=req.method,b=m==="GET"?{}:await body(req);
  if(p==="/api/admin/member-tools/create"&&m==="POST"){
   const id=String(b.username||"").trim().toLowerCase(),pw=String(b.password||"");
   if(!/^[a-z0-9_]{4,32}$/.test(id)||pw.length<10||pw.length>128)return json(res,400,{error:"INVALID_LOGIN_INFO"}),true;
   const info=cleanProfile(b,"create"),hash=await passHash(pw),encrypted=encryptAccount(info.number);
   const c=await pool.connect();try{
    await c.query("BEGIN");
    const q=await c.query("INSERT INTO hf_users(username,password_hash,full_name,phone,referral,role) VALUES($1,$2,$3,$4,$5,'MEMBER') RETURNING id",[id,hash,info.name,info.phone,info.ref]);
    const target=q.rows[0].id;
    await c.query("INSERT INTO hf_member_profiles(user_id,birth_date,manager_name,bank_name,bank_account_cipher,bank_account_last4,account_holder) VALUES($1,$2,$3,$4,$5,$6,$7)",[target,info.birth,info.manager,info.bank,encrypted,info.number.slice(-4),info.holder]);
    await c.query("INSERT INTO hf_wallets(user_id) VALUES($1)",[target]);
    await c.query("INSERT INTO hf_audit(actor_id,action,target) VALUES($1,'ADMIN_MEMBER_CREATE',$2)",[actor.id,String(target)]);
    await c.query("COMMIT");json(res,201,{ok:true,id:String(target)});return true;
   }catch(e){await c.query("ROLLBACK").catch(()=>{});if(e.code==="23505")return json(res,409,{error:"DUPLICATE_USERNAME"}),true;throw e}finally{c.release()}
  }
  const idMatch=p.match(/^\/api\/admin\/member-tools\/(\d+)(?:\/(edit|restrictions|balance|adjustments))?$/);
  if(!idMatch)return json(res,404,{error:"NOT_FOUND"}),true;
  const target=idMatch[1],action=idMatch[2]||"view";
  if(action==="view"&&m==="GET"){
   const q=await pool.query("SELECT u.id,u.username,u.full_name,u.phone,u.referral,u.role,u.status,p.birth_date,p.manager_name,p.bank_name,p.bank_account_last4,p.account_holder,r.login_blocked,r.futures_blocked,r.stocks_blocked,r.funding_blocked,w.futures_balance,w.stocks_balance FROM hf_users u LEFT JOIN hf_member_profiles p ON p.user_id=u.id LEFT JOIN hf_member_restrictions r ON r.user_id=u.id LEFT JOIN hf_wallets w ON w.user_id=u.id WHERE u.id=$1",[target]);
   if(!q.rowCount)return json(res,404,{error:"MEMBER_NOT_FOUND"}),true;
   const x=q.rows[0];
   return json(res,200,{member:{id:String(x.id),username:x.username,name:x.full_name,phone:x.phone,referral:x.referral,role:x.role,status:x.status,birthDate:x.birth_date?new Date(x.birth_date).toISOString().slice(0,10).replace(/-/g,""):"",managerName:x.manager_name||"",bank:x.bank_name||"",accountLast4:x.bank_account_last4||"",accountHolder:x.account_holder||"",futuresBalance:String(x.futures_balance||0),stocksBalance:String(x.stocks_balance||0),restrictions:{login:!!x.login_blocked,futures:!!x.futures_blocked,stocks:!!x.stocks_blocked,funding:!!x.funding_blocked}}}),true;
  }
  if(action==="edit"&&m==="PATCH"){
   const q=(await pool.query("SELECT role FROM hf_users WHERE id=$1",[target])).rows[0];
   if(!q||q.role!=="MEMBER")return json(res,403,{error:"MEMBER_ONLY"}),true;
   const info=cleanProfile(b,"edit"),pw=String(b.newPassword||"");
   if(pw&&(pw.length<10||pw.length>128))return json(res,400,{error:"INVALID_PASSWORD"}),true;
   const encrypted=info.number?encryptAccount(info.number):null;
   const hash=pw?await passHash(pw):null;
   const c=await pool.connect();try{await c.query("BEGIN");
    await c.query("UPDATE hf_users SET full_name=$1,phone=$2,referral=$3,password_hash=COALESCE($4,password_hash),updated_at=NOW() WHERE id=$5 AND role='MEMBER'",[info.name,info.phone,info.ref,hash,target]);
    await c.query("INSERT INTO hf_member_profiles(user_id,birth_date,manager_name,bank_name,account_holder,bank_account_cipher,bank_account_last4) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,'')) ON CONFLICT(user_id) DO UPDATE SET birth_date=EXCLUDED.birth_date,manager_name=EXCLUDED.manager_name,bank_name=EXCLUDED.bank_name,account_holder=EXCLUDED.account_holder,bank_account_cipher=COALESCE(EXCLUDED.bank_account_cipher,hf_member_profiles.bank_account_cipher),bank_account_last4=CASE WHEN EXCLUDED.bank_account_cipher IS NULL THEN hf_member_profiles.bank_account_last4 ELSE EXCLUDED.bank_account_last4 END,updated_at=NOW()",[target,info.birth,info.manager,info.bank,info.holder,encrypted,info.number?info.number.slice(-4):null]);
    if(hash)await c.query("DELETE FROM hf_sessions WHERE user_id=$1",[target]);
    await c.query("INSERT INTO hf_audit(actor_id,action,target) VALUES($1,'ADMIN_MEMBER_EDIT',$2)",[actor.id,target]);
    await c.query("COMMIT");return json(res,200,{ok:true}),true;
   }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
  }
  if(action==="restrictions"&&m==="POST"){
   const check=(key)=>typeof b[key]==="boolean";
   if(!["login","futures","stocks","funding"].every(check))return json(res,400,{error:"INVALID_RESTRICTIONS"}),true;
   const c=await pool.connect();
   try{await c.query("BEGIN");
    const q=await c.query("SELECT role FROM hf_users WHERE id=$1 FOR UPDATE",[target]);
    if(!q.rowCount||q.rows[0].role!=="MEMBER"){await c.query("ROLLBACK");return json(res,403,{error:"MEMBER_ONLY"}),true}
    await c.query("INSERT INTO hf_member_restrictions(user_id,login_blocked,futures_blocked,stocks_blocked,funding_blocked,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET login_blocked=EXCLUDED.login_blocked,futures_blocked=EXCLUDED.futures_blocked,stocks_blocked=EXCLUDED.stocks_blocked,funding_blocked=EXCLUDED.funding_blocked,updated_by=EXCLUDED.updated_by,updated_at=NOW()",[target,b.login,b.futures,b.stocks,b.funding,actor.id]);
    if(b.login)await c.query("DELETE FROM hf_sessions WHERE user_id=$1",[target]);
    await c.query("INSERT INTO hf_audit(actor_id,action,target,detail) VALUES($1,'ADMIN_MEMBER_RESTRICTIONS',$2,$3::jsonb)",[actor.id,target,JSON.stringify({login:b.login,futures:b.futures,stocks:b.stocks,funding:b.funding})]);
    await c.query("COMMIT");return json(res,200,{ok:true}),true;
   }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
  }
  if(action==="adjustments"&&m==="GET"){
   const q=await pool.query("SELECT id,account,delta,before_balance,after_balance,created_at FROM hf_admin_adjustments WHERE user_id=$1 ORDER BY id DESC LIMIT 40",[target]);
   return json(res,200,{items:q.rows.map(x=>({id:String(x.id),account:x.account,delta:String(x.delta),before:String(x.before_balance),after:String(x.after_balance),createdAt:x.created_at}))}),true;
  }
  if(action==="balance"&&m==="POST"){
   const account=String(b.account||""),delta=Number(b.delta),key=String(b.requestKey||"");
   if(!["FUTURES","STOCKS"].includes(account)||!Number.isSafeInteger(delta)||delta===0||Math.abs(delta)>1000000000||!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(key))return json(res,400,{error:"INVALID_ADJUSTMENT"}),true;
   const c=await pool.connect();
   try{
    await c.query("BEGIN");
    const member=await c.query("SELECT role FROM hf_users WHERE id=$1 FOR UPDATE",[target]);
    if(!member.rowCount||member.rows[0].role!=="MEMBER"){await c.query("ROLLBACK");return json(res,403,{error:"MEMBER_ONLY"}),true}
    await c.query("INSERT INTO hf_wallets(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING",[target]);
    const w=await c.query("SELECT * FROM hf_wallets WHERE user_id=$1 FOR UPDATE",[target]);
    const existing=await c.query("SELECT * FROM hf_admin_adjustments WHERE actor_id=$1 AND request_key=$2",[actor.id,key]);
    if(existing.rowCount){
     const e=existing.rows[0];if(String(e.user_id)!==target||e.account!==account||Number(e.delta)!==delta){await c.query("ROLLBACK");return json(res,409,{error:"IDEMPOTENCY_CONFLICT"}),true}
     await c.query("COMMIT");return json(res,200,{ok:true,duplicate:true,balance:String(e.after_balance)}),true;
    }
    const col=account==="FUTURES"?"futures_balance":"stocks_balance",before=BigInt(w.rows[0][col]),after=before+BigInt(delta);
    if(after<0n||after>1000000000000n){await c.query("ROLLBACK");return json(res,409,{error:"INVALID_FINAL_BALANCE"}),true}
    const pending=await c.query("SELECT COALESCE(SUM(amount),0)::bigint AS amount FROM hf_funding_requests WHERE user_id=$1 AND account=$2 AND kind='WITHDRAW' AND status='PENDING'",[target,account]);
    let locked=0n;
    if(account==="FUTURES"){
     const pos=await c.query("SELECT symbol,qty FROM hf_positions WHERE user_id=$1 AND product='FUTURES' AND state='OPEN'",[target]);
     for(const row of pos.rows)locked+=BigInt(calc.marginFor(row.symbol,row.qty));
    }
    if(delta<0&&after<BigInt(pending.rows[0].amount)+locked){await c.query("ROLLBACK");return json(res,409,{error:"FUNDS_RESERVED"}),true}
    const adjustment=await c.query("INSERT INTO hf_admin_adjustments(user_id,actor_id,request_key,account,delta,before_balance,after_balance) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",[target,actor.id,key,account,delta,String(before),String(after)]);
    const upd=await c.query("UPDATE hf_wallets SET "+col+"=$1,updated_at=NOW() WHERE user_id=$2 RETURNING "+col+" AS balance",[String(after),target]);
    await c.query("INSERT INTO hf_wallet_ledger(user_id,request_id,admin_adjustment_id,account,delta,balance_after) VALUES($1,NULL,$2,$3,$4,$5)",[target,adjustment.rows[0].id,account,delta,String(after)]);
    await c.query("INSERT INTO hf_audit(actor_id,action,target,detail) VALUES($1,'ADMIN_BALANCE_ADJUSTMENT',$2,$3::jsonb)",[actor.id,target,JSON.stringify({account,delta,adjustmentId:String(adjustment.rows[0].id)})]);
    await c.query("COMMIT");return json(res,200,{ok:true,balance:String(upd.rows[0].balance),adjustmentId:String(adjustment.rows[0].id)}),true;
   }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
  }
  return json(res,404,{error:"NOT_FOUND"}),true;
 }catch(e){
  console.error("MEMBER_ADMIN_ERROR",String(e.message).slice(0,75));
  if(["INVALID_MEMBER_INFO","INVALID_JSON","BODY_TOO_LARGE"].includes(e.message))return json(res,400,{error:e.message}),true;
  return json(res,503,{error:"SERVICE_UNAVAILABLE"}),true;
 }
}
module.exports={route,ensure};
