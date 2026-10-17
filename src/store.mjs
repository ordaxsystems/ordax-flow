import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

export class Store {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS workspace_sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        chat_url TEXT,
        checkpoint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_assets (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        local_path TEXT NOT NULL,
        alt TEXT,
        width INTEGER,
        height INTEGER,
        sha256 TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_assets_message ON message_assets(message_id, created_at, id);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        event_seq INTEGER NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, version)
      );
      CREATE TABLE IF NOT EXISTS action_ledger (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT,
        action_type TEXT NOT NULL,
        resource_key TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_action_ledger_task ON action_ledger(task_id, created_at, id);
      CREATE TABLE IF NOT EXISTS approval_ledger (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        action_id TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approval_ledger_task ON approval_ledger(task_id, created_at, id);
    `);
    this.ensureColumn('tasks', 'workspace_session_id', 'TEXT');
    this.ensureColumn('runs', 'worker_id', 'TEXT');
    this.ensureColumn('runs', 'heartbeat_at', 'TEXT');
    this.ensureColumn('runs', 'observer_mode', 'TEXT');
    this.ensureColumn('runs', 'metrics', 'TEXT');
    this.workspaceSession = this.ensureWorkspaceSession();
    this.db.prepare("UPDATE tasks SET workspace_session_id=? WHERE workspace_session_id IS NULL OR workspace_session_id=''")
      .run(this.workspaceSession.id);
    this.backfillLegacyCheckpoints();
  }

  now() { return new Date().toISOString(); }

  backfillLegacyCheckpoints() {
    const rows = this.db.prepare(`
      SELECT t.id,t.checkpoint,t.updated_at
      FROM tasks t
      WHERE t.checkpoint IS NOT NULL AND TRIM(t.checkpoint) <> ''
        AND NOT EXISTS (SELECT 1 FROM checkpoints c WHERE c.task_id=t.id)
    `).all();
    for (const row of rows) {
      const eventSeq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE task_id=?').get(row.id)?.seq || 0);
      const checkpointId = `checkpoint_${randomUUID()}`;
      this.db.prepare('INSERT INTO checkpoints(id,task_id,version,event_seq,summary,payload,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(checkpointId, row.id, 1, eventSeq, row.checkpoint, JSON.stringify({ migrated_from_legacy: true }), row.updated_at || this.now());
      this.event(row.id, 'task.checkpoint.migrated', { checkpoint_id: checkpointId, version: 1, event_seq: eventSeq });
    }
    return rows.length;
  }

  ensureColumn(table, column, type) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  ensureWorkspaceSession() {
    const existing = this.db.prepare("SELECT * FROM workspace_sessions WHERE status='active' ORDER BY created_at LIMIT 1").get();
    if (existing) return { ...existing, metadata: JSON.parse(existing.metadata || '{}') };
    const id = `session_${randomUUID()}`;
    const now = this.now();
    this.db.prepare('INSERT INTO workspace_sessions(id,status,metadata,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(id, 'active', '{}', now, now);
    return { id, status: 'active', metadata: {}, created_at: now, updated_at: now };
  }

  getWorkspaceSession() {
    const row = this.db.prepare('SELECT * FROM workspace_sessions WHERE id=?').get(this.workspaceSession.id);
    return row ? { ...row, metadata: JSON.parse(row.metadata || '{}') } : null;
  }

  updateWorkspaceMetadata(patch = {}) {
    const current = this.getWorkspaceSession();
    const metadata = { ...(current?.metadata || {}), ...patch };
    const now = this.now();
    this.db.prepare('UPDATE workspace_sessions SET metadata=?,updated_at=? WHERE id=?')
      .run(JSON.stringify(metadata), now, this.workspaceSession.id);
    return this.getWorkspaceSession();
  }

  event(taskId, kind, payload = {}) {
    const now = this.now();
    const result = this.db.prepare('INSERT INTO events(task_id,kind,payload,created_at) VALUES(?,?,?,?)')
      .run(taskId, kind, JSON.stringify(payload), now);
    return Number(result.lastInsertRowid);
  }

  createTask(title = 'Nova tarefa') {
    const id = `task_${randomUUID()}`;
    const now = this.now();
    this.db.prepare('INSERT INTO tasks(id,title,status,workspace_session_id,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, title.trim() || 'Nova tarefa', 'ready', this.workspaceSession.id, now, now);
    this.event(id, 'task.created', { title, workspace_session_id: this.workspaceSession.id });
    return this.getTask(id);
  }

  listTasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all(); }

  getTask(id) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!task) return null;
    return {
      ...task,
      messages: this.messages(id),
      events: this.events(id, 100),
      checkpoint_record: this.latestCheckpoint(id),
      pending_approvals: this.pendingApprovals(id)
    };
  }

  messages(taskId) {
    const rows = this.db.prepare('SELECT id,role,content,created_at FROM messages WHERE task_id=? ORDER BY created_at,id').all(taskId);
    return rows.map(row => ({ ...row, assets: this.assetsForMessage(row.id) }));
  }

  assetsForMessage(messageId) {
    return this.db.prepare(`
      SELECT id,kind,mime_type,alt,width,height,sha256,created_at
      FROM message_assets WHERE message_id=? ORDER BY created_at,id
    `).all(messageId).map(asset => ({ ...asset, url: `/api/assets/${encodeURIComponent(asset.id)}` }));
  }

  getAsset(id) { return this.db.prepare('SELECT * FROM message_assets WHERE id=?').get(id) || null; }

  addAsset(taskId, messageId, asset) {
    const id = asset.id || `asset_${randomUUID()}`;
    const now = this.now();
    this.db.prepare(`
      INSERT INTO message_assets(id,task_id,message_id,kind,mime_type,local_path,alt,width,height,sha256,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, taskId, messageId, asset.kind || 'image', asset.mimeType, asset.localPath,
      asset.alt || null, asset.width || null, asset.height || null, asset.sha256 || null, now);
    this.event(taskId, 'message.asset_added', { id, message_id: messageId, kind: asset.kind || 'image', mime_type: asset.mimeType });
    return { id, kind: asset.kind || 'image', mime_type: asset.mimeType, alt: asset.alt || null,
      width: asset.width || null, height: asset.height || null, sha256: asset.sha256 || null,
      created_at: now, url: `/api/assets/${encodeURIComponent(id)}` };
  }

  events(taskId, limit = 100) {
    const rows = this.db.prepare('SELECT seq,kind,payload,created_at FROM events WHERE task_id=? ORDER BY seq DESC LIMIT ?').all(taskId, limit);
    return rows.reverse().map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  appendMessage(taskId, role, content) {
    const id = `msg_${randomUUID()}`;
    const now = this.now();
    this.db.prepare('INSERT INTO messages(id,task_id,role,content,created_at) VALUES(?,?,?,?,?)')
      .run(id, taskId, role, content, now);
    this.touch(taskId);
    this.event(taskId, 'message.appended', { id, role });
    return { id, role, content, created_at: now, assets: [] };
  }

  touch(id) { this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(this.now(), id); }

  setChatUrl(id, url) {
    this.db.prepare('UPDATE tasks SET chat_url=?,updated_at=? WHERE id=?').run(url, this.now(), id);
    this.event(id, 'provider.chat.bound', { url });
  }

  checkpoint(id, summary, payload = {}) {
    const now = this.now();
    const version = Number(this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM checkpoints WHERE task_id=?').get(id)?.version || 1);
    const eventSeq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE task_id=?').get(id)?.seq || 0);
    const checkpointId = `checkpoint_${randomUUID()}`;
    this.db.prepare('INSERT INTO checkpoints(id,task_id,version,event_seq,summary,payload,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(checkpointId, id, version, eventSeq, summary, JSON.stringify(payload || {}), now);
    this.db.prepare('UPDATE tasks SET checkpoint=?,updated_at=? WHERE id=?').run(summary, now, id);
    this.event(id, 'task.checkpoint', { checkpoint_id: checkpointId, version, event_seq: eventSeq, summary });
    return this.latestCheckpoint(id);
  }

  latestCheckpoint(taskId) {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE task_id=? ORDER BY version DESC LIMIT 1').get(taskId);
    return row ? { ...row, payload: JSON.parse(row.payload || '{}') } : null;
  }

  startRun(taskId, workerId = 'electron-embedded-chatgpt', observerMode = 'auto') {
    const id = `run_${randomUUID()}`;
    const now = this.now();
    this.db.prepare('INSERT INTO runs(id,task_id,status,worker_id,heartbeat_at,observer_mode,started_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, taskId, 'running', workerId, now, observerMode, now);
    this.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run('running', now, taskId);
    this.event(taskId, 'run.started', { run_id: id, worker_id: workerId, observer_mode: observerMode });
    return id;
  }

  recordRunMetrics(taskId, runId, observerMode, metrics = {}) {
    const normalized = {
      observer_mode: observerMode,
      run_started_at: metrics?.runStartedAt || null,
      submit_attempt_at: metrics?.submitAttemptAt || null,
      provider_request_seen_at: metrics?.providerRequestSeenAt || null,
      submitted_at: metrics?.submittedAt || null,
      first_delta_at: metrics?.firstDeltaAt || null,
      fast_first_delta_at: metrics?.fastFirstDeltaAt || null,
      beta_first_delta_at: metrics?.betaFirstDeltaAt || null,
      network_first_byte_at: metrics?.networkFirstByteAt || null,
      completed_at: metrics?.completedAt || null,
      ttfs_ms: metrics?.submittedAt && metrics?.firstDeltaAt ? Math.max(0, metrics.firstDeltaAt - metrics.submittedAt) : null,
      prepare_ms: metrics?.runStartedAt && metrics?.submitAttemptAt ? Math.max(0, metrics.submitAttemptAt - metrics.runStartedAt) : null,
      request_seen_ms: metrics?.submitAttemptAt && metrics?.providerRequestSeenAt ? Math.max(0, metrics.providerRequestSeenAt - metrics.submitAttemptAt) : null,
      submit_confirm_ms: metrics?.submitAttemptAt && metrics?.submittedAt ? Math.max(0, metrics.submittedAt - metrics.submitAttemptAt) : null,
      network_ttfs_ms: metrics?.submitAttemptAt && metrics?.networkFirstByteAt ? Math.max(0, metrics.networkFirstByteAt - metrics.submitAttemptAt) : null,
      attempt_to_first_delta_ms: metrics?.submitAttemptAt && metrics?.firstDeltaAt ? Math.max(0, metrics.firstDeltaAt - metrics.submitAttemptAt) : null,
      fast_ttfs_ms: metrics?.submitAttemptAt && metrics?.fastFirstDeltaAt ? Math.max(0, metrics.fastFirstDeltaAt - metrics.submitAttemptAt) : null,
      beta_ttfs_ms: metrics?.submitAttemptAt && metrics?.betaFirstDeltaAt ? Math.max(0, metrics.betaFirstDeltaAt - metrics.submitAttemptAt) : null,
      fast_lead_ms: metrics?.fastFirstDeltaAt && metrics?.betaFirstDeltaAt ? Math.max(0, metrics.betaFirstDeltaAt - metrics.fastFirstDeltaAt) : null,
      total_ms: metrics?.submitAttemptAt && metrics?.completedAt ? Math.max(0, metrics.completedAt - metrics.submitAttemptAt) : null,
      observer_used: metrics?.observerUsed || 'beta'
    };
    this.db.prepare('UPDATE runs SET observer_mode=?,metrics=? WHERE id=?').run(observerMode, JSON.stringify(normalized), runId);
    this.event(taskId, 'run.metrics', { run_id: runId, ...normalized });
    return normalized;
  }

  heartbeatRun(_taskId, runId) {
    const now = this.now();
    this.db.prepare('UPDATE runs SET heartbeat_at=? WHERE id=? AND status=?').run(now, runId, 'running');
  }

  finishRun(taskId, runId, error = null) {
    const status = error ? 'failed' : 'succeeded';
    const now = this.now();
    this.db.prepare('UPDATE runs SET status=?,completed_at=?,heartbeat_at=?,error=? WHERE id=?')
      .run(status, now, now, error, runId);
    this.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(error ? 'error' : 'ready', now, taskId);
    this.event(taskId, error ? 'run.failed' : 'run.succeeded', { run_id: runId, error });
  }

  recoverInterruptedRuns() {
    const running = this.db.prepare("SELECT id,task_id FROM runs WHERE status='running'").all();
    if (!running.length) return 0;
    const now = this.now();
    for (const run of running) {
      this.db.prepare("UPDATE runs SET status='interrupted',completed_at=?,heartbeat_at=?,error='process_interrupted' WHERE id=?")
        .run(now, now, run.id);
      this.db.prepare("UPDATE tasks SET status='interrupted',updated_at=? WHERE id=?").run(now, run.task_id);
      this.event(run.task_id, 'run.interrupted', { run_id: run.id, reason: 'process_interrupted' });
    }
    return running.length;
  }

  beginAction(taskId, runId, actionType, resourceKey = null, payload = {}) {
    const id = `action_${randomUUID()}`;
    const now = this.now();
    this.db.prepare('INSERT INTO action_ledger(id,task_id,run_id,action_type,resource_key,status,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, taskId, runId || null, actionType, resourceKey, 'pending', JSON.stringify(payload), now, now);
    this.event(taskId, 'action.pending', { action_id: id, action_type: actionType, resource_key: resourceKey });
    return id;
  }

  finishAction(taskId, actionId, status, result = null) {
    if (!['succeeded', 'failed', 'indeterminate', 'cancelled'].includes(status)) throw new Error('invalid_action_status');
    const now = this.now();
    this.db.prepare('UPDATE action_ledger SET status=?,result=?,updated_at=? WHERE id=?')
      .run(status, result == null ? null : JSON.stringify(result), now, actionId);
    this.event(taskId, `action.${status}`, { action_id: actionId, result });
  }

  requestApproval(taskId, actionId = null, reason = '') {
    const id = `approval_${randomUUID()}`;
    const now = this.now();
    this.db.prepare('INSERT INTO approval_ledger(id,task_id,action_id,status,reason,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, taskId, actionId, 'pending', reason || null, now);
    this.event(taskId, 'approval.requested', { approval_id: id, action_id: actionId, reason });
    return id;
  }

  resolveApproval(taskId, approvalId, approved) {
    const status = approved ? 'approved' : 'rejected';
    const now = this.now();
    this.db.prepare('UPDATE approval_ledger SET status=?,resolved_at=? WHERE id=?').run(status, now, approvalId);
    this.event(taskId, `approval.${status}`, { approval_id: approvalId });
  }

  pendingApprovals(taskId) {
    return this.db.prepare("SELECT * FROM approval_ledger WHERE task_id=? AND status='pending' ORDER BY created_at,id").all(taskId);
  }

  buildResumeCapsule(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    return {
      version: 1,
      workspace_session_id: task.workspace_session_id,
      task: { id: task.id, title: task.title, status: task.status, chat_url: task.chat_url },
      checkpoint: task.checkpoint_record,
      recent_messages: task.messages.slice(-8).map(({ role, content, created_at, assets }) => ({
        role, content, created_at, assets: (assets || []).map(({ id, kind, mime_type, alt }) => ({ id, kind, mime_type, alt }))
      })),
      recent_events: task.events.slice(-20),
      pending_approvals: task.pending_approvals
    };
  }
}
