import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowPostgresOAuthTransactionStore } from '../src/relay/postgres-oauth-transactions.mjs';
import { createFlowPlatformGateway } from '../src/relay/platform-composition.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const now=()=>Date.parse('2026-10-18T04:00:00Z');
const future=Math.floor(now()/1000)+600;
const digest=n=>String(n).padStart(43,'A');
const verifier=n=>String(n).padStart(43,'B');

function sharedDatabase() {
  const states=new Map();
  const calls=[];
  let down=false;
  return {
    states,calls,
    fail(value){down=value;},
    async query(sql,params){
      if(down)throw Error('postgres_unavailable');
      calls.push({sql,params});
      if(sql.startsWith('INSERT INTO flow_private.oauth_transactions')) {
        assert.equal(params.length,4);
        const [key,codeVerifier,returnPath,expiresAtUnix]=params;
        if(states.has(key))throw Error('duplicate_state');
        states.set(key,{code_verifier:codeVerifier,return_path:returnPath,expires_at_unix:expiresAtUnix});
        return {rows:[]};
      }
      if(sql.startsWith('DELETE FROM flow_private.oauth_transactions')) {
        assert.equal(params.length,1);
        const state=states.get(params[0]);
        if(!state||state.expires_at_unix<=Math.floor(now()/1000))
          return {rows:[]};
        states.delete(params[0]);
        return {rows:[state]};
      }
      throw Error('unexpected_sql:'+sql);
    }
  };
}
test('Flow OAuth state uses one private canonical PostgreSQL schema, not auth.flow_state',()=>{
  const migration=readFileSync(fileURLToPath(new URL('../sql/flow-oauth-transactions.sql',import.meta.url)),'utf8');
  assert.match(migration,/CREATE SCHEMA IF NOT EXISTS flow_private/);
  assert.match(migration,/REVOKE ALL ON SCHEMA flow_private FROM PUBLIC/);
  assert.match(migration,/REVOKE ALL ON flow_private.oauth_transactions FROM PUBLIC/);
  assert.match(migration,/PRIMARY KEY/);
  assert.match(migration,/10 minutes/);
  assert.doesNotMatch(migration,/auth\.flow_state|service_role|GRANT ALL TO PUBLIC/i);
});
test('two server replicas consume the same PKCE challenge exactly once atomically',async()=>{
  const db=sharedDatabase();
  const a=createFlowPostgresOAuthTransactionStore({query:db.query,now});
  const b=createFlowPostgresOAuthTransactionStore({query:db.query,now});
  const key=digest('1');
  await a.put({key,verifier:verifier('1'),returnPath:'/client',expiresAtUnix:future});
  const [first,second]=await Promise.all([a.take({key}),b.take({key})]);
  assert.equal([first,second].filter(Boolean).length,1);
  assert.deepEqual(first||second,{verifier:verifier('1'),returnPath:'/client',expiresAtUnix:future});
  assert.equal(await a.take({key}),null);
  assert(db.calls.some(c=>c.sql.includes('DELETE FROM')&&c.sql.includes('RETURNING')));
  assert(db.calls.every(c=>!c.sql.includes(key)));
});
test('100 devices can store separate OAuth states and exchange callback to any of four replicas',async()=>{
  const db=sharedDatabase();
  const servers=Array.from({length:4},()=>createFlowPostgresOAuthTransactionStore({
    query:db.query,now
  }));
  const tasks=Array.from({length:100},(_,i)=>({
    key:digest(i+1),verifier:verifier(i+1),returnPath:i%2===0?'/client':'/hub',
    expiresAtUnix:future
  }));
  await Promise.all(tasks.map((t,i)=>servers[i%4].put(t)));
  assert.equal(db.states.size,100);
  const callbacks=await Promise.all(tasks.map((t,i)=>servers[(i+2)%4].take({key:t.key})));
  assert.equal(callbacks.length,100);
  callbacks.forEach((response,i)=>assert.deepEqual(response,{
    verifier:tasks[i].verifier,returnPath:tasks[i].returnPath,
    expiresAtUnix:future
  }));
  assert.equal(db.states.size,0);
  const replay=await Promise.all(tasks.map((t,i)=>servers[(i+1)%4].take({key:t.key})));
  assert(replay.every(value=>value===null));
});
test('duplicate, expired, invalid, inaccessible and malformed transaction states fail closed',async()=>{
  const db=sharedDatabase();
  const store=createFlowPostgresOAuthTransactionStore({query:db.query,now});
  const task={key:digest('9'),verifier:verifier('9'),
    returnPath:'/hub',expiresAtUnix:future};
  await store.put(task);
  await assert.rejects(store.put(task),/duplicate_state/);
  await assert.rejects(store.put({...task,key:'bad'}),/transaction_invalid/);
  await assert.rejects(store.put({...task,key:digest('8'),expiresAtUnix:future+1}),/transaction_invalid/);
  await assert.rejects(store.put({...task,key:digest('7'),returnPath:'/admin'}),/transaction_invalid/);
  await assert.rejects(store.take({key:'bad'}),/transaction_key_invalid/);
  db.fail(true);
  await assert.rejects(store.take({key:task.key}),/postgres_unavailable/);
  db.fail(false);
  assert.deepEqual(await store.take({key:task.key}),{
    verifier:task.verifier,returnPath:task.returnPath,expiresAtUnix:future
  });
  assert.throws(()=>createFlowPostgresOAuthTransactionStore({}),/canonical_postgres_required/);
});

test('production gateway refuses a local-only OAuth state store even with valid identity ports',()=>{
  const ports={
    platformOrigin:'https://platform.example.test',
    publicOrigin:'https://flow.ordax.com.br',
    authenticateBrowserSession:async()=>null,
    authorizeTask:async()=>false,
    listProjects:async()=>[],
    authorizeHub:async()=>false,
    getHubOverview:async()=>({}),
    dispatch:async()=>({text:'unused'}),
    idempotency:{execute:async(_key,_hash,fn)=>fn()}
  };
  const oauth={
    issuer:'https://canonical-ordax-auth.supabase.co/auth/v1',
    clientId:'future-registered-flow-client',
    transactionStore:sharedDatabase(),
    completeAccountLogin:async()=>({verified:false})
  };
  assert.throws(()=>createFlowPlatformGateway({...ports,oauth}),
    /flow_oauth_durable_postgres_required/);
  const composed=createFlowPlatformGateway({...ports,oauth:{
    ...oauth,postgresQuery:sharedDatabase().query
  }});
  assert.equal(typeof composed,'function');
});
