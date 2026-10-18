import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.mjs';

test('failed provider runs durably retain the stage and elapsed checkpoints', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordax-failed-run-metrics-'));
  const store = new Store(path.join(dir, 'state.sqlite'));
  try {
    const task = store.createTask('Performance test');
    const runId = store.startRun(task.id, 'test-worker', 'auto');
    const start = 1000;
    store.recordRunMetrics(task.id, runId, 'auto', {
      runStartedAt:start, prepareStartedAt:start, healthCompletedAt:1100,
      draftCheckedAt:1125, conversationReadyAt:1180,
      observerReadyAt:1200, baselineReadyAt:1300,
      submitAttemptAt:1400, completedAt:1900, failedStage:'submit'
    });
    store.finishRun(task.id, runId, 'submit:send_not_observed');
    const record = store.db.prepare('SELECT status,error,metrics FROM runs WHERE id=?').get(runId);
    assert.equal(record.status, 'failed');
    const metrics = JSON.parse(record.metrics);
    assert.equal(metrics.failed_stage, 'submit');
    assert.equal(metrics.prepare_ms, 400);
    assert.equal(metrics.health_ms, 100);
    assert.equal(metrics.conversation_prepare_ms, 55);
    assert.equal(metrics.submit_confirm_ms, null);
    assert.equal(record.error, 'submit:send_not_observed');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive:true, force:true });
  }
});
