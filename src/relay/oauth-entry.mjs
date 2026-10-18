/**
 * OAuth 2.1 PKCE entry/callback for Flow as an OrdaX Platform relying party.
 *
 * This is NOT an identity provider or user database. Production MUST inject:
 *  - durable atomic transactionStore (put/take), not an in-memory singleton;
 *  - completeAccountLogin, owned by the canonical OrdaX Platform, which
 *    exchanges the one-time code, validates the authenticated account and
 *    issues a centrally verifiable opaque session handle.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const STATE_COOKIE='__Host-ordax_flow_oauth';
const SESSION_COOKIE='__Host-ordax_flow_session';
const STATE_RE=/^[A-Za-z0-9_-]{43,64}$/;
const SESSION_RE=/^[A-Za-z0-9_-]{32,256}$/;
const ID_RE=/^[A-Za-z0-9._~-]{3,256}$/;
const MAX_AGE_SECONDS=600;

function originOf(value,allowLoopbackHttp=false){
  if(typeof value!=='string')throw new TypeError('oauth_origin_required');
  let u;
  try{u=new URL(value);}catch{throw new TypeError('oauth_origin_invalid');}
  const local=allowLoopbackHttp===true&&u.protocol==='http:'&&
    ['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  if(u.protocol!=='https:'&&!local)throw new TypeError('oauth_https_required');
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!u.hostname)
    throw new TypeError('oauth_origin_only');
  return u.origin;
}
function platformIssuer(value,allowLoopbackHttp=false){
  let u;
  try{u=new URL(value);}catch{throw new TypeError('oauth_issuer_invalid');}
  if(u.pathname!=='/auth/v1'||u.search||u.hash||u.username||u.password)
    throw new TypeError('oauth_issuer_invalid');
  const origin=originOf(u.origin,allowLoopbackHttp);
  return origin+'/auth/v1';
}
const b64=value=>Buffer.from(value).toString('base64url');
const digest=value=>createHash('sha256').update(value,'utf8').digest('base64url');
const ctEqual=(a,b)=>{
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length&&timingSafeEqual(x,y);
};
const noStore={'cache-control':'no-store','x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer'};
const baseCookie='; Path=/; HttpOnly; Secure; SameSite=Lax';
function json(response,code,body,more={}){
  response.writeHead(code,{...noStore,'content-type':'application/json; charset=utf-8',...more});
  response.end(JSON.stringify(body));
}
function redirect(response,location,cookies=[]){
  response.writeHead(303,{...noStore,location,...(cookies.length?{'set-cookie':cookies}:{})});
  response.end();
}

/**
 * Exact registered callback: <publicOrigin>/auth/callback
 * start?app accepts ONLY client|hub. No arbitrary return URLs or user claims.
 */
export function createFlowOAuthHandler({
  issuer,publicOrigin,clientId,transactionStore,completeAccountLogin,
  allowLoopbackHttp=false,clock=()=>Date.now(),random=randomBytes
}){
  const base=originOf(publicOrigin,allowLoopbackHttp);
  const authority=platformIssuer(issuer,allowLoopbackHttp);
  if(typeof clientId!=='string'||!ID_RE.test(clientId)||!transactionStore||
      typeof transactionStore.put!=='function'||typeof transactionStore.take!=='function'||
      typeof completeAccountLogin!=='function'||typeof clock!=='function'||
      typeof random!=='function'){
    throw new TypeError('oauth_canonical_ports_required');
  }
  const callback=base+'/auth/callback';
  return async function handleOAuth(request,response,next){
    const u=new URL(request.url||'/',base);
    const pathname=u.pathname;
    if(pathname==='/v1/auth/config'){
      if(request.method!=='GET')return json(response,405,{error:'method_not_allowed'});
      return json(response,200,{loginAvailable:true});
    }
    if(pathname!=='/auth/start'&&pathname!=='/auth/callback')
      return next(request,response);
    if(request.method!=='GET')return json(response,405,{error:'method_not_allowed'});

    if(pathname==='/auth/start'){
      const app=u.searchParams.get('app')||'client';
      if(!['client','hub'].includes(app)||u.searchParams.getAll('app').length>1||
         [...u.searchParams.keys()].some(k=>k!=='app'))
        return json(response,400,{error:'invalid_login_target'});
      const state=b64(random(32)),verifier=b64(random(32));
      if(!STATE_RE.test(state)||!STATE_RE.test(verifier))
        return json(response,503,{error:'oauth_entropy_unavailable'});
      const expiresAtUnix=Math.floor(clock()/1000)+MAX_AGE_SECONDS;
      try {
        await transactionStore.put({key:digest(state),verifier,returnPath:
          app==='hub'?'/hub':'/client',expiresAtUnix});
      }catch{return json(response,503,{error:'login_temporarily_unavailable'});}
      const authorize=new URL(authority+'/oauth/authorize');
      authorize.search=new URLSearchParams({
        response_type:'code',client_id:clientId,redirect_uri:callback,
        state,code_challenge:digest(verifier),code_challenge_method:'S256',
        scope:'email'
      }).toString();
      return redirect(response,authorize.href,
        [STATE_COOKIE+'='+state+baseCookie+'; Max-Age='+MAX_AGE_SECONDS]);
    }

    // Callback must be bound to the browser which initiated this transaction.
    const code=u.searchParams.get('code'),state=u.searchParams.get('state');
    const error=u.searchParams.get('error');
    const cookie=String(request.headers.cookie||'');
    const cookies=cookie.split(';').map(p=>p.trim()).filter(p=>p.startsWith(STATE_COOKIE+'='));
    const browserState=cookies.length===1?cookies[0].slice(STATE_COOKIE.length+1):'';
    const clear=STATE_COOKIE+'='+baseCookie+'; Max-Age=0';
    if(!STATE_RE.test(state||'')||!STATE_RE.test(browserState)||!ctEqual(state,browserState))
      return json(response,400,{error:'oauth_state_invalid'},{'set-cookie':[clear]});
    // Only one terminal form: code OR error, with no extra duplicated params.
    if(u.searchParams.getAll('state').length!==1||
       u.searchParams.getAll('code').length>1||u.searchParams.getAll('error').length>1||
       [...u.searchParams.keys()].some(k=>!['state','code','error','error_description'].includes(k))||
       (code&&error)||(!code&&!error))
      return json(response,400,{error:'oauth_callback_invalid'},{'set-cookie':[clear]});

    let transaction;
    try{transaction=await transactionStore.take({key:digest(state)});}
    catch{return json(response,503,{error:'login_temporarily_unavailable'},{'set-cookie':[clear]});}
    if(!transaction||!STATE_RE.test(transaction.verifier||'')||
       transaction.expiresAtUnix<=Math.floor(clock()/1000)||
       !['/hub','/client'].includes(transaction.returnPath))
      return json(response,400,{error:'oauth_transaction_expired'},{'set-cookie':[clear]});
    if(error)return json(response,403,{error:'oauth_authorization_denied'},{'set-cookie':[clear]});
    if(typeof code!=='string'||code.length<8||code.length>2048||
       !/^[A-Za-z0-9._~-]+$/.test(code))
      return json(response,400,{error:'oauth_code_invalid'},{'set-cookie':[clear]});

    try{
      // This backend port MUST exchange code+verifier at the canonical issuer,
      // validate resulting access token through Platform, and mint an opaque
      // server-side session in the existing Platform identity/session authority.
      const result=await completeAccountLogin({
        code,codeVerifier:transaction.verifier,clientId,redirectUri:callback,
        issuer:authority
      });
      if(result?.verified!==true||!SESSION_RE.test(result.sessionHandle||'')||
         !Number.isSafeInteger(result.expiresAtUnix)||
         result.expiresAtUnix<=Math.floor(clock()/1000)+30)
        throw Error('unverified_session');
      const maxAge=Math.min(3600,result.expiresAtUnix-Math.floor(clock()/1000));
      return redirect(response,base+transaction.returnPath,[
        clear,SESSION_COOKIE+'='+result.sessionHandle+baseCookie+'; Max-Age='+maxAge
      ]);
    }catch{
      return json(response,503,{error:'oauth_session_unavailable'},{'set-cookie':[clear]});
    }
  };
}

export const FLOW_OAUTH_COOKIES={state:STATE_COOKIE,session:SESSION_COOKIE};
