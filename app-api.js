"use strict";
const {Pool}=require("pg");
const {randomBytes,scrypt:rawScrypt,createHash,timingSafeEqual,createCipheriv}=require("node:crypto");
const {promisify}=require("node:util");
const scrypt=promisify(rawScrypt);
function encryptAccount(value){
 const hex=String(process.env.HFM_ACCOUNT_ENCRYPTION_KEY||"");
 if(!/^[a-f0-9]{64}$/i.test(hex))throw Error("ACCOUNT_ENCRYPTION_NOT_CONFIGURED");
 const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",Buffer.from(hex,"hex"),iv);
 const body=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
 return ["v1",iv.toString("hex"),cipher.getAuthTag().toString("hex"),body.toString("hex")].join(":");
}
function parseBirthday(v){
 const s=String(v||"").trim(),match=/^(\d{4})(\d{2})(\d{2})$/.exec(s);
 if(!match)return null;
 const y=Number(match[1]),m=Number(match[2]),d=Number(match[3]);
 const date=new Date(Date.UTC(y,m-1,d));
 if(date.getUTCFullYear()!==y||date.getUTCMonth()+1!==m||date.getUTCDate()!==d)return null;
 const now=new Date(),min=new Date(Date.UTC(now.getUTCFullYear()-120,now.getUTCMonth(),now.getUTCDate()));
 if(date>now||date<min)return null;
 return s.slice(0,4)+"-"+s.slice(4,6)+"-"+s.slice(6,8);
}

const pool=new Pool({connectionString:process.env.DATABASE_URL,max:6,connectionTimeoutMillis:8000});
let initializing=null;
const tables=[
"CREATE TABLE IF NOT EXISTS hf_users(id BIGSERIAL PRIMARY KEY, username VARCHAR(32) UNIQUE NOT NULL, password_hash TEXT NOT NULL, full_name VARCHAR(80) NOT NULL, phone VARCHAR(24) NOT NULL, referral VARCHAR(40) NOT NULL DEFAULT '', role VARCHAR(12) NOT NULL DEFAULT 'MEMBER' CHECK(role IN ('MEMBER','ADMIN')), status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','FROZEN')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS hf_member_profiles(user_id BIGINT PRIMARY KEY REFERENCES hf_users(id) ON DELETE CASCADE,birth_date DATE,manager_name VARCHAR(80) NOT NULL DEFAULT '',bank_name VARCHAR(80) NOT NULL DEFAULT '',bank_account_cipher TEXT,bank_account_last4 VARCHAR(4) NOT NULL DEFAULT '',account_holder VARCHAR(80) NOT NULL DEFAULT '',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS hf_sessions(token_hash CHAR(64) PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES hf_users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS hf_sessions_user ON hf_sessions(user_id)",
"CREATE TABLE IF NOT EXISTS hf_notices(id BIGSERIAL PRIMARY KEY, title VARCHAR(160) NOT NULL, body TEXT NOT NULL, pinned BOOLEAN NOT NULL DEFAULT FALSE, visible BOOLEAN NOT NULL DEFAULT TRUE, author_id BIGINT REFERENCES hf_users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS hf_notices_sort ON hf_notices(visible,pinned DESC,created_at DESC)",
"CREATE TABLE IF NOT EXISTS hf_support(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES hf_users(id) ON DELETE CASCADE,sender VARCHAR(12) NOT NULL CHECK(sender IN ('MEMBER','ADMIN')),message VARCHAR(3000) NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS hf_support_user ON hf_support(user_id,id)",
"CREATE TABLE IF NOT EXISTS hf_audit(id BIGSERIAL PRIMARY KEY,actor_id BIGINT REFERENCES hf_users(id),action VARCHAR(80) NOT NULL,target VARCHAR(120),detail JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
];
async function passHash(pass){const salt=randomBytes(16).toString("hex"),hash=await scrypt(pass,salt,64);return "scrypt$"+salt+"$"+hash.toString("hex")}
async function verify(pass,stored){try{const [alg,salt,hex]=stored.split("$");if(alg!=="scrypt"||!/^[a-f0-9]{128}$/.test(hex))return false;return timingSafeEqual(await scrypt(pass,salt,64),Buffer.from(hex,"hex"))}catch{return false}}
async function initialize(){
 if(!process.env.DATABASE_URL)throw Error("DATABASE_URL_MISSING");
 const c=await pool.connect();
 try{
  await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(18202,2026)");
  for(const sql of tables)await c.query(sql);
  const id=String(process.env.HFM_BOOTSTRAP_ADMIN_ID||"").toLowerCase(),pwd=String(process.env.HFM_BOOTSTRAP_ADMIN_PASSWORD||"");
  if(/^[a-z0-9_]{4,32}$/.test(id)&&pwd.length>=16){
   const row=await c.query("SELECT id FROM hf_users WHERE username=$1",[id]);
   if(!row.rowCount){await c.query("INSERT INTO hf_users(username,password_hash,full_name,phone,role) VALUES($1,$2,'본사 관리자','미등록','ADMIN')",[id,await passHash(pwd)]);console.log("HFM_ADMIN_CREATED")}
  }
  await c.query("COMMIT");
 }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e}finally{c.release()}
}
function ensureReady(){if(!initializing)initializing=initialize().catch(e=>{initializing=null;throw e});return initializing}
function send(res,status,data,headers={}){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...headers});res.end(JSON.stringify(data))}
async function bodyOf(req){const parts=[];let size=0;for await(const p of req){size+=p.length;if(size>16384)throw Error("BODY_TOO_LARGE");parts.push(p)}try{const o=JSON.parse(Buffer.concat(parts).toString());if(!o||typeof o!=="object"||Array.isArray(o))throw Error();return o}catch{throw Error("INVALID_JSON")}}
const cookie=req=>String(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("hf_session="))?.slice(11)||"";
const hash=x=>createHash("sha256").update(x).digest("hex");
const cookieHeader=t=>"hf_session="+t+"; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800";
const noCookie="hf_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
const projection=u=>({id:String(u.id),username:u.username,name:u.full_name,phone:u.phone,referral:u.referral,role:u.role,status:u.status,createdAt:u.created_at});
async function auth(req){
 const token=cookie(req);if(!/^[a-f0-9]{64}$/.test(token))return null;
 const q=await pool.query("SELECT u.id,u.username,u.full_name,u.phone,u.referral,u.role,u.status,u.created_at FROM hf_sessions s JOIN hf_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.status='ACTIVE'",[hash(token)]);
 const row=q.rows[0]||null;
 if(!row)return null;
 const blocked=await pool.query("SELECT login_blocked FROM hf_member_restrictions WHERE user_id=$1",[row.id]);
 return blocked.rows[0]?.login_blocked?null:row;
}
const attempts=new Map();
const attemptKey=(req,id)=>req.socket.remoteAddress+":"+id;
function lockout(req,id){
 const key=attemptKey(req,id),v=attempts.get(key);return !!(v&&Date.now()-v.start<600000&&v.count>=10)
}
function fail(req,id){
 const key=attemptKey(req,id),v=attempts.get(key);const current=v&&Date.now()-v.start<600000?v:{count:0,start:Date.now()};
 current.count++;attempts.set(key,current);if(attempts.size>2000)attempts.clear();
}
const notices=x=>({id:String(x.id),title:x.title,body:x.body,pinned:x.pinned,visible:x.visible,createdAt:x.created_at,updatedAt:x.updated_at});
async function audit(actor,action,target=""){await pool.query("INSERT INTO hf_audit(actor_id,action,target) VALUES($1,$2,$3)",[actor,action,target])}
async function route(req,res,url){
 const p=url.pathname;
 if(!/^(\/api\/auth\/|\/api\/account\/|\/api\/notices$|\/api\/admin\/|\/api\/support\/)/.test(p))return false;
 try{
  await ensureReady();
  const m=req.method,origin=req.headers.origin;
  if(m!=="GET"&&origin&&new URL(origin).host!==req.headers.host){send(res,403,{error:"ORIGIN_MISMATCH"});return true}
  const b=m==="GET"||m==="DELETE"?{}:await bodyOf(req);
  if(p==="/api/auth/register"&&m==="POST"){
   const id=String(b.id||"").toLowerCase(),pwd=String(b.password||""),confirm=String(b.passwordConfirm||""),
     name=String(b.name||"").trim(),phone=String(b.phone||"").replace(/[-\s]/g,""),
     manager=String(b.managerName||"").trim(),birthday=parseBirthday(b.birthDate),
     bank=String(b.bank||"").trim(),number=String(b.accountNumber||"").replace(/[\s-]/g,""),holder=String(b.accountHolder||"").trim();
   if(!/^[a-z0-9_]{4,32}$/.test(id)||pwd.length<10||pwd.length>128||confirm!==pwd||
      name.length<2||name.length>80||!/^(?:010\d{8}|01[16789]\d{7,8})$/.test(phone)||
      !birthday||manager.length>80||!bank||bank.length>80||!/^[0-9]{8,20}$/.test(number)||
      !holder||holder.length>80||b.agree!==true){
    send(res,400,{error:"INVALID_REGISTRATION"});return true;
   }
   const encrypted=encryptAccount(number),passwordHash=await passHash(pwd),client=await pool.connect();
   try{
    await client.query("BEGIN");
    const row=await client.query("INSERT INTO hf_users(username,password_hash,full_name,phone,referral) VALUES($1,$2,$3,$4,'') RETURNING id",[id,passwordHash,name,phone]);
    const userId=row.rows[0].id;
    await client.query("INSERT INTO hf_member_profiles(user_id,birth_date,manager_name,bank_name,bank_account_cipher,bank_account_last4,account_holder) VALUES($1,$2,$3,$4,$5,$6,$7)",
       [userId,birthday,manager,bank,encrypted,number.slice(-4),holder]);
    await client.query("INSERT INTO hf_audit(actor_id,action,target) VALUES($1,'REGISTER',$2)",[userId,String(userId)]);
    await client.query("COMMIT");send(res,201,{ok:true});return true;
   }catch(e){
    await client.query("ROLLBACK").catch(()=>{});
    if(e.code==="23505"){send(res,409,{error:"DUPLICATE_USERNAME"});return true}
    throw e;
   }finally{client.release()}
  }
  if(p==="/api/auth/login"&&m==="POST"){
   const id=String(b.id||"").toLowerCase(),pwd=String(b.password||"");
   if(lockout(req,id)){send(res,429,{error:"TOO_MANY_ATTEMPTS"});return true}
   const row=(await pool.query("SELECT * FROM hf_users WHERE username=$1",[id])).rows[0];
   if(!row||!await verify(pwd,row.password_hash)){fail(req,id);send(res,401,{error:"INVALID_LOGIN"});return true}
   if(row.status!=="ACTIVE"){send(res,403,{error:"ACCOUNT_FROZEN"});return true}
   const blocked=await pool.query("SELECT login_blocked FROM hf_member_restrictions WHERE user_id=$1",[row.id]);
   if(blocked.rows[0]?.login_blocked){send(res,403,{error:"ACCOUNT_FROZEN"});return true}
   const token=randomBytes(32).toString("hex");
   await pool.query("INSERT INTO hf_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')",[hash(token),row.id]);
   send(res,200,{ok:true,user:projection(row)},{"Set-Cookie":cookieHeader(token)});return true;
  }
  if(p==="/api/auth/logout"&&m==="POST"){
   const tok=cookie(req);if(tok)await pool.query("DELETE FROM hf_sessions WHERE token_hash=$1",[hash(tok)]);
   send(res,200,{ok:true},{"Set-Cookie":noCookie});return true;
  }
  const user=await auth(req);
  if(p==="/api/auth/me"&&m==="GET"){send(res,200,{authenticated:!!user,user:user?projection(user):null});return true}
  if(p==="/api/notices"&&m==="GET"){
   const rows=await pool.query("SELECT * FROM hf_notices WHERE visible=TRUE ORDER BY pinned DESC,created_at DESC LIMIT 100");
   send(res,200,{items:rows.rows.map(notices)});return true;
  }
  if(!user){send(res,401,{error:"LOGIN_REQUIRED"});return true}
  if(p==="/api/account/profile"&&m==="GET"){send(res,200,{user:projection(user)});return true}
  if(p==="/api/account/password"&&m==="POST"){
   const curr=String(b.currentPassword||""),next=String(b.newPassword||"");
   if(next.length<10||next.length>128){send(res,400,{error:"INVALID_PASSWORD"});return true}
   const ph=(await pool.query("SELECT password_hash FROM hf_users WHERE id=$1",[user.id])).rows[0].password_hash;
   if(!await verify(curr,ph)){send(res,403,{error:"CURRENT_PASSWORD_INVALID"});return true}
   const c=await pool.connect();try{await c.query("BEGIN");await c.query("UPDATE hf_users SET password_hash=$1,updated_at=NOW() WHERE id=$2",[await passHash(next),user.id]);await c.query("DELETE FROM hf_sessions WHERE user_id=$1",[user.id]);await c.query("COMMIT")}catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
   await audit(user.id,"PASSWORD_CHANGED");send(res,200,{ok:true},{"Set-Cookie":noCookie});return true;
  }
  if(p==="/api/support/messages"&&m==="GET"){
   const r=await pool.query("SELECT id,sender,message,created_at FROM hf_support WHERE user_id=$1 ORDER BY id DESC LIMIT 100",[user.id]);
   send(res,200,{items:r.rows.reverse()});return true;
  }
  if(p==="/api/support/messages"&&m==="POST"){
   const message=String(b.message||"").trim();
   if(!message||message.length>3000){send(res,400,{error:"INVALID_MESSAGE"});return true}
   await pool.query("INSERT INTO hf_support(user_id,sender,message) VALUES($1,'MEMBER',$2)",[user.id,message]);send(res,201,{ok:true});return true;
  }
  if(!p.startsWith("/api/admin/")||user.role!=="ADMIN"){send(res,403,{error:"ADMIN_REQUIRED"});return true}
  if(p==="/api/admin/overview"&&m==="GET"){
   const q=await pool.query("SELECT (SELECT COUNT(*) FROM hf_users)::int members,(SELECT COUNT(*) FROM hf_users WHERE status='ACTIVE')::int active,(SELECT COUNT(*) FROM hf_notices)::int notices,(SELECT COUNT(*) FROM hf_support)::int messages");
   send(res,200,q.rows[0]);return true;
  }
  if(p==="/api/admin/members"&&m==="GET"){
   const q=(url.searchParams.get("q")||"").slice(0,50);
   const r=await pool.query("SELECT id,username,full_name,phone,referral,role,status,created_at FROM hf_users WHERE $1='' OR username ILIKE '%'||$1||'%' OR full_name ILIKE '%'||$1||'%' ORDER BY id DESC LIMIT 100",[q]);
   send(res,200,{items:r.rows.map(projection)});return true;
  }
  const st=p.match(/^\/api\/admin\/members\/(\d+)\/status$/);
  if(st&&m==="POST"){
   if(!["FROZEN","ACTIVE"].includes(b.status)||String(user.id)===st[1]){send(res,400,{error:"INVALID_STATUS"});return true}
   const c=await pool.connect();try{await c.query("BEGIN");const r=await c.query("UPDATE hf_users SET status=$1,updated_at=NOW() WHERE id=$2 AND role='MEMBER' RETURNING id",[b.status,st[1]]);if(!r.rowCount){await c.query("ROLLBACK");send(res,404,{error:"MEMBER_NOT_FOUND"});return true}if(b.status==="FROZEN")await c.query("DELETE FROM hf_sessions WHERE user_id=$1",[st[1]]);await c.query("INSERT INTO hf_audit(actor_id,action,target) VALUES($1,$2,$3)",[user.id,"MEMBER_STATUS_"+b.status,st[1]]);await c.query("COMMIT")}catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
   send(res,200,{ok:true});return true;
  }
  if(p==="/api/admin/notices"&&m==="GET"){
   const r=await pool.query("SELECT * FROM hf_notices ORDER BY pinned DESC,created_at DESC LIMIT 200");send(res,200,{items:r.rows.map(notices)});return true;
  }
  if(p==="/api/admin/notices"&&m==="POST"){
   const title=String(b.title||"").trim(),body=String(b.body||"").trim();if(!title||title.length>160||!body||body.length>10000){send(res,400,{error:"INVALID_NOTICE"});return true}
   const r=await pool.query("INSERT INTO hf_notices(title,body,pinned,visible,author_id) VALUES($1,$2,$3,$4,$5) RETURNING id",[title,body,b.pinned===true,b.visible!==false,user.id]);
   await audit(user.id,"NOTICE_CREATED",String(r.rows[0].id));send(res,201,{ok:true,id:String(r.rows[0].id)});return true;
  }
  const n=p.match(/^\/api\/admin\/notices\/(\d+)$/);
  if(n&&m==="PATCH"){
   const title=String(b.title||"").trim(),body=String(b.body||"").trim();if(!title||title.length>160||!body||body.length>10000){send(res,400,{error:"INVALID_NOTICE"});return true}
   const r=await pool.query("UPDATE hf_notices SET title=$1,body=$2,pinned=$3,visible=$4,updated_at=NOW() WHERE id=$5 RETURNING id",[title,body,b.pinned===true,b.visible!==false,n[1]]);
   if(!r.rowCount){send(res,404,{error:"NOTICE_NOT_FOUND"});return true}await audit(user.id,"NOTICE_UPDATED",n[1]);send(res,200,{ok:true});return true;
  }
  if(n&&m==="DELETE"){
   const r=await pool.query("DELETE FROM hf_notices WHERE id=$1 RETURNING id",[n[1]]);if(!r.rowCount){send(res,404,{error:"NOTICE_NOT_FOUND"});return true}await audit(user.id,"NOTICE_DELETED",n[1]);send(res,200,{ok:true});return true;
  }
  if(p==="/api/admin/support"&&m==="GET"){
   const r=await pool.query("SELECT u.id,u.username,u.full_name,COUNT(s.id)::int messages,MAX(s.created_at) last_at FROM hf_users u JOIN hf_support s ON s.user_id=u.id GROUP BY u.id ORDER BY last_at DESC LIMIT 100");
   send(res,200,{items:r.rows.map(x=>({userId:String(x.id),username:x.username,name:x.full_name,messages:x.messages,lastAt:x.last_at}))});return true;
  }
  const thread=p.match(/^\/api\/admin\/support\/(\d+)$/);
  if(thread&&m==="GET"){const r=await pool.query("SELECT id,sender,message,created_at FROM hf_support WHERE user_id=$1 ORDER BY id DESC LIMIT 100",[thread[1]]);send(res,200,{items:r.rows.reverse()});return true}
  if(thread&&m==="POST"){const message=String(b.message||"").trim();if(!message||message.length>3000){send(res,400,{error:"INVALID_MESSAGE"});return true}const r=await pool.query("INSERT INTO hf_support(user_id,sender,message) SELECT id,'ADMIN',$2 FROM hf_users WHERE id=$1 RETURNING id",[thread[1],message]);if(!r.rowCount){send(res,404,{error:"MEMBER_NOT_FOUND"});return true}await audit(user.id,"SUPPORT_REPLY",thread[1]);send(res,201,{ok:true});return true}
  send(res,404,{error:"NOT_FOUND"});return true;
 }catch(e){
  const message=String(e.message||"SERVICE_UNAVAILABLE");
  console.error("APP_API_ERROR",message.slice(0,80));
  send(res,["INVALID_JSON","BODY_TOO_LARGE"].includes(message)?400:503,{error:["INVALID_JSON","BODY_TOO_LARGE"].includes(message)?message:"SERVICE_UNAVAILABLE"});return true;
 }
}
module.exports={route,ensureReady,pool,auth,audit,passHash,encryptAccount,parseBirthday};
