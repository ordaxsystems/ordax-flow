import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const main = fs.readFileSync(path.join(root,'desktop','main.mjs'),'utf8');
const worker = fs.readFileSync(path.join(root,'desktop','embedded-worker.mjs'),'utf8');
const workerPreload = fs.readFileSync(path.join(root,'desktop','worker-preload.cjs'),'utf8');
const preload = fs.readFileSync(path.join(root,'desktop','preload.cjs'),'utf8');
const ui = fs.readFileSync(path.join(root,'desktop','ui.js'),'utf8');
const e2eLock = fs.readFileSync(path.join(root,'scripts','e2e-lock.cjs'),'utf8');
const liveText = fs.readFileSync(path.join(root,'scripts','live-ui-text-smoke.cjs'),'utf8');

test('desktop package ships only canonical desktop runtime', () => {
  assert.equal(pkg.main, 'desktop/main.mjs');
  assert.deepEqual(pkg.build.files, ['desktop/**/*','src/*.mjs','package.json']);
  assert.equal(pkg.dependencies, undefined);
  assert.ok(!JSON.stringify(pkg).includes('playwright-core'));
  assert.ok(!JSON.stringify(pkg.build.files).includes('chrome-extension'));
});

test('desktop is single-instance with canonical durable AppData state', () => {
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /OrdaX['"], ['"]Gratis/);
  assert.match(main, /recoverInterruptedRuns/);
  assert.match(main, /heartbeatRun/);
  assert.match(main, /will-quit/);
  assert.match(main, /store\.close\(\)/);
  assert.match(main, /executionTail/);
  assert.match(main, /enqueueExecution/);
  assert.match(main, /providerHealthInFlight/);
  assert.match(main, /providerHealthCache/);
  assert.match(main, /if \(base\.active\)/);
  assert.match(main, /health_pending/);
});

test('embedded ChatGPT surface is sandboxed and navigation-scoped', () => {
  assert.match(worker, /contextIsolation:\s*true/);
  assert.match(worker, /sandbox:\s*true/);
  assert.match(worker, /nodeIntegration:\s*false/);
  assert.match(worker, /setPermissionRequestHandler/);
  assert.match(worker, /will-navigate/);
  assert.match(worker, /chatgpt\\\.com\|auth\\\.openai\\\.com\|accounts\\\.google\\\.com/);
  assert.match(worker, /formReady/);
  assert.match(worker, /pending-home-input/);
  assert.match(worker, /const scope = form \|\| document/);
  assert.match(worker, /requestSubmit/);
});


test('ChatGPT worker is hidden by default and direct mode is explicit', () => {
  assert.match(main, /let chatVisible = false/);
  assert.match(ui, /directMode/);
  assert.match(ui, /setChatVisible\(false\)/);
});

test('assistant output streams into OrdaX UI through isolated worker preload', () => {
  assert.match(worker, /worker-preload\.cjs/);
  assert.match(workerPreload, /MutationObserver/);
  assert.match(workerPreload, /conversationRoot/);
  assert.match(workerPreload, /main,\[role=\"main\"\]/);
  assert.match(workerPreload, /ordax:worker:stream/);
  assert.match(main, /ordax:task:stream/);
  assert.match(preload, /onTaskStream/);
  assert.match(ui, /updateLiveRun/);
});

test('current ChatGPT DOM identity binds each run to its own assistant message', () => {
  assert.match(workerPreload, /data-chatgpt-selection-message-id/);
  assert.match(workerPreload, /data-user-message-bubble/);
  assert.match(workerPreload, /messageId/);
  assert.match(worker, /seenAssistantMessageIds/);
  assert.match(worker, /currentAssistantMessageId/);
  assert.match(worker, /latestUserText/);
  assert.match(worker, /data-user-message-bubble/);
});

test('live E2E gates are exclusive and detect cross-run leaks', () => {
  assert.match(e2eLock, /e2e\.lock/);
  assert.match(e2eLock, /e2e_lock_busy/);
  assert.match(liveText, /crossRunLeak/);
  assert.match(liveText, /providerStatus/);
});

test('send readiness is state-driven without legacy 1800ms fixed delay', () => {
  assert.doesNotMatch(worker, /sleep\(1800\)/);
  assert.match(worker, /formReady/);
  assert.match(worker, /requestSubmit/);
});


test('observer mode is persisted and fast path never replaces durable Task state', () => {
  assert.match(main, /observer_mode/);
  assert.match(main, /provider:observer-mode:set/);
  assert.match(worker, /setObserverMode/);
  assert.match(worker, /Network\.enable/);
  assert.match(worker, /networkFirstByteAt/);
  assert.match(worker, /firstObserver/);
  assert.match(worker, /lastDeliveredText/);
  assert.match(worker, /fastSuppressed/);
  assert.match(worker, /internal_tool_payload/);
  assert.match(ui, /observerMode/);
});

test('OrdaX UI exposes responsive conversation, chat and context columns', () => {
  const html = fs.readFileSync(path.join(root,'desktop','ui.html'),'utf8');
  const css = fs.readFileSync(path.join(root,'desktop','ui.css'),'utf8');
  assert.match(html, /left-rail/);
  assert.match(html, /chat-column/);
  assert.match(html, /context-rail/);
  assert.match(html, /contentAssets/);
  assert.match(html, /memorySummary/);
  assert.match(html, /structuredMemory/);
  assert.match(html, /memoryEditor/);
  assert.match(html, /conversationTimeline/);
  assert.match(html, /toggleContext/);
  assert.match(html, /closeContext/);
  assert.match(ui, /setContextOpen/);
  assert.match(css, /grid-template-columns:292px minmax\(460px,1fr\) 330px/);
  assert.match(css, /\.context-rail\.open/);
  assert.match(css, /@media \(max-width:1180px\)/);
  assert.match(css, /@media \(max-width:620px\)/);
});

test('persistent Task memory can rotate provider conversations without losing the project', () => {
  const store = fs.readFileSync(path.join(root,'src','store.mjs'),'utf8');
  assert.match(store, /task_conversations/);
  assert.match(store, /rotateConversation/);
  assert.match(store, /buildContinuationPrompt/);
  assert.match(store, /continuationSummary/);
  assert.match(main, /needsContinuation/);
  assert.match(main, /providerPrompt/);
  assert.match(preload, /rotateConversation/);
  assert.match(ui, /Nova conversa interna/);
});

test('a persistent project hides internal provider sessions and rotates only after completed turns', () => {
  const policy = fs.readFileSync(path.join(root,'src','conversation-policy.mjs'),'utf8');
  const html = fs.readFileSync(path.join(root,'desktop','ui.html'),'utf8');
  assert.match(policy, /SUCCESSFUL_TURNS_PER_SEGMENT = 24/);
  assert.match(main, /planProviderConversation/);
  assert.match(main, /conversationPlan\.newSession/);
  assert.match(main, /provider\.conversation\.auto_rotated/);
  assert.match(main, /conversation_rotation_during_run/);
  assert.match(html, /internal-diagnostics/);
  assert.match(html, /<details/);
  assert.match(ui, /Projeto contínuo/);
  assert.doesNotMatch(html, /id="rotateConversation"[^>]*Nova conversa interna/);
  assert.match(fs.readFileSync(path.join(root,'src','store.mjs'),'utf8'), /conversation_completed_runs/);
});

test('provider chat identity is canonical and unconfirmed navigation never triggers resend', () => {
  const source = fs.readFileSync(path.join(root,'src','conversation-policy.mjs'),'utf8');
  assert.match(source, /canonicalProviderChatUrl/);
  assert.match(main, /canonicalProviderChatUrl\(result\.chatUrl\)/);
  assert.match(main, /provider\.conversation\.url_unconfirmed/);
  assert.match(main, /provider_url_unconfirmed/);
  assert.doesNotMatch(main, /provider_url:\s*String\(result\.chatUrl/);
});

test('project memory suggestions are review-only and isolated from canon', () => {
  const schema = fs.readFileSync(path.join(root,'src','memory-candidates.mjs'),'utf8');
  const detector = fs.readFileSync(path.join(root,'src','memory-suggestions.mjs'),'utf8');
  const html = fs.readFileSync(path.join(root,'desktop','ui.html'),'utf8');
  assert.match(schema, /project_memory_candidates/);
  assert.match(schema, /source_message_id/);
  assert.match(schema, /BEGIN IMMEDIATE/);
  assert.match(schema, /candidate_reviewed/);
  assert.match(detector, /explicit-project-v2/);
  assert.match(main, /memory:candidates:review/);
  assert.match(preload, /reviewMemoryCandidate/);
  assert.match(ui, /renderMemoryCandidates/);
  assert.match(html, /memoryCandidates/);
  assert.match(html, /scanMemoryCandidates/);
});

test('generic project context is assembled from approved memory without truncating requests', () => {
  const store = fs.readFileSync(path.join(root,'src','store.mjs'),'utf8');
  const context = fs.readFileSync(path.join(root,'src','continuation-context.mjs'),'utf8');
  assert.match(store, /buildProjectContinuation/);
  assert.match(context, /MEMORIA PARCIAL/);
  assert.match(context, /HISTORICO PARCIAL/);
  assert.match(context, /continuation_budget_invariant_failed/);
  assert.ok(!store.includes('slice(0, 12)'));
});

test('structured project memory is editable, durable and part of continuation', () => {
  const store = fs.readFileSync(path.join(root,'src','store.mjs'),'utf8');
  assert.match(store, /project_memory_items/);
  assert.match(store, /upsertProjectMemory/);
  assert.match(store, /archiveProjectMemory/);
  assert.match(fs.readFileSync(path.join(root,'src','continuation-context.mjs'),'utf8'), /Memória estruturada canônica/);
  assert.match(main, /ordax:tasks:memory:upsert/);
  assert.match(main, /ordax:tasks:memory:archive/);
  assert.match(preload, /upsertProjectMemory/);
  assert.match(preload, /archiveProjectMemory/);
  assert.match(ui, /saveMemoryItem/);
  assert.match(ui, /memoryCategoryLabels/);
});
