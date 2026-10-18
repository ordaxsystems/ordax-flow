import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFlowOwnerScopedQuery } from '../src/relay/postgres-owner-query.mjs';
import { createFlowPlatformGateway } from '../src/relay/platform-composition.mjs';

const USER='10000000-0000-4000-8000-000000000001';
const sql=readFileSync(fileURLToPath(new URL('../sql/flow-conversation-history.sql',import.meta.url)),'utf8');

test('SQL declares one private journal with RLS ownership and no duplicate identity or project',()=>{
  assert.match(sql,/CREATE TABLE IF NOT EXISTS flow_private.conversations/);
  assert.match(sql,/REFERENCES auth.users\(id\)/);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS flow_private.messages/);
  assert.match(sql,/UNIQUE \(task_id, request_id, role\)/);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
  assert.match(sql,/FORCE ROW LEVEL SECURITY/);
  assert.match(sql,/NOLOGIN/);
  assert.match(sql,/flow_conversation_owner/);
  assert.match(sql,/flow_message_owner/);
  assert.match(sql,/current_setting\('flow.owner_user_id'/);
  assert.match(sql,/REVOKE ALL ON flow_private.messages FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql,/CREATE TABLE.*ordax_projects|CREATE TABLE.*auth.users/i);
});
test('database requests carry the verified subject in a single pinned owner-scoped transaction',async()=>{
  const calls=[],connection={query:async(statement,args)=>{
    calls.push({statement,args});
    return {rows:[{allowed:1}]};
  }};
  let commits=0;
  const query=createFlowOwnerScopedQuery({withTransaction:async fn=>{
    const result=await fn(connection);
    commits++;
    return result;
  }});
  const result=await query('SELECT $1::text',[123],{ownerUserId:USER});
  assert.deepEqual(result,{rows:[{allowed:1}]});
  assert.equal(commits,1);
  assert.deepEqual(calls.map(x=>x.statement),[
    'SET LOCAL ROLE ordax_flow_gateway',
    "SELECT set_config('flow.owner_user_id',$1,true)",
    'SELECT $1::text'
  ]);
  assert.deepEqual(calls[1].args,[USER]);
  assert.deepEqual(calls[2].args,[123]);
  await assert.rejects(query('SELECT 1',[],{}),/verified_owner_sql_required/);
  await assert.rejects(query('SELECT 1',[],{ownerUserId:'fake'}),/verified_owner_sql_required/);
  assert.equal(commits,1);
});
test('role escalation failure propagates and never runs the business query',async()=>{
  let business=0;
  const query=createFlowOwnerScopedQuery({
    withTransaction:async fn=>fn({query:async statement=>{
      if(statement.startsWith('SET LOCAL ROLE'))throw Error('permission_denied');
      business++;return {rows:[]};
    }})
  });
  await assert.rejects(query('SELECT 1',[],{ownerUserId:USER}),/permission_denied/);
  assert.equal(business,0);
  assert.throws(()=>createFlowOwnerScopedQuery({}),/transaction_connection_required/);
});
test('production cannot wire an unscoped generic SQL connection for central conversations',()=>{
  const base={
    platformOrigin:'https://platform.example.test',
    publicOrigin:'https://flow.example.test',
    authenticateBrowserSession:async()=>null,
    authorizeHub:async()=>false,
    getHubOverview:async()=>({}),
    dispatch:async()=>({text:'hello'}),
    idempotency:{execute:async(_key,_hash,fn)=>fn()}
  };
  assert.throws(()=>createFlowPlatformGateway({
    ...base,conversationQuery:async()=>({rows:[]})
  }),/flow_conversation_owner_scoped_transaction_required/);
  assert.equal(typeof createFlowPlatformGateway({
    ...base,conversationTransaction:async fn=>fn({
      query:async()=>({rows:[]})
    })
  }),'function');
});
