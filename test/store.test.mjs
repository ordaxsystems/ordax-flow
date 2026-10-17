import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordax-gratis-'));
  return { dir, dbPath: path.join(dir, 'state.sqlite') };
}

function cleanup(t, dir, getStore) {
  t.after(() => {
    getStore()?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('Task, workspace session and versioned checkpoint survive reopen', t => {
  const { dir, dbPath } = tempStore();
  let store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const sessionId = store.getWorkspaceSession().id;
  const task = store.createTask('Persistência real');
  store.appendMessage(task.id, 'user', 'ping');
  store.appendMessage(task.id, 'assistant', 'pong');
  store.setChatUrl(task.id, 'https://chatgpt.com/c/example');
  store.checkpoint(task.id, 'safe point', { proof: 'ok' });

  store.close();
  store = new Store(dbPath);
  const restored = store.getTask(task.id);
  assert.equal(store.getWorkspaceSession().id, sessionId);
  assert.equal(restored.workspace_session_id, sessionId);
  assert.equal(restored.chat_url, 'https://chatgpt.com/c/example');
  assert.equal(restored.checkpoint_record.version, 1);
  assert.equal(restored.checkpoint_record.payload.proof, 'ok');
  assert.deepEqual(restored.messages.map(m => [m.role, m.content]), [['user', 'ping'], ['assistant', 'pong']]);
});

test('Interrupted run is explicit and resumable after reopen', t => {
  const { dir, dbPath } = tempStore();
  let store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const task = store.createTask('Crash recovery');
  store.checkpoint(task.id, 'before crash', { durable: true });
  const runId = store.startRun(task.id);
  assert.equal(store.getTask(task.id).status, 'running');

  store.close();
  store = new Store(dbPath);
  assert.equal(store.getTask(task.id).status, 'running');
  const recovered = store.recoverInterruptedRuns();
  assert.equal(recovered, 1);
  const restored = store.getTask(task.id);
  const run = store.db.prepare('SELECT status,error,completed_at FROM runs WHERE id=?').get(runId);
  assert.equal(restored.status, 'interrupted');
  assert.equal(run.status, 'interrupted');
  assert.equal(run.error, 'process_interrupted');
  assert.ok(run.completed_at);
  assert.ok(restored.events.some(event => event.kind === 'run.interrupted'));
  const capsule = store.buildResumeCapsule(task.id);
  assert.equal(capsule.checkpoint.payload.durable, true);
  assert.equal(capsule.task.status, 'interrupted');
});

test('Action and approval ledgers preserve deterministic side-effect state', t => {
  const { dir, dbPath } = tempStore();
  const store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const task = store.createTask('Ledger');
  const runId = store.startRun(task.id);
  const actionId = store.beginAction(task.id, runId, 'write_file', 'file:test.txt', { bytes: 3 });
  const approvalId = store.requestApproval(task.id, actionId, 'Alteração externa');
  assert.equal(store.pendingApprovals(task.id).length, 1);
  store.resolveApproval(task.id, approvalId, true);
  store.finishAction(task.id, actionId, 'succeeded', { sha256: 'abc' });
  store.finishRun(task.id, runId);

  const action = store.db.prepare('SELECT status,result FROM action_ledger WHERE id=?').get(actionId);
  const approval = store.db.prepare('SELECT status,resolved_at FROM approval_ledger WHERE id=?').get(approvalId);
  assert.equal(action.status, 'succeeded');
  assert.equal(JSON.parse(action.result).sha256, 'abc');
  assert.equal(approval.status, 'approved');
  assert.ok(approval.resolved_at);
  assert.equal(store.pendingApprovals(task.id).length, 0);
});

test('Store close is idempotent and releases SQLite files immediately', () => {
  const { dir, dbPath } = tempStore();
  const store = new Store(dbPath);
  store.createTask('Close lifecycle');
  store.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});

test('WAL mode is stable across reopen without reconfiguring an existing database', t => {
  const { dir, dbPath } = tempStore();
  let store = new Store(dbPath);
  cleanup(t, dir, () => store);
  assert.equal(String(store.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
  store.createTask('WAL lifecycle');
  store.close();
  store = new Store(dbPath);
  assert.equal(String(store.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
  assert.equal(store.listTasks().length, 1);
});

test('Task memory survives provider conversation rotation and seeds the next chat', t => {
  const { dir, dbPath } = tempStore();
  const store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const task = store.createTask('Livro - Horizonte');
  store.appendMessage(task.id, 'user', 'O protagonista se chama Caio.');
  store.appendMessage(task.id, 'assistant', 'Definimos Caio como protagonista e a abertura no litoral.');
  store.checkpoint(task.id, 'Caio é o protagonista; abertura no litoral.', { project: 'book' });
  store.setChatUrl(task.id, 'https://chatgpt.com/c/part-1');

  let current = store.getTask(task.id);
  assert.equal(current.conversations.length, 1);
  assert.equal(current.conversations[0].status, 'active');
  assert.equal(store.listTasks()[0].conversation_count, 1);

  current = store.rotateConversation(task.id, 'test_limit');
  assert.equal(current.chat_url, null);
  assert.equal(current.conversations[0].status, 'archived');

  const prompt = store.buildContinuationPrompt(task.id, 'Continue escrevendo o capítulo 2.');
  assert.match(prompt, /Livro - Horizonte/);
  assert.match(prompt, /Caio é o protagonista/);
  assert.match(prompt, /O protagonista se chama Caio/);
  assert.match(prompt, /Continue escrevendo o capítulo 2/);

  store.setChatUrl(task.id, 'https://chatgpt.com/c/part-2', 1);
  current = store.getTask(task.id);
  assert.equal(current.conversations.length, 2);
  assert.equal(current.conversations[0].sequence, 2);
  assert.equal(current.conversations[0].status, 'active');
  assert.equal(current.conversations[0].context_checkpoint_version, 1);
  assert.equal(current.continuation.conversation_count, 2);
  const capsule = store.buildResumeCapsule(task.id);
  assert.equal(capsule.version, 2);
  assert.equal(capsule.conversations.length, 2);
});
