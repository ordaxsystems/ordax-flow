import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createFlowOAuthHandler, FLOW_OAUTH_COOKIES } from '../src/relay/oauth-entry.mjs';
import { createFlowPlatformGateway } from '../src/relay/platform-composition.mjs';

const LOCAL='http://127.0.0.1:9999';
const ISSUER='https://canonical-ordax-auth.supabase.co/auth/v1';
const USER='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const cookiePair=value=>value.split(';')[0];
const checksum=s=>createHash('sha256').update(s).digest('base64url');

function mockStore(){
  const values=new Map();
  return {
    values,
    async put(tx){if(values.has(tx.key))throw Error('duplicate_state');values.set(tx.key,tx);},
    async take({key}){const value=values.get(key);values.delete(key);return value||null;}
  };
}
async function open(handler){
  const server=http.createServer((req,res)=>handler(req,res,()=>{res.writeHead(404);res.end();}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const fetcher=(p,headers)=>fetch(origin+p,{redirect:'manual',headers});
  return {origin,fetcher,close:()=>new Promise(done=>server.close(done))};
}
function configured(opts={}){
  const store=mockStore();
  let completions=0;
  const login=createFlowOAuthHandler({
    issuer:ISSUER,publicOrigin:LOCAL,clientId:'ordax-flow-test-client',
    allowLoopbackHttp:true,transactionStore:store,
    completeAccountLogin:async({code,codeVerifier,clientId,redirectUri,issuer})=>{
      completions++;
      assert.equal(clientId,'ordax-flow-test-client');
      assert.equal(redirectUri,LOCAL+'/auth/callback');
      assert.equal(issuer,ISSUER);
      assert(codeVerifier.length>=43);
      if(opts.badLogin)return {verified:false,sessionHandle:'invalid'};
      return {verified:true,sessionHandle:'x'.repeat(48),
        expiresAtUnix:Math.floor(Date.now()/1000)+1800};
    }
  });
  return {login,store,getCompletions:()=>completions};
}
test('SSO login is disabled until registered client and canonical ports are configured',async()=>{
  assert.throws(()=>createFlowOAuthHandler({
    issuer:ISSUER,publicOrigin:'https://flow.example.test',clientId:'flow_test'
  }),/oauth_canonical_ports_required/);
  assert.throws(()=>createFlowOAuthHandler({
    issuer:'http://evil.example.test/auth/v1',publicOrigin:'https://flow.example.test',
    clientId:'flow_test',transactionStore:mockStore(),
    completeAccountLogin:async()=>({})
  }),/oauth_https_required/);
  assert.throws(()=>createFlowOAuthHandler({
    issuer:ISSUER,publicOrigin:'https://flow.example.test/redirect',
    clientId:'flow_test',transactionStore:mockStore(),
    completeAccountLogin:async()=>({})
  }),/oauth_origin_only/);
  const gateway=createFlowPlatformGateway({
    platformOrigin:'https://platform.example.test',
    publicOrigin:'https://flow.example.test',
    authenticateBrowserSession:async()=>null,
    authorizeTask:async()=>false,listProjects:async()=>[],
    authorizeHub:async()=>false,getHubOverview:async()=>({}),
    dispatch:async()=>({text:'not reached'}),
    idempotency:{execute:async(_k,_h,fn)=>fn()}
  });
  const app=await open(gateway);
  try{
    const availability=await app.fetcher('/v1/auth/config');
    assert.equal(availability.status,200);
    assert.deepEqual(await availability.json(),{loginAvailable:false});
    const start=await app.fetcher('/auth/start');
    assert.equal(start.status,404);
  }finally{await app.close();}
});
test('canonical OAuth start always uses S256 PKCE, exact callback, no arbitrary redirect',async()=>{
  const {login,store}=configured();
  const app=await open(login);
  try{
    const availability=await app.fetcher('/v1/auth/config');
    assert.deepEqual(await availability.json(),{loginAvailable:true});
    const blocked=await app.fetcher('/auth/start?app=client&redirect=https://evil.test');
    assert.equal(blocked.status,400);
    const invalid=await app.fetcher('/auth/start?app=admin');
    assert.equal(invalid.status,400);
    const start=await app.fetcher('/auth/start?app=hub');
    assert.equal(start.status,303);
    const location=new URL(start.headers.get('location'));
    assert.equal(location.href.split('?')[0],ISSUER+'/oauth/authorize');
    assert.equal(location.searchParams.get('response_type'),'code');
    assert.equal(location.searchParams.get('client_id'),'ordax-flow-test-client');
    assert.equal(location.searchParams.get('redirect_uri'),LOCAL+'/auth/callback');
    assert.equal(location.searchParams.get('code_challenge_method'),'S256');
    assert.equal(location.searchParams.get('scope'),'email');
    const state=location.searchParams.get('state');
    assert(state.length>=43);
    const record=store.values.get(checksum(state));
    assert.equal(record.returnPath,'/hub');
    assert.equal(location.searchParams.get('code_challenge'),checksum(record.verifier));
    assert.match(start.headers.get('set-cookie'),/__Host-ordax_flow_oauth=/);
    assert.match(start.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);
  }finally{await app.close();}
});
test('callback binds browser cookie to state, is one-use, sets only opaque session cookie',async()=>{
  const f=configured();
  const app=await open(f.login);
  try{
    const start=await app.fetcher('/auth/start?app=client');
    const state=new URL(start.headers.get('location')).searchParams.get('state');
    const cookie=cookiePair(start.headers.get('set-cookie'));
    const target='/auth/callback?code=valid_code_12345&state='+state;
    const missing=await app.fetcher(target);
    assert.equal(missing.status,400);
    const forged=await app.fetcher(target,{cookie:FLOW_OAUTH_COOKIES.state+'='+'z'.repeat(43)});
    assert.equal(forged.status,400);
    assert.equal(f.getCompletions(),0);
    const accepted=await app.fetcher(target,{cookie});
    assert.equal(accepted.status,303);
    assert.equal(accepted.headers.get('location'),LOCAL+'/client');
    const responseCookie=accepted.headers.get('set-cookie');
    assert(responseCookie.includes(FLOW_OAUTH_COOKIES.session+'='+'x'.repeat(48)));
    assert(!responseCookie.includes('valid_code_12345'));
    assert(!responseCookie.includes('ordax-flow-test-client'));
    assert.equal(f.getCompletions(),1);
    const replay=await app.fetcher(target,{cookie});
    assert.equal(replay.status,400);
    assert.equal(f.getCompletions(),1);
  }finally{await app.close();}
});
test('OAuth refusal and invalid canonical Platform session never authenticate the browser',async()=>{
  const f=configured({badLogin:true});
  const app=await open(f.login);
  try{
    const start=await app.fetcher('/auth/start');
    const state=new URL(start.headers.get('location')).searchParams.get('state');
    const cookie=cookiePair(start.headers.get('set-cookie'));
    const failure=await app.fetcher('/auth/callback?state='+state+'&code=valid_code_567890',{cookie});
    assert.equal(failure.status,503);
    assert(!String(failure.headers.get('set-cookie')).includes(FLOW_OAUTH_COOKIES.session));
    assert.equal(f.getCompletions(),1);
    const deniedStart=await app.fetcher('/auth/start');
    const deniedState=new URL(deniedStart.headers.get('location')).searchParams.get('state');
    const deniedCookie=cookiePair(deniedStart.headers.get('set-cookie'));
    const denied=await app.fetcher('/auth/callback?state='+deniedState+'&error=access_denied',{cookie:deniedCookie});
    assert.equal(denied.status,403);
    assert.equal(f.getCompletions(),1);
  }finally{await app.close();}
});
test('two user browsers get isolated transactions; cross-client callback cannot steal session',async()=>{
  const f=configured();
  const app=await open(f.login);
  try{
    const a=await app.fetcher('/auth/start');
    const b=await app.fetcher('/auth/start?app=hub');
    const aState=new URL(a.headers.get('location')).searchParams.get('state');
    const bState=new URL(b.headers.get('location')).searchParams.get('state');
    const ac=cookiePair(a.headers.get('set-cookie'));
    const bc=cookiePair(b.headers.get('set-cookie'));
    const wrong=await app.fetcher('/auth/callback?code=test_code_123456&state='+aState,{cookie:bc});
    assert.equal(wrong.status,400);
    const rightA=await app.fetcher('/auth/callback?code=test_code_123456&state='+aState,{cookie:ac});
    const rightB=await app.fetcher('/auth/callback?code=test_code_123457&state='+bState,{cookie:bc});
    assert.equal(rightA.headers.get('location'),LOCAL+'/client');
    assert.equal(rightB.headers.get('location'),LOCAL+'/hub');
    assert.equal(f.getCompletions(),2);
  }finally{await app.close();}
});


test('canonical Client and Hub composition enables the same OAuth entry only when officially configured',async()=>{
  const oauth={
    issuer:ISSUER,clientId:'ordax-flow-test-client',
    transactionStore:mockStore(),completeAccountLogin:async()=>{throw Error('no_test_session');}
  };
  const gateway=createFlowPlatformGateway({
    platformOrigin:'https://canonical-ordax-auth.supabase.co',
    publicOrigin:LOCAL,allowLoopbackHttp:true,
    authenticateBrowserSession:async()=>null,
    authorizeTask:async()=>false,listProjects:async()=>[],
    authorizeHub:async()=>false,getHubOverview:async()=>({}),
    dispatch:async()=>({text:'unused'}),
    idempotency:{execute:async(_k,_f,fn)=>fn()},
    oauth
  });
  const app=await open(gateway);
  try{
    const config=await app.fetcher('/v1/auth/config');
    assert.deepEqual(await config.json(),{loginAvailable:true});
    assert.equal((await app.fetcher('/auth/start?app=client')).status,303);
    assert.equal((await app.fetcher('/auth/start?app=hub')).status,303);
    const client=await app.fetcher('/client');
    assert.equal(client.status,200);
    assert.match(await client.text(),/OrdaX Flow — Cliente/);
    const hub=await app.fetcher('/hub');
    assert.equal(hub.status,200);
    assert.match(await hub.text(),/OrdaX Flow Hub/);
    assert.equal((await app.fetcher('/v1/projects')).status,401);
  }finally{await app.close();}
});
