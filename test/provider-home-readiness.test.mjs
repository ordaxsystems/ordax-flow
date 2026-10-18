import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReuseFreshProviderHome } from '../src/provider-home-readiness.mjs';

const ready = { found:true, formReady:true, text:'\n' };
test('reuse only ready and empty official ChatGPT home for new Task', () => {
  assert.equal(canReuseFreshProviderHome({ url:'https://chatgpt.com/', composer:ready }), true);
  assert.equal(canReuseFreshProviderHome({ url:'https://chatgpt.com/c/a2f5c18e-322f-4566-9920-1bc9670f3001', composer:ready }), false);
  assert.equal(canReuseFreshProviderHome({ url:'https://chatgpt.com/?model=gpt-6', composer:ready }), false);
  assert.equal(canReuseFreshProviderHome({ url:'https://example.com/', composer:ready }), false);
  assert.equal(canReuseFreshProviderHome({ url:'bad-url', composer:ready }), false);
});
test('never skip fresh conversation when composer has draft or is not ready', () => {
  assert.equal(canReuseFreshProviderHome({ url:'https://chatgpt.com/', composer:{...ready,text:'important old draft'} }), false);
  assert.equal(canReuseFreshProviderHome({ url:'https://chatgpt.com/', composer:{...ready,found:false} }), false);
  assert.equal(canReuseFreshProviderHome({ url:'https://chatgpt.com/', composer:{...ready,formReady:false} }), false);
});
