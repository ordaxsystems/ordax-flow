import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFlowConversationStore } from '../src/relay/conversation-store.mjs';
import { createFlowRelay } from '../src/relay/relay.mjs';

const UUID=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
function database(){
  const tasks=new Map(),messages=[];
  let nextTask=1000,seq=0;
  const calls=[];
  async function query(sql,args){
    calls.push({sql,args});
    if(sql.startsWith('INSERT INTO flow_private.conversations')){
      const [id,owner,title]=args;
      tasks.set(id,{id,owner,title});return {rows:[{id,title}]};
    }
    if(sql.includes('SELECT task_id::text AS id,title FROM flow_private.conversations')){
      const [owner,limit]=args;
      return {rows:[...tasks.values()].filter(t=>t.owner===owner)
        .slice(0,limit).map(t=>({id:t.id,title:t.title}))};
    }
    if(sql.includes('SELECT 1 AS allowed FROM flow_private.conversations')){
      const [owner,id]=args;
      return {rows:tasks.get(id)?.owner===owner?[{allowed:1}]:[]};
    }
    if(sql.includes('SELECT m.seq::text AS id,m.role,m.content')){
      const [owner,taskId,before,limit]=args;
      return {rows:tasks.get(taskId)?.owner!==owner?[]:messages
        .filter(m=>m.taskId===taskId&&(!before||BigInt(m.id)<BigInt(before)))
        .slice().reverse().slice(0,limit)
        .map(({id,role,content})=>({id,role,content}))};
    }
    if(sql.includes('INSERT INTO flow_private.messages')){
      const [owner,taskId,requestId,userText,assistantText]=args;
      if(tasks.get(taskId)?.owner!==owner)return {rows:[]};
      if(messages.some(m=>m.taskId===taskId&&m.requestId===requestId))
        return {rows:[]};
      // This fixture simulates one atomic SQL statement.
      messages.push({id:String(++seq),taskId,requestId,role:'user',content:userText});
      messages.push({id:String(++seq),taskId,requestId,role:'assistant',content:assistantText});
      return {rows:[{role:'user'},{role:'assistant'}]};
    }
    if(sql.includes('SELECT m.role,m.content FROM flow_private.messages')){
      const [owner,taskId,requestId]=args;
      return {rows:tasks.get(taskId)?.owner!==owner?[]:messages
        .filter(m=>m.taskId===taskId&&m.requestId===requestId)
        .map(m=>({role:m.role,content:m.content}))};
    }
    throw Error('unexpected SQL');
  }
  function makeStore(){
    return createFlowConversationStore({query,newId:()=>UUID(nextTask++)});
  }
  return {query,makeStore,tasks,messages,calls};
}

test('private Flow journal reuses OrdaX user ID without cloning Platform project tables',()=>{
  const migration=readFileSync(fileURLToPath(new URL('../sql/flow-conversation-history.sql',import.meta.url)),'utf8');
  assert(migration.includes('REFERENCES auth.users(id)'));
  assert.match(migration,/flow_private.conversations/);
  assert.doesNotMatch(migration,/CREATE TABLE.*ordax_projects|CREATE TABLE.*auth.users/i);
  assert.throws(()=>createFlowConversationStore({}),/canonical_conversation_query_required/);
});

test('two users keep independent histories and 120 messages page in canonical order',async()=>{
  const db=database(),a=db.makeStore(),b=db.makeStore();
  const alice={userId:UUID(1)},bob={userId:UUID(2)};
  const one=await a.createConversation({principal:alice,title:'Meu projeto'});
  const other=await b.createConversation({principal:bob,title:'Projeto independente'});
  assert.notEqual(one.id,other.id);
  assert.deepEqual(await b.listProjects({principal:alice}),[one]);
  assert.deepEqual(await a.listProjects({principal:bob}),[other]);
  assert.equal(await a.authorizeTask({principal:bob,taskId:one.id}),false);
  for(let i=0;i<60;i++){
    await a.recordTurn({principal:alice,taskId:one.id,requestId:'turn_'+i,
      userText:'Alice '+i,assistantText:'Answer '+i});
  }
  assert.equal(db.messages.length,120);
  const page=await b.getHistory({principal:alice,taskId:one.id});
  assert.equal(page.messages.length,50);
  assert.equal(page.messages[0].content,'Alice 35');
  assert.equal(page.messages.at(-1).content,'Answer 59');
  assert(page.nextBefore);
  const prior=await a.getHistory({principal:alice,taskId:one.id,before:page.nextBefore});
  assert.equal(prior.messages.length,50);
  assert.equal(prior.messages[0].content,'Alice 10');
  const earliest=await a.getHistory({principal:alice,taskId:one.id,before:prior.nextBefore});
  assert.equal(earliest.messages.length,20);
  assert.equal(earliest.messages[0].content,'Alice 0');
  assert.equal(earliest.nextBefore,null);
  assert.deepEqual(await b.getHistory({principal:bob,taskId:one.id}),{messages:[],nextBefore:null});
  assert(db.calls.filter(x=>x.sql.includes('SELECT m.seq')).every(x=>
    x.sql.includes('t.owner_user_id=$1::uuid')&&x.args.length===4));
});

test('durable turn replay is idempotent; conflicting same-id text fails and client ownership is mandatory',async()=>{
  const db=database(),store=db.makeStore(),user={userId:UUID(1)};
  const task=await store.createConversation({principal:user,title:'Tarefa'});
  const turn={principal:user,taskId:task.id,requestId:'req01',
    userText:'ola',assistantText:'bem vindo'};
  await store.recordTurn(turn);
  await store.recordTurn(turn);
  assert.equal(db.messages.length,2);
  await assert.rejects(store.recordTurn({...turn,assistantText:'resposta diferente'}),
    /turn_mismatch_or_forbidden/);
  await assert.rejects(store.recordTurn({...turn,principal:{userId:UUID(2)},requestId:'other'}),
    /turn_mismatch_or_forbidden/);
  await assert.rejects(store.recordTurn({...turn,requestId:'bad id'}),/turn_invalid/);
  await assert.rejects(store.getHistory({principal:user,taskId:task.id,before:'not-a-cursor'}),
    /history_cursor_invalid/);
  await assert.rejects(store.createConversation({principal:user,title:' '.repeat(3)}),
    /title_invalid/);
  assert.equal(db.messages.length,2);
});

test('gateway binds conversation create, history and provider responses to OrdaX owner',async()=>{
  const db=database(),store=db.makeStore();
  const tokens=new Map(Array.from({length:12},(_,i)=>['token_'+i,{userId:UUID(i+1)}]));
  let dispatches=0;
  const handler=createFlowRelay({
    authenticate:async token=>tokens.get(token)||null,
    authorizeTask:store.authorizeTask,
    listProjects:store.listProjects,
    createConversation:store.createConversation,
    getHistory:store.getHistory,
    recordTurn:store.recordTurn,
    dispatch:async({principal,taskId,requestId,text})=>{
      dispatches++;
      await new Promise(r=>setTimeout(r,requestId.length%4));
      return {text:principal.userId+' '+taskId+' '+requestId+' '+text};
    },
    idempotency:{execute:async(_key,_hash,fn)=>fn()}
  });
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  async function request(token,path,body){
    const response=await fetch(origin+path,{method:body?'POST':'GET',
      headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json()};
  }
  try{
    const users=await Promise.all([...tokens].map(async([token,principal])=>{
      const create=await request(token,'/v1/conversations',{title:'Minha conversa'});
      assert.equal(create.status,201);
      return {token,...principal,task:create.data.conversation.id};
    }));
    const jobs=users.flatMap(u=>Array.from({length:8},(_,n)=>({...u,n})));
    const replies=await Promise.all(jobs.map(u=>request(u.token,'/v1/messages',{
      taskId:u.task,requestId:'r_'+u.n,text:'TEXT_'+u.userId+'_'+u.n
    })));
    assert(replies.every(r=>r.status===200));
    assert.equal(dispatches,96);
    assert.equal(db.messages.length,192);
    for(const u of users){
      const own=await request(u.token,'/v1/history/'+u.task);
      assert.equal(own.status,200);
      assert.equal(own.data.messages.length,16);
      assert(own.data.messages.every(m=>m.content.includes(u.userId)));
      const foreign=users.find(v=>v.userId!==u.userId);
      const denied=await request(foreign.token,'/v1/history/'+u.task);
      assert.equal(denied.status,404);
      const listed=await request(u.token,'/v1/projects');
      assert.deepEqual(listed.data.projects,[{id:u.task,title:'Minha conversa'}]);
    }
    const invalid=await request(users[0].token,'/v1/history/'+users[0].task+'?before=abc');
    assert.equal(invalid.status,400);
    const unauth=await request('wrong','/v1/history/'+users[0].task);
    assert.equal(unauth.status,401);
  }finally{await new Promise(r=>server.close(r));}
});
