import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFlowRelay } from '../src/relay/relay.mjs';

const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
function mockLedger() {
  const records=new Map();
  return {
    async execute(key,fingerprint,fn) {
      const old=records.get(key);
      if(old) {
        if(old.fingerprint!==fingerprint)
          throw Object.assign(new Error('request_id_conflict'),{status:409});
        return old.promise;
      }
      const promise=Promise.resolve().then(fn);
      records.set(key,{fingerprint,promise});
      try{return await promise;}catch(error){records.delete(key);throw error;}
    }
  };
}
async function fixture() {
  const users=Array.from({length:12},(_,i)=>({
    id:'user_'+String(i+1).padStart(2,'0'),token:'test_token_'+(i+1),
    device:'computer_'+(i+1)
  }));
  const credentials=new Map(users.map(u=>[u.token,{userId:u.id}]));
  const ownerOf=new Map(users.flatMap(u=>[1,2].map(k=>[u.id+'_task_'+k,u.id])));
  const invocations=new Map();
  const router=createFlowRelay({
    authenticate:async token=>credentials.get(token)||null,
    authorizeTask:async({principal,taskId})=>ownerOf.get(taskId)===principal.userId,
    idempotency:mockLedger(),
    dispatch:async({principal,taskId,requestId,text})=>{
      const key=JSON.stringify([principal.userId,taskId,requestId]);
      invocations.set(key,(invocations.get(key)||0)+1);
      // Deterministic out-of-order completions across client/task pairs.
      await delay((text.length*7+requestId.length*13)%17);
      return {text:'RESP|'+principal.userId+'|'+taskId+'|'+requestId+'|'+text,
        userId:'malicious-provider-echo', taskId:'wrong-provider-task'};
    }
  });
  const server=http.createServer(router);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/v1/messages';
  async function send(user,body,token=user.token) {
    const response=await fetch(url,{method:'POST',headers:{
      'authorization':'Bearer '+token,'content-type':'application/json',
      'x-flow-device':user.device
    },body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  }
  return {users,url,send,invocations,close:()=>new Promise(resolve=>server.close(resolve))};
}
test('twelve simulated computers route 192 interleaved messages to their own account/task',async()=>{
  const f=await fixture();
  try{
    const jobs=f.users.flatMap(user=>[1,2].flatMap(task=>Array.from({length:8},(_,i)=>{
      const taskId=user.id+'_task_'+task;
      const requestId='request_'+i;
      const text='message_from_'+user.device+'_seq_'+i;
      return {user,taskId,requestId,text};
    })));
    const answers=await Promise.all(jobs.map(async job=>{
      const response=await f.send(job.user,{taskId:job.taskId,requestId:job.requestId,text:job.text});
      return {...job,...response};
    }));
    assert.equal(answers.length,192);
    for(const r of answers){
      assert.equal(r.status,200);
      assert.equal(r.data.taskId,r.taskId);
      assert.equal(r.data.requestId,r.requestId);
      assert.equal(r.data.message.role,'assistant');
      assert.equal(r.data.message.content,['RESP',r.user.id,r.taskId,r.requestId,r.text].join('|'));
      assert.equal(r.data.userId,undefined);
    }
    assert.equal(f.invocations.size,192);
  }finally{await f.close();}
});
test('account isolation rejects task access from a different computer/user',async()=>{
  const f=await fixture();
  try{
    const a=f.users[0],b=f.users[1];
    const denied=await f.send(b,{taskId:a.id+'_task_1',requestId:'denied',text:'hello'});
    assert.equal(denied.status,404);
    assert.deepEqual(denied.data,{error:'task_not_found'});
    const spoof=await f.send(b,{taskId:b.id+'_task_1',requestId:'spoof',text:'hello',userId:a.id});
    assert.equal(spoof.status,400);
    const wrong=await f.send(a,{taskId:a.id+'_task_1',requestId:'wrong',text:'hi'},'invalid-token');
    assert.equal(wrong.status,401);
    assert.equal(f.invocations.size,0);
  }finally{await f.close();}
});
test('request idempotency correlates retries exactly once, and rejects conflicting reuse',async()=>{
  const f=await fixture();
  try{
    const u=f.users[4],taskId=u.id+'_task_2';
    const body={taskId,requestId:'stable_request',text:'same-text'};
    const results=await Promise.all(Array.from({length:12},()=>f.send(u,body)));
    assert(results.every(r=>r.status===200));
    assert(results.every(r=>JSON.stringify(r.data)===JSON.stringify(results[0].data)));
    const key=JSON.stringify([u.id,taskId,body.requestId]);
    assert.equal(f.invocations.get(key),1);
    const mismatch=await f.send(u,{...body,text:'different text'});
    assert.equal(mismatch.status,409);
    const secondUser=f.users[5];
    const independent=await f.send(secondUser,{taskId:secondUser.id+'_task_2',
      requestId:body.requestId,text:body.text});
    assert.equal(independent.status,200);
    assert.equal(f.invocations.size,2);
  }finally{await f.close();}
});
test('relay fails closed when canonical authorization, identity or durable receipts are missing',()=>{
  assert.throws(()=>createFlowRelay({authenticate:async()=>({userId:'a'}),dispatch:async()=>({text:'ok'})}),
    /flow_relay_requires_canonical_adapters/);
});
