import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertProviderDraftAllowed, ensureEmptyNewComposer } from '../src/provider-composer-transition.mjs';

test('new task may begin with a stale draft in the old ChatGPT composer', () => {
  assert.doesNotThrow(() => assertProviderDraftAllowed({ newConversation:true, draftText:'old unsent input' }));
});

test('continuing an existing ChatGPT conversation still protects a typed draft', () => {
  assert.throws(() => assertProviderDraftAllowed({ newConversation:false, draftText:'keep this' }), /chatgpt_draft_present/);
  assert.doesNotThrow(() => assertProviderDraftAllowed({ newConversation:false, draftText:'  ' }));
});

test('new conversation rechecks and clears only the new provider composer', async () => {
  let text='old draft persisted across navigation',clearCalls=0;
  const state=async()=>({found:true,formReady:true,text});
  await ensureEmptyNewComposer({readComposer:state,clearComposer:async()=>{clearCalls++;text=''}});
  assert.equal(clearCalls,1);
  await ensureEmptyNewComposer({readComposer:state,clearComposer:async()=>{clearCalls++}});
  assert.equal(clearCalls,1);
});

test('never sends if new composer fails to clear or is not usable', async () => {
  await assert.rejects(() => ensureEmptyNewComposer({
    readComposer:async()=>({found:true,formReady:true,text:'still here'}),
    clearComposer:async()=>{}
  }),/new_chat_composer_not_empty/);
  await assert.rejects(() => ensureEmptyNewComposer({
    readComposer:async()=>({found:false,formReady:false,text:''}),
    clearComposer:async()=>{throw Error('must not clear')}
  }),/new_chat_composer_unavailable/);
});
