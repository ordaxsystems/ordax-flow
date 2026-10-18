import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { MemoryCandidateLedger } from './memory-candidates.mjs';
import { canonicalProviderChatUrl } from './conversation-policy.mjs';
import { buildProjectContinuation } from './continuation-context.mjs';

const SQLITE_OPEN_RETRY_DELAYS_MS = [0, 40, 80, 160, 320, 640, 1280];
const sqliteOpenWait = new Int32Array(new SharedArrayBuffer(4));
const PROJECT_MEMORY_CATEGORIES = new Set(['entity','structure','fact','decision','constraint','goal','open_loop','reference']);
const PROJECT_MEMORY_SOURCE_TYPES = new Set(['manual','message','checkpoint','import','system']);
export const MESSAGE_PAGE_SIZE = 50;

function isTransientSqliteOpenError(error) {
  const message = String(error?.message || error || '');
  return /disk I\/O error|database is locked|database is busy|SQLITE_(?:IOERR|BUSY|LOCKED)/i.test(message);
}

function openConfiguredDatabase(filePath) {
  let lastError = null;
  for (let attempt = 0; attempt < SQLITE_OPEN_RETRY_DELAYS_MS.length; attempt++) {
    const delay = SQLITE_OPEN_RETRY_DELAYS_MS[attempt];
    if (delay) Atomics.wait(sqliteOpenWait, 0, 0, delay);
    let db = null;
    try {
      db = new DatabaseSync(filePath);
      db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      const journalMode = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase();
      if (journalMode !== 'wal') db.prepare('PRAGMA journal_mode=WAL').get();
      return { db, retryCount: attempt };
    } catch (error) {
      lastError = error;
      try { db?.close(); } catch {}
      if (!isTransientSqliteOpenError(error) || attempt === SQLITE_OPEN_RETRY_DELAYS_MS.length - 1) throw error;
    }
  }
  throw lastError || new Error('sqlite_open_failed');
}

export class Store {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const opened = openConfiguredDatabase(filePath);
    this.db = opened.db;
    this.openRetryCount = opened.retryCount;
    this.db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_messages_task_time ON messages(task_id, created_at, id);
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
      CREATE TABLE IF NOT EXISTS task_conversations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        chat_url TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        context_checkpoint_version INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        UNIQUE(task_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_task_conversations_task ON task_conversations(task_id, sequence);
      CREATE TABLE IF NOT EXISTS conversation_completed_runs (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES task_conversations(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_completed_runs_segment ON conversation_completed_runs(conversation_id);

      CREATE TABLE IF NOT EXISTS project_memory_items (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        memory_key TEXT NOT NULL COLLATE NOCASE,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        UNIQUE(task_id, category, memory_key)
      );
      CREATE INDEX IF NOT EXISTS idx_project_memory_task ON project_memory_items(task_id, status, category, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_memory_key_nocase ON project_memory_items(task_id, category, memory_key COLLATE NOCASE);
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
    this.ensureColumn('tasks', 'draft', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('tasks', 'draft_revision', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('tasks', 'draft_updated_at', 'TEXT');
    this.ensureColumn('runs', 'worker_id', 'TEXT');
    this.ensureColumn('runs', 'heartbeat_at', 'TEXT');
    this.ensureColumn('runs', 'observer_mode', 'TEXT');
    this.ensureColumn('runs', 'metrics', 'TEXT');
    this.memoryCandidates = new MemoryCandidateLedger(this);
    this.workspaceSession = this.ensureWorkspaceSession();
    this.db.prepare("UPDATE tasks SET workspace_session_id=? WHERE workspace_session_id IS NULL OR workspace_session_id=''")
      .run(this.workspaceSession.id);
    this.backfillLegacyCheckpoints();
    this.backfillLegacyConversations();
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

  backfillLegacyConversations() {
    const rows = this.db.prepare(`SELECT id,chat_url,created_at,updated_at FROM tasks WHERE chat_url IS NOT NULL AND TRIM(chat_url) <> '' AND NOT EXISTS (SELECT 1 FROM task_conversations c WHERE c.task_id=tasks.id)`).all();
    for (const row of rows) {
      this.db.prepare('INSERT INTO task_conversations(id,task_id,sequence,chat_url,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(`conversation_${randomUUID()}`, row.id, 1, row.chat_url, 'active', row.created_at || this.now(), row.updated_at || this.now());
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

  listTasks() {
    // Navigation needs metadata only. Do not clone drafts, checkpoints or provider
    // URLs for every item of a potentially huge sidebar.
    return this.db.prepare(`SELECT t.id,t.title,t.status,t.created_at,t.updated_at,
      (SELECT COUNT(*) FROM task_conversations c WHERE c.task_id=t.id) AS conversation_count,
      (SELECT COUNT(*) FROM project_memory_candidates c WHERE c.task_id=t.id AND c.status='pending') AS pending_memory_count
      FROM tasks t ORDER BY t.updated_at DESC`).all();
  }

  renameTask(taskId, title) {
    const name = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 140) throw new Error('invalid_task_title');
    const previous = this.db.prepare('SELECT title FROM tasks WHERE id=?').get(taskId);
    if (!previous) throw new Error('task_not_found');
    if (previous.title !== name) {
      this.db.prepare('UPDATE tasks SET title=?,updated_at=? WHERE id=?').run(name, this.now(), taskId);
      this.event(taskId, 'task.renamed', { previous_title:previous.title, title:name });
    }
    return this.getTask(taskId);
  }

  // Revisions prevent delayed renderer saves from restoring a draft already sent.
  // Draft updates do not reorder Tasks or become conversation messages/events.
  setDraft(taskId, content, revision) {
    const text = String(content ?? '');
    const version = Number(revision);
    if (text.length > 20000) throw new Error('task_draft_too_large');
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('invalid_task_draft_revision');
    if (!this.db.prepare('SELECT id FROM tasks WHERE id=?').get(taskId)) throw new Error('task_not_found');
    this.db.prepare('UPDATE tasks SET draft=?,draft_revision=?,draft_updated_at=? WHERE id=? AND draft_revision<?')
      .run(text, version, this.now(), taskId, version);
    return this.db.prepare('SELECT draft,draft_revision,draft_updated_at FROM tasks WHERE id=?').get(taskId);
  }

  getTask(id, { messageLimit = null } = {}) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!task) return null;
    // One snapshot per view: derived metadata reuses these same canonical reads.
    const page = messageLimit == null ? null : this.messagesPage(id, { limit:messageLimit });
    const messages = page ? page.messages : this.messages(id);
    const checkpoint = this.latestCheckpoint(id);
    const conversations = this.listConversations(id);
    const projectMemory = this.projectMemorySummary(id);
    const pendingCount = this.memoryCandidates.pendingCount(id);
    return {
      ...task,
      messages,
      ...(page ? { message_page:{ has_more:page.has_more, next_cursor:page.next_cursor, page_size:page.page_size } } : {}),
      events: this.events(id, 100),
      checkpoint_record: checkpoint,
      pending_approvals: this.pendingApprovals(id),
      conversations,
      project_memory: {
        items: this.listProjectMemory(id),
        summary: projectMemory,
        candidates: this.memoryCandidates.list(id),
        pending_count: pendingCount
      },
      continuation: this.continuationSummary(id, {
        task, checkpoint, conversations, projectMemory, pendingCount,
        totalMessages:page ? page.total_messages : messages.length
      })
    };
  }

  // Execution reads only the fields required by the provider conversation policy.
  // Messages, checkpoints and conversation history remain canonical in SQLite.
  getTaskExecutionSnapshot(taskId) {
    const task = this.db.prepare(`SELECT t.id,t.chat_url,
      EXISTS(SELECT 1 FROM messages m WHERE m.task_id=t.id) AS has_messages,
      COALESCE((SELECT MAX(version) FROM checkpoints c WHERE c.task_id=t.id),0) AS checkpoint_version
      FROM tasks t WHERE t.id=?`).get(taskId);
    if (!task) return null;
    const active = this.db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM conversation_completed_runs r WHERE r.conversation_id=c.id) AS completed_turns
      FROM task_conversations c WHERE c.task_id=? AND c.status='active'
      ORDER BY c.sequence DESC LIMIT 1`).get(taskId);
    return { ...task, conversations:active ? [active] : [] };
  }

  // Immutable keyset cursors use the existing (created_at,id) SQLite ordering.
  // No separate index, page cache, offset-based scans, or replicated history.
  encodeMessageCursor(message) {
    return Buffer.from(JSON.stringify([message.created_at, message.id])).toString('base64url');
  }

  decodeMessageCursor(cursor) {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{8,512}$/.test(cursor)) throw new Error('invalid_message_cursor');
    try {
      const raw = Buffer.from(cursor, 'base64url');
      const tuple = JSON.parse(raw.toString('utf8'));
      if (raw.toString('base64url') !== cursor || !Array.isArray(tuple) || tuple.length !== 2 ||
        typeof tuple[0] !== 'string' || !tuple[0] || tuple[0].length > 64 ||
        typeof tuple[1] !== 'string' || !tuple[1] || tuple[1].length > 200) throw new Error('invalid_message_cursor');
      return tuple;
    } catch { throw new Error('invalid_message_cursor'); }
  }

  messagesPage(taskId, { before = null, limit = MESSAGE_PAGE_SIZE } = {}) {
    const size = Number(limit);
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error('invalid_message_page_size');
    const messages = this.messages(taskId, { before, limit:size + 1 });
    const hasMore = messages.length > size;
    const page = hasMore ? messages.slice(1) : messages;
    return {
      messages:page,
      has_more:hasMore,
      next_cursor:hasMore ? this.encodeMessageCursor(page[0]) : null,
      page_size:size,
      total_messages:Number(this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE task_id=?').get(taskId)?.n || 0)
    };
  }

  // The canonical message order is shared by full UI history and bounded context.
  // Fetch assets in one batch instead of querying SQLite once per message.
  messages(taskId, { limit = null, before = null } = {}) {
    const bounded = Number.isSafeInteger(limit) && limit > 0;
    if (!bounded && before != null) throw new Error('invalid_message_cursor');
    const cursor = before == null ? null : this.decodeMessageCursor(before);
    const rows = bounded
      ? cursor
        ? this.db.prepare(`SELECT id,role,content,created_at FROM messages WHERE task_id=?
          AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC,id DESC LIMIT ?`).all(taskId, cursor[0], cursor[0], cursor[1], limit).reverse()
        : this.db.prepare('SELECT id,role,content,created_at FROM messages WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(taskId, limit).reverse()
      : this.db.prepare('SELECT id,role,content,created_at FROM messages WHERE task_id=? ORDER BY created_at,id').all(taskId);
    if (!rows.length) return [];
    const assets = new Map();
    // The bounded continuation path needs at most eight messages. For full history,
    // task-scoped assets remain a single indexed query regardless of message count.
    const assetRows = bounded
      ? this.db.prepare(`SELECT message_id,id,kind,mime_type,alt,width,height,sha256,created_at FROM message_assets
          WHERE message_id IN (${rows.map(() => '?').join(',')}) ORDER BY created_at,id`).all(...rows.map(row => row.id))
      : this.db.prepare('SELECT message_id,id,kind,mime_type,alt,width,height,sha256,created_at FROM message_assets WHERE task_id=? ORDER BY created_at,id').all(taskId);
    for (const { message_id, ...asset } of assetRows) {
      if (!assets.has(message_id)) assets.set(message_id, []);
      assets.get(message_id).push({ ...asset, url: `/api/assets/${encodeURIComponent(asset.id)}` });
    }
    return rows.map(row => ({ ...row, assets: assets.get(row.id) || [] }));
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
    if (role === 'user') this.memoryCandidates.suggestFromMessage(taskId, { id, role, content });
    return { id, role, content, created_at: now, assets: [] };
  }

  touch(id) { this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(this.now(), id); }

  listProjectMemory(taskId, { includeArchived = false } = {}) {
    const where = includeArchived ? 'task_id=?' : "task_id=? AND status='active'";
    return this.db.prepare(`
      SELECT id,task_id,category,memory_key AS key,content,status,source_type,source_ref,created_at,updated_at,archived_at
      FROM project_memory_items WHERE ${where}
      ORDER BY CASE category
        WHEN 'goal' THEN 1 WHEN 'constraint' THEN 2 WHEN 'decision' THEN 3 WHEN 'entity' THEN 4
        WHEN 'structure' THEN 5 WHEN 'fact' THEN 6 WHEN 'open_loop' THEN 7 ELSE 8 END,
        updated_at DESC,id
    `).all(taskId);
  }

  projectMemorySummary(taskId) {
    const rows = this.db.prepare("SELECT category,COUNT(*) AS n FROM project_memory_items WHERE task_id=? AND status='active' GROUP BY category ORDER BY category").all(taskId);
    return {
      total: rows.reduce((sum, row) => sum + Number(row.n || 0), 0),
      by_category: Object.fromEntries(rows.map(row => [row.category, Number(row.n || 0)]))
    };
  }

  upsertProjectMemory(taskId, item = {}) {
    if (!this.db.prepare('SELECT id FROM tasks WHERE id=?').get(taskId)) throw new Error('task_not_found');
    const category = String(item.category || '').trim().toLowerCase();
    const key = String(item.key || '').replace(/\s+/g, ' ').trim();
    const content = String(item.content || '').trim();
    const sourceType = String(item.source_type || 'manual').trim().toLowerCase();
    const sourceRef = item.source_ref == null ? null : String(item.source_ref).trim() || null;
    if (!PROJECT_MEMORY_CATEGORIES.has(category)) throw new Error('invalid_project_memory_category');
    if (!key) throw new Error('project_memory_key_required');
    if (!content) throw new Error('project_memory_content_required');
    if (!PROJECT_MEMORY_SOURCE_TYPES.has(sourceType)) throw new Error('invalid_project_memory_source');
    if (key.length > 160 || content.length > 8000) throw new Error('project_memory_too_large');

    const now = this.now();
    const requestedId = item.id == null ? null : String(item.id).trim() || null;
    const existingById = requestedId ? this.db.prepare('SELECT id FROM project_memory_items WHERE task_id=? AND id=?').get(taskId, requestedId) : null;
    if (requestedId && !existingById) throw new Error('project_memory_not_found');
    const existingByKey = this.db.prepare('SELECT id,memory_key FROM project_memory_items WHERE task_id=? AND category=? AND memory_key COLLATE NOCASE=?').get(taskId, category, key);
    if (existingById && existingByKey && existingById.id !== existingByKey.id) throw new Error('project_memory_key_conflict');
    const id = existingById?.id || existingByKey?.id || `memory_${randomUUID()}`;
    if (existingById || existingByKey) {
      const storedKey = existingById ? key : existingByKey.memory_key;
      this.db.prepare("UPDATE project_memory_items SET category=?,memory_key=?,content=?,status='active',source_type=?,source_ref=?,updated_at=?,archived_at=NULL WHERE id=?")
        .run(category, storedKey, content, sourceType, sourceRef, now, id);
    } else {
      this.db.prepare('INSERT INTO project_memory_items(id,task_id,category,memory_key,content,status,source_type,source_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, taskId, category, key, content, 'active', sourceType, sourceRef, now, now);
    }
    this.touch(taskId);
    this.event(taskId, 'project_memory.upserted', { memory_id:id, category, key, source_type:sourceType, source_ref:sourceRef });
    return this.listProjectMemory(taskId).find(row => row.id === id) || null;
  }

  archiveProjectMemory(taskId, memoryId) {
    const row = this.db.prepare('SELECT id,category,memory_key FROM project_memory_items WHERE id=? AND task_id=?').get(memoryId, taskId);
    if (!row) throw new Error('project_memory_not_found');
    const now = this.now();
    this.db.prepare("UPDATE project_memory_items SET status='archived',archived_at=?,updated_at=? WHERE id=?").run(now, now, memoryId);
    this.touch(taskId);
    this.event(taskId, 'project_memory.archived', { memory_id:memoryId, category:row.category, key:row.memory_key });
    return true;
  }

  listConversations(taskId) {
    return this.db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM conversation_completed_runs r
        WHERE r.conversation_id=c.id) AS completed_turns
      FROM task_conversations c WHERE c.task_id=?
      ORDER BY c.sequence DESC
    `).all(taskId);
  }

  bindConversation(taskId, url, contextCheckpointVersion = null) {
    const normalized = canonicalProviderChatUrl(url);
    if (!normalized) {
      if (!String(url || '').trim()) return null;
      throw new Error('invalid_provider_conversation_url');
    }
    const now = this.now();
    const exact = this.db.prepare('SELECT * FROM task_conversations WHERE task_id=? AND chat_url=? ORDER BY sequence DESC LIMIT 1').get(taskId, normalized);
    const existing = exact || this.db.prepare('SELECT * FROM task_conversations WHERE task_id=? ORDER BY sequence DESC').all(taskId)
      .find(row => canonicalProviderChatUrl(row.chat_url) === normalized);
    if (existing) {
      this.db.prepare("UPDATE task_conversations SET status='archived',ended_at=COALESCE(ended_at,?),updated_at=? WHERE task_id=? AND id<>? AND status='active'").run(now, now, taskId, existing.id);
      this.db.prepare("UPDATE task_conversations SET status='active',chat_url=?,ended_at=NULL,updated_at=? WHERE id=?").run(normalized, now, existing.id);
      this.db.prepare('UPDATE tasks SET chat_url=?,updated_at=? WHERE id=?').run(normalized, now, taskId);
      return this.db.prepare('SELECT * FROM task_conversations WHERE id=?').get(existing.id);
    }
    this.db.prepare("UPDATE task_conversations SET status='archived',ended_at=?,updated_at=? WHERE task_id=? AND status='active'").run(now, now, taskId);
    const sequence = Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM task_conversations WHERE task_id=?').get(taskId)?.sequence || 1);
    const id = `conversation_${randomUUID()}`;
    this.db.prepare('INSERT INTO task_conversations(id,task_id,sequence,chat_url,status,context_checkpoint_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, taskId, sequence, normalized, 'active', contextCheckpointVersion, now, now);
    this.db.prepare('UPDATE tasks SET chat_url=?,updated_at=? WHERE id=?').run(normalized, now, taskId);
    this.event(taskId, 'provider.conversation.bound', { conversation_id:id, sequence, url:normalized, context_checkpoint_version:contextCheckpointVersion });
    return this.db.prepare('SELECT * FROM task_conversations WHERE id=?').get(id);
  }

  setChatUrl(id, url, contextCheckpointVersion = null) { return this.bindConversation(id, url, contextCheckpointVersion); }

  rotateConversation(taskId, reason = 'manual') {
    const now = this.now();
    const active = this.db.prepare("SELECT * FROM task_conversations WHERE task_id=? AND status='active' ORDER BY sequence DESC LIMIT 1").get(taskId);
    if (active) this.db.prepare("UPDATE task_conversations SET status='archived',ended_at=?,updated_at=? WHERE id=?").run(now, now, active.id);
    this.db.prepare('UPDATE tasks SET chat_url=NULL,updated_at=? WHERE id=?').run(now, taskId);
    this.event(taskId, 'provider.conversation.rotated', { reason, previous_conversation_id:active?.id || null, previous_chat_url:active?.chat_url || null });
    return this.getTask(taskId);
  }

  continuationSummary(taskId, snapshot = {}) {
    const task = snapshot.task || this.db.prepare('SELECT id,title,checkpoint,chat_url FROM tasks WHERE id=?').get(taskId);
    if (!task) return null;
    const checkpoint = snapshot.checkpoint === undefined ? this.latestCheckpoint(taskId) : snapshot.checkpoint;
    const totalMessages = snapshot.totalMessages ?? Number(this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE task_id=?').get(taskId)?.n || 0);
    const conversations = snapshot.conversations || this.listConversations(taskId);
    const projectMemory = snapshot.projectMemory || this.projectMemorySummary(taskId);
    return {
      checkpoint_version: checkpoint?.version || 0,
      checkpoint_summary: checkpoint?.summary || task.checkpoint || '',
      recent_message_count: Math.min(totalMessages, 10),
      total_messages: totalMessages,
      conversation_count: conversations.length,
      structured_memory_count: projectMemory.total,
      pending_memory_candidates: snapshot.pendingCount ?? this.memoryCandidates.pendingCount(taskId),
      structured_memory_by_category: projectMemory.by_category,
      active_conversation: conversations.find(row => row.status === 'active') || null
    };
  }

  buildContinuationPrompt(taskId, prompt) {
    // Bounded projection of the SAME SQLite SSOT, never an independent cache.
    // Avoid loading every message, event, candidate and conversation on each send.
    const task = this.db.prepare('SELECT id,title,checkpoint FROM tasks WHERE id=?').get(taskId);
    if (!task) return String(prompt || '');
    return buildProjectContinuation({
      title: task.title,
      checkpoint: this.latestCheckpoint(taskId)?.summary || task.checkpoint,
      memoryItems: this.listProjectMemory(taskId),
      recentMessages: this.messages(taskId, { limit: 8 }),
      request: prompt
    });
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
      prepare_started_at: metrics?.prepareStartedAt || null,
      health_completed_at: metrics?.healthCompletedAt || null,
      draft_checked_at: metrics?.draftCheckedAt || null,
      conversation_ready_at: metrics?.conversationReadyAt || null,
      observer_ready_at: metrics?.observerReadyAt || null,
      baseline_ready_at: metrics?.baselineReadyAt || null,
      submit_attempt_at: metrics?.submitAttemptAt || null,
      provider_request_seen_at: metrics?.providerRequestSeenAt || null,
      submitted_at: metrics?.submittedAt || null,
      first_delta_at: metrics?.firstDeltaAt || null,
      fast_first_delta_at: metrics?.fastFirstDeltaAt || null,
      beta_first_delta_at: metrics?.betaFirstDeltaAt || null,
      network_first_byte_at: metrics?.networkFirstByteAt || null,
      completed_at: metrics?.completedAt || null,
      ttfs_ms: metrics?.submitAttemptAt && metrics?.firstDeltaAt ? Math.max(0, metrics.firstDeltaAt - metrics.submitAttemptAt) : null,
      prepare_ms: metrics?.runStartedAt && metrics?.submitAttemptAt ? Math.max(0, metrics.submitAttemptAt - metrics.runStartedAt) : null,
      health_ms: metrics?.prepareStartedAt && metrics?.healthCompletedAt ? Math.max(0, metrics.healthCompletedAt - metrics.prepareStartedAt) : null,
      draft_check_ms: metrics?.healthCompletedAt && metrics?.draftCheckedAt ? Math.max(0, metrics.draftCheckedAt - metrics.healthCompletedAt) : null,
      conversation_prepare_ms: metrics?.draftCheckedAt && metrics?.conversationReadyAt ? Math.max(0, metrics.conversationReadyAt - metrics.draftCheckedAt) : null,
      observer_prepare_ms: metrics?.conversationReadyAt && metrics?.observerReadyAt ? Math.max(0, metrics.observerReadyAt - metrics.conversationReadyAt) : null,
      baseline_prepare_ms: metrics?.observerReadyAt && metrics?.baselineReadyAt ? Math.max(0, metrics.baselineReadyAt - metrics.observerReadyAt) : null,
      composer_prepare_ms: metrics?.baselineReadyAt && metrics?.submitAttemptAt ? Math.max(0, metrics.submitAttemptAt - metrics.baselineReadyAt) : null,
      request_seen_ms: metrics?.submitAttemptAt && metrics?.providerRequestSeenAt ? Math.max(0, metrics.providerRequestSeenAt - metrics.submitAttemptAt) : null,
      submit_confirm_ms: metrics?.submitAttemptAt && metrics?.submittedAt ? Math.max(0, metrics.submittedAt - metrics.submitAttemptAt) : null,
      network_ttfs_ms: metrics?.submitAttemptAt && metrics?.networkFirstByteAt ? Math.max(0, metrics.networkFirstByteAt - metrics.submitAttemptAt) : null,
      attempt_to_first_delta_ms: metrics?.submitAttemptAt && metrics?.firstDeltaAt ? Math.max(0, metrics.firstDeltaAt - metrics.submitAttemptAt) : null,
      fast_ttfs_ms: metrics?.submitAttemptAt && metrics?.fastFirstDeltaAt ? Math.max(0, metrics.fastFirstDeltaAt - metrics.submitAttemptAt) : null,
      beta_ttfs_ms: metrics?.submitAttemptAt && metrics?.betaFirstDeltaAt ? Math.max(0, metrics.betaFirstDeltaAt - metrics.submitAttemptAt) : null,
      fast_lead_ms: metrics?.fastFirstDeltaAt && metrics?.betaFirstDeltaAt ? metrics.betaFirstDeltaAt - metrics.fastFirstDeltaAt : null,
      total_ms: metrics?.submitAttemptAt && metrics?.completedAt ? Math.max(0, metrics.completedAt - metrics.submitAttemptAt) : null,
      observer_used: metrics?.observerUsed || 'beta',
      first_observer: metrics?.firstObserver || null,
      fast_seen: Boolean(metrics?.fastSeen),
      beta_seen: Boolean(metrics?.betaSeen),
      fast_delivered: Boolean(metrics?.fastDelivered),
      fast_suppressed: Boolean(metrics?.fastSuppressed),
      fast_suppression_reason: metrics?.fastSuppressionReason || null
    };
    this.db.prepare('UPDATE runs SET observer_mode=?,metrics=? WHERE id=?').run(observerMode, JSON.stringify(normalized), runId);
    this.event(taskId, 'run.metrics', { run_id: runId, ...normalized });
    return normalized;
  }

  recordConversationCompletion(taskId, runId) {
    const run = this.db.prepare('SELECT id,status FROM runs WHERE id=? AND task_id=?').get(runId, taskId);
    if (!run || run.status !== 'succeeded') throw new Error('conversation_run_not_succeeded');
    const active = this.db.prepare(
      "SELECT c.id FROM task_conversations c JOIN tasks t ON t.id=c.task_id AND t.chat_url=c.chat_url WHERE c.task_id=? AND c.status='active' ORDER BY c.sequence DESC LIMIT 1"
    ).get(taskId);
    if (!active) throw new Error('conversation_not_bound');
    const insertion = this.db.prepare(
      'INSERT OR IGNORE INTO conversation_completed_runs(run_id,task_id,conversation_id,created_at) VALUES(?,?,?,?)'
    ).run(runId, taskId, active.id, this.now());
    if (insertion.changes) this.event(taskId,'provider.conversation.turn_completed', { run_id:runId, conversation_id:active.id });
    return this.db.prepare('SELECT COUNT(*) AS n FROM conversation_completed_runs WHERE conversation_id=?').get(active.id).n;
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
    if (!error) {
      const active = this.db.prepare("SELECT 1 FROM task_conversations WHERE task_id=? AND status='active' LIMIT 1").get(taskId);
      if (active) {
        try { this.recordConversationCompletion(taskId, runId); }
        catch (accountingError) {
          this.event(taskId, 'provider.conversation.accounting_failed', {
            run_id:runId, error:String(accountingError?.message || accountingError)
          });
        }
      }
    }
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

  close() {
    if (!this.db) return;
    const db = this.db;
    this.db = null;
    db.close();
  }

  buildResumeCapsule(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    return {
      version: 2,
      workspace_session_id: task.workspace_session_id,
      task: { id: task.id, title: task.title, status: task.status, chat_url: task.chat_url },
      checkpoint: task.checkpoint_record,
      recent_messages: task.messages.slice(-8).map(({ role, content, created_at, assets }) => ({
        role, content, created_at, assets: (assets || []).map(({ id, kind, mime_type, alt }) => ({ id, kind, mime_type, alt }))
      })),
      recent_events: task.events.slice(-20),
      pending_approvals: task.pending_approvals,
      conversations: task.conversations,
      project_memory: task.project_memory,
      continuation: task.continuation
    };
  }
}
