import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFlowPlatformGateway } from '../src/relay/platform-composition.mjs';

function listen(handler) {
  const server=http.createServer(handler);
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve({
    origin:'http://127.0.0.1:'+server.address().port,
    close:()=>new Promise(done=>server.close(done))
  })));
}
const SUBJECT='11111111-1111-4111-8111-111111111111';

test('Flow Client and Hub share canonical Platform account identity without hidden fallback',async()=>{
  let canonicalValidations=0,operatorChecks=0,requests=0;
  const platform=await listen((req,res)=>{
    canonicalValidations++;
    const valid=req.method==='GET'&&req.url==='/v3/product/session'&&
      req.headers.authorization==='Bearer verified_flow_account_token';
    res.writeHead(valid?200:401,{'content-type':'application/json'});
    res.end(JSON.stringify(valid?{ok:true,session:{subject_id:SUBJECT,
      issuer:'https://iam.example.test',audience:'authenticated',
      expires_at_unix:Math.floor(Date.now()/1000)+3600}}:{ok:false,error:'invalid'}));
  });
  const appHandler=createFlowPlatformGateway({
    platformOrigin:platform.origin,publicOrigin:'http://127.0.0.1',allowLoopbackHttp:true,platformTimeoutMs:15000,
    authenticateBrowserSession:async()=>null, // User-facing web sessions not wired yet.
    authorizeTask:async({principal,taskId})=>taskId===SUBJECT+'_project',
    listProjects:async({principal})=>[{id:principal.userId+'_project',title:'My authorized project'}],
    authorizeHub:async({principal,capability})=>{
      operatorChecks++;
      return false; // Operator role must come from Platform, not same owner token.
    },
    getHubOverview:async()=>{throw Error('must_never_reach');},
    dispatch:async({principal,text})=>{requests++;return {text:principal.userId+':'+text};},
    idempotency:{execute:async(_key,_hash,fn)=>fn()}
  });
  const app=await listen(appHandler);
  try{
    const options={headers:{authorization:'Bearer verified_flow_account_token'}};
    const projects=await fetch(app.origin+'/v1/projects',options);
    assert.equal(projects.status,200);
    assert.deepEqual(await projects.json(),{projects:[{
      id:SUBJECT+'_project',title:'My authorized project'}]});
    const blocked=await fetch(app.origin+'/v1/hub/overview',options);
    assert.equal(blocked.status,403);
    assert.equal(operatorChecks,1);
    const incoming=await fetch(app.origin+'/v1/messages',{method:'POST',
      headers:{authorization:'Bearer verified_flow_account_token',
        'content-type':'application/json'},
      body:JSON.stringify({taskId:SUBJECT+'_project',requestId:'request_1',text:'verified'})});
    assert.equal(incoming.status,200);
    assert.deepEqual(await incoming.json(),{
      taskId:SUBJECT+'_project',requestId:'request_1',
      message:{role:'assistant',content:SUBJECT+':verified'}
    });
    assert.equal(requests,1);
    const impostor=await fetch(app.origin+'/v1/messages',{method:'POST',
      headers:{authorization:'Bearer invalid_flow_account_token',
        'content-type':'application/json','x-flow-user-id':SUBJECT},
      body:JSON.stringify({taskId:SUBJECT+'_project',requestId:'request_2',text:'forged'})});
    assert.equal(impostor.status,401);
    const cookieWithoutCanonicalSession=await fetch(app.origin+'/v1/projects',{
      headers:{cookie:'ordax_session=forged'}
    });
    assert.equal(cookieWithoutCanonicalSession.status,401);
    assert.equal(requests,1);
    assert.equal(canonicalValidations,4);
  }finally{await app.close();await platform.close();}
});

test('gateway refuses startup when account/session, authorizers or idempotency ports are not configured',()=>{
  assert.throws(()=>createFlowPlatformGateway({platformOrigin:'https://product.example.test'}),
    /flow_production_ports_unconfigured/);
  const ports={
    platformOrigin:'https://product.example.test',
    publicOrigin:'https://flow.example.test',
    authenticateBrowserSession:async()=>null,
    authorizeTask:async()=>false,
    listProjects:async()=>[],
    authorizeHub:async()=>false,
    getHubOverview:async()=>({}),
    dispatch:async()=>({text:''}),
    idempotency:{execute:async(_key,_hash,fn)=>fn()}
  };
  assert.equal(typeof createFlowPlatformGateway(ports),'function');
  assert.throws(()=>createFlowPlatformGateway({...ports,platformOrigin:'http://remote.example.test'}),
    /platform_https_required/);
  assert.throws(()=>createFlowPlatformGateway({...ports,listProjects:null}),
    /flow_production_ports_unconfigured/);
});
