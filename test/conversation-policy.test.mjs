import test from 'node:test';
import assert from 'node:assert/strict';
import { planProviderConversation, SUCCESSFUL_TURNS_PER_SEGMENT } from '../src/conversation-policy.mjs';

const makeTask = (turns, options = {}) => ({
  chat_url: options.url === undefined ? 'https://chatgpt.com/c/old' : options.url,
  conversations: options.url === null ? [] : [{
    id:'segment_old',chat_url:'https://chatgpt.com/c/old',
    status:'active',completed_turns:turns
  }]
});

test('one continuous task can hold arbitrarily many internal provider conversations', () => {
  assert.equal(SUCCESSFUL_TURNS_PER_SEGMENT,24);
  assert.equal(planProviderConversation(makeTask(23)).newSession,false);
  assert.equal(planProviderConversation(makeTask(24)).automaticRotation,true);
  assert.equal(planProviderConversation(makeTask(36)).newSession,true);
  assert.equal(planProviderConversation(makeTask(24)).reason,'completed_turn_threshold');
});

test('first and manually prepared sessions receive continuation without an automatic retry', () => {
  assert.equal(planProviderConversation(makeTask(0,{url:null})).newSession,true);
  assert.equal(planProviderConversation(makeTask(0),{forceNew:true}).newSession,true);
  assert.equal(planProviderConversation(makeTask(0)).newSession,false);
});

test('the policy does not rotate on unavailable or inconsistent segment counts', () => {
  const task={chat_url:'https://chatgpt.com/c/old',conversations:[]};
  assert.equal(planProviderConversation(task).automaticRotation,false);
  assert.equal(planProviderConversation({chat_url:task.chat_url,conversations:[{id:'other',chat_url:'https://chatgpt.com/c/different',status:'active',completed_turns:300}]}).newSession,false);
});
