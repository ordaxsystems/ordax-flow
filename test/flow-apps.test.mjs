import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createFlowRelay } from '../src/relay/relay.mjs';
import { createFlowWebHandler } from '../src/relay/web-apps.mjs';

const stats = {
  activeUsers:17,activeDevices:23,totalProjects:61,
  completedRequests:458,failedRequests:2,pendingRequests:3
};
const principal = {
  client:{userId:'client_user',scopes:[]},
  another:{userId:'another_user',scopes:[]},
  operator:{userId:'hub_operator',scopes:['flow:hub:read']}
};
async function fixture() {
  const calls={message:0,hub:0,projects:0};
  const receipts=new Map();
  const gateway=createFlowRelay({
    authenticate:async token=>principal[token]||null,
    // Test-only session fixture. Production must validate HttpOnly OrdaX IAM
    // session, origin, CSRF and expiry before returning a principal.
    authenticateRequest:async({request,method})=>{
      if (method==='POST' && request.headers.origin!=='http://127.0.0.1')
        return null;
      return principal[String(request.headers.cookie||'').split('ordax_session=')[1]]||null;
    },
    authorizeTask:async({principal:user,taskId})=>taskId===user.userId+'_project',
    listProjects:async({principal:user})=>{
      calls.projects++;
      return [{id:user.userId+'_project',title:'Projeto de '+user.userId}];
    },
    authorizeHub:async({principal:user,capability})=>
      user.scopes.includes(capability),
    getHubOverview:async()=>{
      calls.hub++;
      return {...stats,privateUserList:['secret'],providerKey:'must_not_leak',messages:['private']};
    },
    dispatch:async({principal:user,taskId,requestId,text})=>{
      calls.message++;
      return {text:user.userId+':'+taskId+':'+requestId+':'+text,taskId:'spoofed'};
    },
    idempotency:{
      async execute(key,fingerprint,fn) {
        const existing=receipts.get(key);
        if(existing) {
          if(existing.fingerprint!==fingerprint)throw Object.assign(Error('request_id_conflict'),{status:409});
          return existing.result;
        }
        const result=await fn();
        receipts.set(key,{fingerprint,result});
        return result;
      }
    }
  });
  const server=http.createServer(createFlowWebHandler(gateway));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const go=async(path,{token,method='GET',body,headers={}}={})=>{
    const response=await fetch(base+path,{method,headers:{
      ...(token?{authorization:'Bearer '+token}:{}),
      ...(body?{'content-type':'application/json'}:{}),
      ...headers
    },...(body?{body:JSON.stringify(body)}:{})});
    const raw=await response.text();
    return {status:response.status,headers:response.headers,text:raw,
      data:response.headers.get('content-type')?.includes('json')?JSON.parse(raw):null};
  };
  return {go,calls,close:()=>new Promise(resolve=>server.close(resolve))};
}

test('two independently scoped Flow apps are served without OS/Studio imports or shared tokens',async()=>{
  const f=await fixture();
  try {
    for(const [path,expected] of [
      ['/client','Flow Client'],['/hub','Flow Hub'],
      ['/client/app.mjs','/v1/projects'],['/hub/app.mjs','/v1/hub/overview'],
      ['/shared/styles.css','surface'],['/shared/api.mjs','same-origin']]) {
      const result=await f.go(path);
      assert.equal(result.status,200,path);
      assert.match(result.text,new RegExp(expected));
      assert.equal(result.headers.get('cache-control'),'no-store');
      assert.match(result.headers.get('content-security-policy'),/default-src 'none'/);
      assert.doesNotMatch(result.text,/ordax-os|apiKey|OPENAI_API_KEY/);
    }
    assert.equal((await f.go('/hub/private.json')).status,404);
    assert.equal((await f.go('/client/../nonexistent')).status,404);
    assert.equal((await f.go('/hub',{method:'POST'})).status,404);
  }finally{await f.close();}
});

test('client cannot access Hub metrics by changing URL, headers, payload, or identity',async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.go('/v1/hub/overview')).status,401);
    const unprivileged=await f.go('/v1/hub/overview',{token:'client',
      headers:{'x-flow-role':'administrator','x-flow-user':'hub_operator'}});
    assert.equal(unprivileged.status,403);
    assert.equal(f.calls.hub,0);
    const genuine=await f.go('/v1/hub/overview',{token:'operator'});
    assert.equal(genuine.status,200);
    assert.deepEqual(genuine.data,{stats});
    assert.equal(genuine.text.includes('secret'),false);
    assert.equal(genuine.text.includes('private'),false);
    assert.equal(genuine.text.includes('providerKey'),false);
    assert.equal(f.calls.hub,1);
  }finally{await f.close();}
});

test('client projects and messages stay bound to verified account, not claimed device or provider',async()=>{
  const f=await fixture();
  try {
    const client=await f.go('/v1/projects',{token:'client'});
    const another=await f.go('/v1/projects',{token:'another'});
    assert.deepEqual(client.data.projects.map(x=>x.id),['client_user_project']);
    assert.deepEqual(another.data.projects.map(x=>x.id),['another_user_project']);
    assert.equal(client.data.projects.some(x=>x.id==='another_user_project'),false);
    const denied=await f.go('/v1/messages',{token:'client',method:'POST',body:{
      taskId:'another_user_project',requestId:'id_1',text:'private'
    }});
    assert.equal(denied.status,404);
    const good=await f.go('/v1/messages',{token:'client',method:'POST',body:{
      taskId:'client_user_project',requestId:'id_2',text:'hello'
    }});
    assert.equal(good.status,200);
    assert.deepEqual(good.data,{
      taskId:'client_user_project',requestId:'id_2',
      message:{role:'assistant',content:'client_user:client_user_project:id_2:hello'}
    });
    assert.equal(f.calls.message,1);
  }finally{await f.close();}
});

test('Hub is disabled unless its own RBAC and metrics ports are explicitly wired',async()=>{
  const gateway=createFlowRelay({
    authenticate:async()=>principal.operator,authorizeTask:async()=>true,
    dispatch:async()=>({text:'ok'}),idempotency:{execute:async(_k,_f,fn)=>fn()}
  });
  const server=http.createServer(gateway);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/hub/overview',
      {headers:{authorization:'Bearer operator'}});
    assert.equal(response.status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
  assert.throws(()=>createFlowRelay({
    authenticate:async()=>principal.operator,authorizeTask:async()=>true,
    dispatch:async()=>({text:'ok'}),idempotency:{execute:async(_k,_f,fn)=>fn()},
    getHubOverview:async()=>stats
  }),/flow_hub_requires_explicit_rbac_and_projection_adapters/);
});

test('Flow projects and Tasks never claim implicit canonical Space or Runtime grant', async () => {
  const architecture = await readFile(new URL('../docs/FLOW-ARCHITECTURE.md', import.meta.url), 'utf8');
  for (const marker of [
    'ordax_spaces.space_id', 'ordax_projects.project_id',
    '/v1/projects', 'taskId', 'requestId',
    'não requerem MCP, Space ou computador conectado',
  ]) {
    assert.ok(architecture.includes(marker), marker);
  }
  assert.match(architecture, /vínculo a projeto canônico é explícito e versionado/);
  assert.match(architecture, /não.*criado implicitamente por Flow ou pelo MCP/i);
});
