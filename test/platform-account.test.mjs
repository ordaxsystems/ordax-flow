import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFlowPlatformAuthenticator, PLATFORM_ACCOUNT_SESSION_PATH } from '../src/relay/platform-account.mjs';
import { createFlowRelay } from '../src/relay/relay.mjs';

const ids=Array.from({length:20},(_,i)=>
  'a0000000-0000-4000-8000-'+String(i+1).padStart(12,'0'));
const tokens=new Map(ids.map((id,i)=>['flow-test-token-'+(i+1),id]));
const future=Math.floor(Date.now()/1000)+3600;
const document=id=>({ok:true,session:{
  subject_id:id,issuer:'https://auth.example.test',audience:'authenticated',expires_at_unix:future
}});
async function listen(handler) {
  const server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,origin:'http://127.0.0.1:'+server.address().port,
    close:()=>new Promise(resolve=>server.close(resolve))};
}
async function environment(){
  const probes=[];
  const upstream=await listen(async(req,res)=>{
    probes.push({path:req.url,method:req.method,authorization:req.headers.authorization});
    const token=String(req.headers.authorization||'').slice(7);
    let status=200,body;
    if(req.url!==PLATFORM_ACCOUNT_SESSION_PATH || req.method!=='GET'){
      status=404;body={error:'not_found'};
    }else if(token==='flow-test-token-expired'){
      body={...document(ids[0]),session:{...document(ids[0]).session,expires_at_unix:future-90000}};
    }else if(token==='flow-test-token-malformed'){
      body={ok:true,session:{subject_id:'fake-identity'}};
    }else if(token==='flow-test-token-redirect'){
      res.writeHead(302,{location:'https://evil.example.test/steal'});res.end();return;
    }else if(!tokens.has(token)){
      status=401;body={ok:false,error:'product_signature_invalid'};
    }else{body=document(tokens.get(token));}
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify(body));
  });
  const authenticate=createFlowPlatformAuthenticator({
    platformOrigin:upstream.origin,allowLoopbackHttp:true,timeoutMs:15000
  });
  return {authenticate,probes,upstream};
}

test('account adapter accepts only a fixed HTTPS Platform origin outside explicit loopback tests',()=>{
  assert.throws(()=>createFlowPlatformAuthenticator({
    platformOrigin:'http://example.com'}),/platform_https_required/);
  assert.throws(()=>createFlowPlatformAuthenticator({
    platformOrigin:'https://example.com/v3/product/session'}),/platform_origin_only/);
  assert.throws(()=>createFlowPlatformAuthenticator({
    platformOrigin:'https://abc:secret@example.com'}),/platform_origin_only/);
  assert.throws(()=>createFlowPlatformAuthenticator({
    platformOrigin:'http://192.168.0.5',allowLoopbackHttp:true}),/platform_https_required/);
  assert.throws(()=>createFlowPlatformAuthenticator({
    platformOrigin:'https://example.com?x=2'}),/platform_origin_only/);
  assert.equal(PLATFORM_ACCOUNT_SESSION_PATH,'/v3/product/session');
});

test('canonical owner identity comes from Platform verification, not a browser assertion',async()=>{
  const f=await environment();
  try{
    for(let i=0;i<ids.length;i++){
      const principal=await f.authenticate('flow-test-token-'+(i+1));
      assert.deepEqual(principal,{userId:ids[i]});
    }
    assert.equal(f.probes.length,20);
    assert(f.probes.every(p=>p.method==='GET'&&p.path===PLATFORM_ACCOUNT_SESSION_PATH));
    assert.equal(await f.authenticate('flow-test-token-invalid'),null);
    assert.equal(await f.authenticate('flow-test-token-expired'),null);
    assert.equal(await f.authenticate('flow-test-token-malformed'),null);
    assert.equal(await f.authenticate('flow-test-token-redirect'),null);
    assert.equal(await f.authenticate('short'),null);
    assert.equal(f.probes.length,24);
  }finally{await f.upstream.close();}
});

test('identity adapter denies unreachable, truncated, oversized and non-JSON upstream replies',async()=>{
  const broken=await listen((request,response)=>{
    response.writeHead(200,{'content-type':'application/json'});
    response.end('x'.repeat(5000));
  });
  try{
    const authenticate=createFlowPlatformAuthenticator({
      platformOrigin:broken.origin,allowLoopbackHttp:true
    });
    assert.equal(await authenticate('flow-test-token-valid'),null);
  }finally{await broken.close();}
  const bad=await listen((request,response)=>{
    response.writeHead(200,{'content-type':'text/html'});
    response.end('<p>not a verified account</p>');
  });
  try{
    const auth=createFlowPlatformAuthenticator({platformOrigin:bad.origin,allowLoopbackHttp:true});
    assert.equal(await auth('flow-test-token-valid'),null);
  }finally{await bad.close();}
  assert.equal(await createFlowPlatformAuthenticator({
    platformOrigin:'http://127.0.0.1:1',allowLoopbackHttp:true,timeoutMs:150
  })('flow-test-token-valid'),null);
});

test('20 client computers use verified Platform identity through Flow, with no cross-tenant routing or Hub escalation',async()=>{
  const f=await environment();
  const receipts=new Map();
  let dispatched=0,hubCalls=0;
  const gateway=createFlowRelay({
    authenticate:f.authenticate,
    authorizeTask:async({principal,taskId})=>taskId===principal.userId+':project',
    dispatch:async({principal,taskId,requestId,text})=>{
      dispatched++;
      return {text:principal.userId+'|'+taskId+'|'+requestId+'|'+text};
    },
    idempotency:{execute:async(key,hash,action)=>{
      if(receipts.has(key))return receipts.get(key);
      const reply=await action();receipts.set(key,reply);return reply;
    }},
    authorizeHub:async()=>false,
    getHubOverview:async()=>{hubCalls++;return {};},
    listProjects:async({principal})=>[{id:principal.userId+':project',title:'Isolated project'}]
  });
  const app=await listen(gateway);
  try {
    const jobs=Array.from({length:20},(_,i)=>Array.from({length:7},(_,n)=>({
      i,n,token:'flow-test-token-'+(i+1),owner:ids[i],taskId:ids[i]+':project',
      text:'msg-'+i+'-'+n
    }))).flat();
    const results=await Promise.all(jobs.map(async job=>{
      const response=await fetch(app.origin+'/v1/messages',{method:'POST',
        headers:{authorization:'Bearer '+job.token,'content-type':'application/json',
          'x-flow-user-id':ids[(job.i+1)%20],'x-flow-role':'administrator'},
        body:JSON.stringify({taskId:job.taskId,requestId:'req_'+job.n,text:job.text})});
      return {...job,status:response.status,data:await response.json()};
    }));
    assert.equal(results.length,140);
    for(const result of results){
      assert.equal(result.status,200);
      assert.deepEqual(result.data,{taskId:result.taskId,requestId:'req_'+result.n,
        message:{role:'assistant',
          content:result.owner+'|'+result.taskId+'|req_'+result.n+'|'+result.text}});
    }
    assert.equal(dispatched,140);
    const client=await fetch(app.origin+'/v1/hub/overview',{
      headers:{authorization:'Bearer flow-test-token-1','x-flow-role':'administrator'}});
    assert.equal(client.status,403);
    assert.equal(hubCalls,0);
    const forbidden=await fetch(app.origin+'/v1/messages',{method:'POST',
      headers:{authorization:'Bearer flow-test-token-1','content-type':'application/json'},
      body:JSON.stringify({taskId:ids[1]+':project',requestId:'denied',text:'private'})});
    assert.equal(forbidden.status,404);
    assert.equal(dispatched,140);
  }finally{
    await app.close();await f.upstream.close();
  }
});
