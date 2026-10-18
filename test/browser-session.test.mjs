import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFlowRelay } from '../src/relay/relay.mjs';
import { createFlowBrowserSessionVerifier } from '../src/relay/browser-session.mjs';

const ids=Array.from({length:16},(_,i)=>
  'b0000000-0000-4000-8000-'+String(i+1).padStart(12,'0'));
const sessions=new Map(ids.map((id,i)=>['sso_'+i,{
  verified:true,session:{subject_id:id,expires_at_unix:Math.floor(Date.now()/1000)+1800}
}]));
const caller=async(handler)=>{
  const server=http.createServer(handler);
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const base='http://127.0.0.1:'+server.address().port;
  return {
    base,close:()=>new Promise(done=>server.close(done)),
    async get(path,token,extra={}) {
      const response=await fetch(base+path,{headers:{
        ...(token?{cookie:'ordax_sso='+token}:{}),...extra
      }});
      return {status:response.status,body:await response.json()};
    },
    async send(token,taskId,requestId,text,extra={}) {
      const response=await fetch(base+'/v1/messages',{method:'POST',
        headers:{'content-type':'application/json',origin:base,
          cookie:'ordax_sso='+token,...extra},
        body:JSON.stringify({taskId,requestId,text})});
      return {status:response.status,body:await response.json()};
    }
  };
};
test('browser session verifier rejects invalid origin, missing proof and expired sessions',async()=>{
  const now=Date.now();
  const principal={verified:true,session:{
    subject_id:ids[0],expires_at_unix:Math.floor(now/1000)+600
  }};
  let passed=principal;
  const verifier=createFlowBrowserSessionVerifier({
    publicOrigin:'https://flow.example.test',
    now:()=>now,verifyAccountSession:async()=>passed
  });
  const request=headers=>({headers});
  assert.deepEqual(await verifier({method:'GET',request:request({})}),{userId:ids[0]});
  assert.deepEqual(await verifier({method:'POST',request:request({
    origin:'https://flow.example.test','sec-fetch-site':'same-origin'
  })}),{userId:ids[0]});
  for(const headers of [
    {},{origin:'https://malicious.example.test'},
    {origin:'https://flow.example.test','sec-fetch-site':'cross-site'},
    {origin:'https://flow.example.test','sec-fetch-site':'same-site'}
  ]){
    assert.equal(await verifier({method:'POST',request:request(headers)}),null);
  }
  // Untrusted proxy hints never replace the configured origin or principal.
  assert.deepEqual(await verifier({method:'POST',request:request({
    origin:'https://flow.example.test','x-forwarded-host':'evil.example.test'
  })}),{userId:ids[0]});
  passed={verified:false,session:principal.session};
  assert.equal(await verifier({method:'GET',request:request({})}),null);
  passed={verified:true,session:{...principal.session,expires_at_unix:Math.floor(now/1000)-10}};
  assert.equal(await verifier({method:'GET',request:request({})}),null);
  passed={verified:true,session:{...principal.session,subject_id:'unverified-user'}};
  assert.equal(await verifier({method:'GET',request:request({})}),null);
  assert.throws(()=>createFlowBrowserSessionVerifier({
    publicOrigin:'http://flow.example.test',verifyAccountSession:async()=>null
  }),/flow_public_https_required/);
});

test('16 OrdaX SSO sessions share their own projects without second Flow login',async()=>{
  let dispatched=0,hubReads=0;
  const verify=createFlowBrowserSessionVerifier({
    publicOrigin:'https://flow.example.test',
    verifyAccountSession:async({request})=>{
      const cookie=String(request.headers.cookie||'');
      const m=/^ordax_sso=([^;]+)$/.exec(cookie);
      return sessions.get(m?.[1])||null;
    }
  });
  const gateway=createFlowRelay({
    authenticate:async()=>null,authenticateRequest:verify,
    authorizeTask:async({principal,taskId})=>taskId===principal.userId+'_project',
    listProjects:async({principal})=>[{id:principal.userId+'_project',title:'Private project'}],
    authorizeHub:async({principal,capability})=>principal.userId===ids[0]&&capability==='flow:hub:read',
    getHubOverview:async()=>{hubReads++;return{
      activeUsers:16,activeDevices:16,totalProjects:16,completedRequests:dispatched,
      failedRequests:0,pendingRequests:0
    };},
    dispatch:async({principal,taskId,requestId,text})=>{
      dispatched++;
      return {text:principal.userId+'|'+taskId+'|'+requestId+'|'+text};
    },
    idempotency:{execute:async(_key,_hash,fn)=>fn()}
  });
  const app=await caller(gateway);
  try {
    const users=await Promise.all(ids.map(async(id,i)=>{
      const r=await app.get('/v1/session','sso_'+i);
      const projects=await app.get('/v1/projects','sso_'+i);
      return {id,r,projects};
    }));
    assert(users.every(u=>u.r.status===200&&u.r.body.authenticated===true));
    assert(users.every(u=>u.projects.body.projects[0].id===u.id+'_project'));
    const unauth=await app.get('/v1/session');
    assert.deepEqual(unauth,{status:200,body:{authenticated:false}});
    const nonAdmin=await app.get('/v1/hub/session','sso_1',
      {'x-flow-role':'administrator','x-flow-subject':ids[0]});
    assert.equal(nonAdmin.status,403);
    const admin=await app.get('/v1/hub/session','sso_0');
    assert.deepEqual(admin,{status:200,body:{authenticated:true,operator:true}});
    const adminStats=await app.get('/v1/hub/overview','sso_0');
    assert.equal(adminStats.status,200);
    assert.equal(hubReads,1);
    // One user may not impersonate another by forged body or headers.
    const swapped=await app.send('sso_1',ids[0]+'_project','foreign','secret',{
      origin:'https://flow.example.test','x-flow-user-id':ids[0]
    });
    assert.equal(swapped.status,404);
    const crossSite=await app.send('sso_0',ids[0]+'_project','cross','blocked',{
      origin:'https://evil.example.test'
    });
    assert.equal(crossSite.status,401);
    const valid=await app.send('sso_0',ids[0]+'_project','genuine','allowed',{
      origin:'https://flow.example.test'
    });
    assert.equal(valid.status,200);
    assert.equal(valid.body.message.content,ids[0]+'|'+ids[0]+'_project|genuine|allowed');
    assert.equal(dispatched,1);
  }finally{await app.close();}
});
