import { randomUUID, createHash } from 'node:crypto';
import { suggestFromExplicitText, SUGGESTION_EXTRACTOR_VERSION } from './memory-suggestions.mjs';

// Pending suggestions and verified canon are intentionally different storage domains.
export class MemoryCandidateLedger {
  constructor(store) {
    this.store = store;
    store.db.exec([
      'CREATE TABLE IF NOT EXISTS project_memory_candidates (',
      'id TEXT PRIMARY KEY,',
      'task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,',
      'source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,',
      'extractor_version TEXT NOT NULL,',
      'fingerprint TEXT NOT NULL UNIQUE,',
      'category TEXT NOT NULL, memory_key TEXT NOT NULL,',
      'proposed_content TEXT NOT NULL, evidence TEXT NOT NULL,',
      "status TEXT NOT NULL DEFAULT 'pending',",
      'memory_item_id TEXT REFERENCES project_memory_items(id),',
      'created_at TEXT NOT NULL, reviewed_at TEXT',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_memory_candidates_task ON project_memory_candidates(task_id,status,created_at);'
    ].join('\n'));
  }

  pendingCount(taskId) {
    return Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM project_memory_candidates WHERE task_id=? AND status='pending'").get(taskId)?.n || 0);
  }

  list(taskId) {
    const rows = this.store.db.prepare([
      'SELECT id,task_id,source_message_id,extractor_version,category,',
      'memory_key AS key, proposed_content AS content, evidence,status,',
      'memory_item_id,created_at,reviewed_at FROM project_memory_candidates',
      "WHERE task_id=? AND status='pending' ORDER BY created_at DESC,id DESC LIMIT 50"
    ].join(' ')).all(taskId);
    const findCanon = this.store.db.prepare(
      "SELECT id,content,updated_at FROM project_memory_items WHERE task_id=? AND category=? AND memory_key COLLATE NOCASE=? AND status='active'"
    );
    return rows.map(row => {
      const canon = findCanon.get(taskId,row.category,row.key);
      return {
        ...row,
        canonical_content: canon?.content || null,
        canonical_memory_id: canon?.id || null,
        conflict: Boolean(canon && canon.content.trim() !== row.content.trim())
      };
    });
  }

  suggestFromMessage(taskId, message) {
    if (message?.role !== 'user' || !message.id) return 0;
    let added = 0;
    for (const candidate of suggestFromExplicitText(message.content)) {
      const existing = this.store.db.prepare(
        "SELECT content FROM project_memory_items WHERE task_id=? AND category=? AND memory_key COLLATE NOCASE=? AND status='active'"
      ).get(taskId, candidate.category, candidate.key);
      if (existing?.content.trim() === candidate.content) continue;
      const pendingDuplicate = this.store.db.prepare("SELECT 1 FROM project_memory_candidates WHERE task_id=? AND category=? AND memory_key COLLATE NOCASE=? AND proposed_content=? AND status='pending' LIMIT 1")
        .get(taskId, candidate.category, candidate.key, candidate.content);
      if (pendingDuplicate) continue;
      const fingerprint = createHash('sha256').update(JSON.stringify([
        taskId,message.id,candidate.category,candidate.key.toLocaleLowerCase('pt-BR'),candidate.content
      ])).digest('hex');
      const inserted = this.store.db.prepare([
        'INSERT OR IGNORE INTO project_memory_candidates',
        '(id,task_id,source_message_id,extractor_version,fingerprint,',
        'category,memory_key,proposed_content,evidence,status,created_at)',
        "VALUES(?,?,?,?,?,?,?,?,?,'pending',?)"
      ].join(' ')).run(
        'candidate_' + randomUUID(), taskId, message.id, SUGGESTION_EXTRACTOR_VERSION,
        fingerprint, candidate.category, candidate.key, candidate.content, candidate.evidence, this.store.now()
      );
      if (inserted.changes) {
        added++;
        this.store.event(taskId, 'project_memory.candidate_suggested', {
          source_message_id:message.id, category:candidate.category, key:candidate.key,
          extractor_version:SUGGESTION_EXTRACTOR_VERSION
        });
      }
    }
    return added;
  }

  scan(taskId, limit = 100) {
    if (!this.store.db.prepare('SELECT id FROM tasks WHERE id=?').get(taskId)) throw new Error('task_not_found');
    const rows = this.store.db.prepare([
      'SELECT id,role,content FROM messages WHERE task_id=? AND role=?',
      'ORDER BY created_at DESC,id DESC LIMIT ?'
    ].join(' ')).all(taskId,'user',Math.max(1,Math.min(200,Number(limit)||100)));
    let added = 0;
    for (const row of rows.reverse()) added += this.suggestFromMessage(taskId,row);
    return { added, pending_count:this.pendingCount(taskId) };
  }

  review(taskId,candidateId,action,changes={}) {
    const db = this.store.db;
    if (action !== 'accept' && action !== 'reject') throw new Error('invalid_project_memory_review');
    db.exec('BEGIN IMMEDIATE');
    try {
      const candidate = db.prepare('SELECT * FROM project_memory_candidates WHERE id=? AND task_id=?').get(candidateId,taskId);
      if (!candidate) throw new Error('project_memory_candidate_not_found');
      if (candidate.status !== 'pending') throw new Error('project_memory_candidate_reviewed');
      let memory = null;
      if (action === 'accept') {
        const category = changes.category ?? candidate.category;
        const key = String(changes.key ?? candidate.memory_key).replace(/\s+/g, ' ').trim();
        const content = String(changes.content ?? candidate.proposed_content).trim();
        const canon = db.prepare(
          "SELECT id,content FROM project_memory_items WHERE task_id=? AND category=? AND memory_key COLLATE NOCASE=? AND status='active'"
        ).get(taskId, category, key);
        if (canon && canon.content.trim() !== content &&
          !(changes.confirm_conflict === true &&
            changes.expected_canonical_memory_id === canon.id &&
            changes.expected_canonical_content === canon.content)) {
          throw new Error('project_memory_conflict_requires_review');
        }
        memory = this.store.upsertProjectMemory(taskId,{
          category, key, content,
          source_type:'message',
          source_ref:candidate.source_message_id
        });
      }
      const now = this.store.now();
      db.prepare('UPDATE project_memory_candidates SET status=?,memory_item_id=?,reviewed_at=? WHERE id=? AND status=?')
        .run(action === 'accept' ? 'accepted' : 'rejected',memory?.id||null,now,candidate.id,'pending');
      this.store.event(taskId,'project_memory.candidate_reviewed',{
        candidate_id:candidate.id, action, memory_id:memory?.id||null, source_message_id:candidate.source_message_id
      });
      db.exec('COMMIT');
      return memory;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
