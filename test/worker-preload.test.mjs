import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const workerPreload = fs.readFileSync(
  fileURLToPath(new URL('../desktop/worker-preload.cjs', import.meta.url)), 'utf8'
);

function observe({ generating, previous = true, wrapped = false }) {
  const markdown = { innerText:'RESPOSTA_NOVA_PARCIAL', querySelectorAll:() => [] };
  const previousNode = {
    innerText:'RESPOSTA_ANTERIOR',
    contains:node => wrapped && node === markdown,
    getAttribute:name => name === 'data-chatgpt-selection-message-id' ? 'message_previous' : null,
    querySelector:() => null, querySelectorAll:() => [],
    hasAttribute:() => false
  };
  const userNode = { innerText:'Pergunta atual' };
  const document = {
    readyState:'loading',
    querySelectorAll:selector => {
      if (selector.includes('[data-chatgpt-selection-message-id]')) return previous ? [previousNode] : [];
      if (selector.includes('[data-message-author-role="user"]')) return [userNode];
      if (selector === '[data-markdown-text-style="assistant-message"]') return [markdown];
      return [];
    },
    querySelector:selector => selector.includes('stop-button') ? (generating ? {} : null) : null
  };
  const sandbox = {
    document,
    location:{ href:'https://chatgpt.com/c/test' },
    window:{ addEventListener:() => {} },
    require:name => {
      if (name !== 'electron') throw new Error('unexpected_dependency');
      return { ipcRenderer:{ send() {} } };
    },
    setTimeout:() => 0, clearTimeout() {},
    MutationObserver:class { observe() {} disconnect() {} },
    Date
  };
  vm.runInNewContext(workerPreload + '\n;globalThis.testSnapshot=snapshot;', sandbox);
  return sandbox.testSnapshot();
}

test('Beta uses current provisional assistant Markdown instead of an older completed message', () => {
  const state = observe({ generating:true });
  assert.equal(state.mode, 'direct');
  assert.equal(state.assistantCount, 2);
  assert.equal(state.messageId, '');
  assert.equal(state.latestUserText, 'Pergunta atual');
  assert.equal(state.text, 'RESPOSTA_NOVA_PARCIAL');
  assert.equal(state.generating, true);
  assert.equal(state.complete, false);
});

test('Beta respects the message wrapper once provisional markdown belongs to that message', () => {
  const state = observe({ generating:true, wrapped:true });
  assert.equal(state.mode, 'direct');
  assert.equal(state.assistantCount, 1);
  assert.equal(state.messageId, 'message_previous');
  assert.equal(state.text, 'RESPOSTA_ANTERIOR');
});

test('Beta never replaces completed assistant output with detached markdown outside generation', () => {
  const state = observe({ generating:false });
  assert.equal(state.messageId, 'message_previous');
  assert.equal(state.text, 'RESPOSTA_ANTERIOR');
  assert.equal(state.generating, false);
});

test('Beta observes provisional markdown even before the first final assistant wrapper exists', () => {
  const state = observe({ generating:true, previous:false });
  assert.equal(state.assistantCount, 1);
  assert.equal(state.text, 'RESPOSTA_NOVA_PARCIAL');
  assert.equal(state.messageId, '');
});
