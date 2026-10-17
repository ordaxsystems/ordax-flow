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

test('Task, workspace session and versioned checkpoint survive reopen', () => {
  const { dbPath } = tempStore();
  let store = new Store(dbPath);
  const sessionId = store.getWorkspaceSession().id;
  const task = store.createTask('Persistência real');
  store.appendMessage(task.id, 'user', 'ping');
  store.appendMessage(task.id, 'assistant', 'pong');
  store.setChatUrl(task.id, 'https://chatgpt.com/c/example');
  store.checkpoint(task.id, 'safe point', { proof: 'ok' });

  store = new Store(dbPath);
  const restored = store.getTask(task.id);
  assert.equal(store.getWorkspaceSession().id, sessionId);
  assert.equal(restored.workspace_session_id, sessionId);
  assert.equal(restored.chat_url, 'https://chatgpt.com/c/example');
  assert.equal(restored.checkpoint_record.version, 1);
  assert.equal(restored.checkpoint_record.payload.proof, 'ok');
  assert.deepEqual(restored.messages.map(m => [m.role, m.content]), [['user', 'ping'], ['assistant', 'pong']]);
});

test('Interrupted run is explicit and resumable after reopen', () => {
  const { dbPath } = tempStore();
  let store = new Store(dbPath);
  const task = store.createTask('Crash recovery');
  store.checkpoint(task.id, 'before crash', { durable: true });
  const runId = store.startRun(task.id);
  assert.equal(store.getTask(task.id).status, 'running');

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

test('Action and approval ledgers preserve deterministic side-effect state', () => {
  const { dbPath } = tempStore();
  const store = new Store(dbPath);
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
