import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { planProviderConversation, SUCCESSFUL_TURNS_PER_SEGMENT } from '../src/conversation-policy.mjs';

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

test('per-Task drafts persist across restart, reject stale saves and never enter provider context', t => {
  const { dir, dbPath } = tempStore();
  let store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const first = store.createTask('Projeto A');
  const second = store.createTask('Projeto B');
  const originalOrder = store.listTasks().map(task => task.id);
  const originalTimestamp = store.getTask(first.id).updated_at;

  assert.equal(store.setDraft(first.id, 'Ideia ainda não enviada', 1).draft_revision, 1);
  store.setDraft(second.id, 'Outra tarefa', 1);
  store.setDraft(first.id, 'Texto novo', 3);
  store.setDraft(first.id, 'Retorno atrasado', 2);
  assert.equal(store.getTask(first.id).draft, 'Texto novo');
  assert.equal(store.getTask(first.id).draft_revision, 3);
  assert.equal(store.getTask(second.id).draft, 'Outra tarefa');
  const navigation = store.listTasks();
  assert.equal(navigation.length, 2);
  assert.ok(navigation.every(row => !('draft' in row) && !('checkpoint' in row) && !('chat_url' in row)));
  assert.ok(navigation.every(row => 'status' in row && 'title' in row && 'conversation_count' in row && 'pending_memory_count' in row));
  assert.equal(store.getTask(first.id).updated_at, originalTimestamp);
  assert.deepEqual(store.listTasks().map(task => task.id), originalOrder);
  assert.doesNotMatch(store.buildContinuationPrompt(first.id, 'Continue'), /Texto novo/);

  store.close();
  store = new Store(dbPath);
  assert.equal(store.getTask(first.id).draft, 'Texto novo');
  assert.equal(store.getTask(first.id).draft_revision, 3);
  store.appendMessage(first.id, 'user', 'Texto novo');
  store.setDraft(first.id, '', 5);
  store.setDraft(first.id, 'Salvamento antigo', 4);
  assert.equal(store.getTask(first.id).draft, '');
  assert.deepEqual(store.getTask(first.id).messages.map(row => row.content), ['Texto novo']);
  assert.throws(() => store.setDraft(first.id, 'x', 0), /invalid_task_draft_revision/);
  assert.throws(() => store.setDraft(first.id, 'x'.repeat(20001), 6), /task_draft_too_large/);
  assert.throws(() => store.setDraft('task_missing', 'x', 1), /task_not_found/);
});

test('project rename updates navigation title without touching draft or losing history', t => {
  const { dir, dbPath } = tempStore();
  const store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const task = store.createTask('Nova conversa');
  store.setDraft(task.id, 'Por enviar', 1);
  store.appendMessage(task.id, 'user', 'Objetivo original');
  const updated = store.renameTask(task.id, '  Projeto   Contínuo  ');
  assert.equal(updated.title, 'Projeto Contínuo');
  assert.equal(updated.draft, 'Por enviar');
  assert.equal(updated.messages.length, 1);
  assert.equal(store.listTasks()[0].title, 'Projeto Contínuo');
  assert.match(store.buildContinuationPrompt(task.id, 'Retomar'), /Projeto Contínuo/);
  assert.equal(store.renameTask(task.id, 'Projeto Contínuo').events.filter(row => row.kind === 'task.renamed').length, 1);
  assert.throws(() => store.renameTask(task.id, '   '), /invalid_task_title/);
  assert.throws(() => store.renameTask(task.id, 'z'.repeat(141)), /invalid_task_title/);
  assert.throws(() => store.renameTask('task_missing', 'Valid'), /task_not_found/);
});

test('bounded continuity uses the canonical message order and keeps image references without full history reads', t => {
  const { dir, dbPath } = tempStore();
  const store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const task = store.createTask('Pesquisa persistente');
  const insert = store.db.prepare('INSERT INTO messages(id,task_id,role,content,created_at) VALUES(?,?,?,?,?)');
  const image = store.db.prepare('INSERT INTO message_assets(id,task_id,message_id,kind,mime_type,local_path,alt,created_at) VALUES(?,?,?,?,?,?,?,?)');
  store.db.exec('BEGIN');
  try {
    // Deliberate timestamp ties exercise the existing (created_at,id) contract.
    for (let i = 0; i < 320; i++) {
      const messageId = `msg_${String(i).padStart(4, '0')}`;
      insert.run(messageId, task.id, i % 2 ? 'assistant' : 'user', `Marcador ${i}`, '2026-10-17T20:00:00.000Z');
      if (i === 314 || i === 319) {
        image.run(`asset_${i}`, task.id, messageId, 'image', 'image/png', `image_${i}.png`, `Imagem ${i}`, '2026-10-17T20:00:00.000Z');
      }
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }

  const full = store.messages(task.id);
  assert.equal(full.length, 320);
  assert.deepEqual(store.messages(task.id, { limit:8 }), full.slice(-8));
  assert.equal(full[314].assets[0].alt, 'Imagem 314');
  assert.equal(full[319].assets[0].alt, 'Imagem 319');
  const expected = store.buildContinuationPrompt(task.id, 'Continuar pesquisa');
  assert.match(expected, /Marcador 319/);
  assert.match(expected, /ARTEFATO image: Imagem 319/);
  assert.doesNotMatch(expected, /Marcador 22(?:0|1)/);
  const originalMessages = store.messages;
  const originalGetTask = store.getTask;
  store.messages = (id, options) => {
    assert.equal(id, task.id);
    assert.equal(options?.limit, 8);
    return originalMessages.call(store, id, options);
  };
  store.getTask = () => { throw new Error('full_task_hydration_forbidden'); };
  assert.equal(store.buildContinuationPrompt(task.id, 'Continuar pesquisa'), expected);
  assert.equal(store.continuationSummary(task.id).total_messages, 320);
  assert.equal(store.continuationSummary(task.id).recent_message_count, 10);
  assert.equal(store.buildContinuationPrompt('task_missing', 'Inalterado'), 'Inalterado');
  const queryPlan = store.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM messages WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 8').all(task.id);
  assert.ok(queryPlan.some(row => String(row.detail).includes('idx_messages_task_time')));
});

test('execution snapshot reflects the same SQLite rotation policy without hydrating a full Task', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const task = store.createTask('Continuidade longa');
  let snapshot = store.getTaskExecutionSnapshot(task.id);
  assert.equal(snapshot.has_messages, 0);
  assert.equal(snapshot.checkpoint_version, 0);
  assert.deepEqual(planProviderConversation(snapshot), planProviderConversation(store.getTask(task.id)));
  store.appendMessage(task.id, 'user', 'Primeira etapa');
  store.checkpoint(task.id, 'Checkpoint de versão 1');
  store.setChatUrl(task.id, 'https://chatgpt.com/c/segment-a');
  const failed = store.startRun(task.id);
  store.finishRun(task.id, failed, 'response_not_observed');
  for (let i = 0; i < SUCCESSFUL_TURNS_PER_SEGMENT; i++) {
    const run = store.startRun(task.id);
    store.finishRun(task.id, run);
  }
  const fullPlan = planProviderConversation(store.getTask(task.id));
  assert.equal(fullPlan.automaticRotation, true);
  const original = store.getTask;
  store.getTask = () => { throw new Error('full_task_hydration_forbidden'); };
  snapshot = store.getTaskExecutionSnapshot(task.id);
  assert.equal(snapshot.has_messages, 1);
  assert.equal(snapshot.checkpoint_version, 1);
  assert.deepEqual(planProviderConversation(snapshot), fullPlan);
  assert.equal(store.getTaskExecutionSnapshot('task_missing'), null);
  store.getTask = original;
  store.rotateConversation(task.id);
  snapshot = store.getTaskExecutionSnapshot(task.id);
  assert.equal(snapshot.chat_url, null);
  assert.deepEqual(planProviderConversation(snapshot), planProviderConversation(store.getTask(task.id)));
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

test('Structured project memory is canonical, durable and injected into continuation', t => {
  const { dir, dbPath } = tempStore();
  let store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const task = store.createTask('Livro - Horizonte');

  const entity = store.upsertProjectMemory(task.id, {
    category: 'entity', key: 'Caio', content: 'Protagonista de 34 anos; nasceu em Salvador.', source_type: 'manual'
  });
  store.upsertProjectMemory(task.id, {
    category: 'constraint', key: 'Ponto de vista', content: 'Terceira pessoa limitada em Caio.', source_type: 'manual'
  });
  store.upsertProjectMemory(task.id, {
    category: 'structure', key: 'Capítulo 1', content: 'Abertura no litoral antes da viagem.', source_type: 'manual'
  });
  store.upsertProjectMemory(task.id, {
    category: 'entity', key: 'caio', content: 'Protagonista de 35 anos; nasceu em Salvador.', source_type: 'manual'
  });

  let current = store.getTask(task.id);
  assert.equal(current.project_memory.summary.total, 3);
  assert.equal(current.project_memory.items.filter(item => item.key === 'Caio').length, 1);
  assert.match(current.project_memory.items.find(item => item.id === entity.id).content, /35 anos/);
  assert.equal(current.continuation.structured_memory_count, 3);

  const prompt = store.buildContinuationPrompt(task.id, 'Abra o capítulo 2.');
  assert.match(prompt, /Memória estruturada canônica/);
  assert.match(prompt, /\[ENTIDADE\] Caio: Protagonista de 35 anos/);
  assert.match(prompt, /\[RESTRICAO\] Ponto de vista/);
  assert.match(prompt, /Pedido atual:\nAbra o capítulo 2\./);

  store.close();
  store = new Store(dbPath);
  current = store.getTask(task.id);
  assert.equal(current.project_memory.summary.total, 3);
  assert.equal(store.buildResumeCapsule(task.id).project_memory.items.length, 3);

  const structure = current.project_memory.items.find(item => item.category === 'structure');
  store.archiveProjectMemory(task.id, structure.id);
  current = store.getTask(task.id);
  assert.equal(current.project_memory.summary.total, 2);
  assert.equal(store.listProjectMemory(task.id, { includeArchived: true }).find(item => item.id === structure.id).status, 'archived');
});

test('memory proposals remain pending through restart and require explicit review', t => {
  const { dir, dbPath } = tempStore();
  let store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const task = store.createTask('Livro - Caminhos');
  const user = store.appendMessage(task.id, 'user', [
    'Personagem Caio: Protagonista de 35 anos, nascido em Salvador.',
    'Regra: a narrativa deve permanecer em terceira pessoa limitada.'
  ].join('\n'));
  store.appendMessage(task.id, 'assistant', 'Entendido: personagem Caio e ponto de vista limitado.');
  store.appendMessage(task.id, 'user', 'Personagem Caio: Protagonista de 35 anos, nascido em Salvador.'); // repeated evidence stays one pending suggestion

  let current = store.getTask(task.id);
  assert.equal(current.project_memory.summary.total, 0);
  assert.equal(current.project_memory.pending_count, 2);
  assert.equal(store.memoryCandidates.list(task.id).length, 2);
  const before = store.buildContinuationPrompt(task.id, 'Continue.');
  assert.doesNotMatch(before, /Memória estruturada canônica/);

  store.close();
  store = new Store(dbPath);
  current = store.getTask(task.id);
  assert.equal(current.project_memory.pending_count, 2);
  assert.equal(store.memoryCandidates.scan(task.id).added, 0);
  const rejected = current.project_memory.candidates.find(item => item.category === 'constraint');
  store.memoryCandidates.review(task.id, rejected.id, 'reject');
  assert.equal(store.memoryCandidates.scan(task.id).added, 0);
  assert.equal(store.getTask(task.id).project_memory.pending_count, 1);
  assert.throws(() => store.memoryCandidates.review(task.id, rejected.id, 'accept'), /project_memory_candidate_reviewed/);

  const accepted = store.memoryCandidates.list(task.id)[0];
  const sourceRef = accepted.source_message_id;
  assert.equal(sourceRef, user.id);
  store.memoryCandidates.review(task.id, accepted.id, 'accept', {
    key:'Caio Mendes',
    content:'Protagonista de 35 anos, nascido em Salvador; usa o nome Caio Mendes.'
  });
  current = store.getTask(task.id);
  assert.equal(current.project_memory.pending_count, 0);
  assert.equal(current.project_memory.summary.total, 1);
  assert.equal(current.project_memory.items[0].source_type, 'message');
  assert.equal(current.project_memory.items[0].source_ref, sourceRef);
  assert.equal(current.project_memory.items[0].key, 'Caio Mendes');
  assert.match(store.buildContinuationPrompt(task.id, 'Avance.'), /\[ENTIDADE\] Caio Mendes/);
  assert.doesNotMatch(store.buildContinuationPrompt(task.id, 'Avance.'), /\[RESTRICAO\]/);
  assert.ok(store.getTask(task.id).events.some(event => event.kind === 'project_memory.candidate_reviewed'));
});

test('candidate review rollback preserves pending proposal when canon validation fails', t => {
  const { dir, dbPath } = tempStore();
  const store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const task = store.createTask('Pesquisa');
  store.appendMessage(task.id, 'user', 'Fato: o estudo utiliza dados de 2026.');
  const candidate = store.memoryCandidates.list(task.id)[0];
  assert.ok(candidate);
  assert.throws(() => store.memoryCandidates.review(task.id,candidate.id,'accept',{category:'invalid'}), /invalid_project_memory_category/);
  assert.equal(store.memoryCandidates.list(task.id).length,1);
  assert.equal(store.getTask(task.id).project_memory.summary.total,0);
  assert.throws(() => store.memoryCandidates.review('task_unknown',candidate.id,'reject'), /project_memory_candidate_not_found/);
});

test('conflicting suggestion never silently overwrites approved canon', t => {
  const { dir, dbPath } = tempStore();
  const store = new Store(dbPath);
  cleanup(t,dir,()=>store);
  const task = store.createTask('Livro - Proteção de cânone');
  const existing = store.upsertProjectMemory(task.id,{
    category:'entity',key:'Caio',content:'Caio tem 34 anos.',source_type:'manual'
  });
  store.appendMessage(task.id,'user','Personagem Caio: Caio agora tem 35 anos.');
  const candidate = store.memoryCandidates.list(task.id)[0];
  assert.equal(candidate.conflict,true);
  assert.equal(candidate.canonical_content,'Caio tem 34 anos.');
  assert.equal(candidate.canonical_memory_id,existing.id);
  assert.throws(
    () => store.memoryCandidates.review(task.id,candidate.id,'accept'),
    /project_memory_conflict_requires_review/
  );
  assert.equal(store.projectMemorySummary(task.id).total,1);
  assert.equal(store.listProjectMemory(task.id)[0].content,'Caio tem 34 anos.');
  assert.equal(store.memoryCandidates.pendingCount(task.id),1);
  assert.throws(
    () => store.memoryCandidates.review(task.id,candidate.id,'accept',{
      confirm_conflict:true,expected_canonical_memory_id:existing.id,
      expected_canonical_content:'Caio tinha 34 anos.'
    }),/project_memory_conflict_requires_review/
  );
  assert.equal(store.memoryCandidates.pendingCount(task.id),1);
  store.memoryCandidates.review(task.id,candidate.id,'accept',{
    confirm_conflict:true,expected_canonical_memory_id:existing.id,
    expected_canonical_content:'Caio tem 34 anos.'
  });
  assert.equal(store.listProjectMemory(task.id)[0].content,'Caio agora tem 35 anos.');
  assert.equal(store.memoryCandidates.pendingCount(task.id),0);
  assert.match(store.buildContinuationPrompt(task.id,'Continue.'),/Caio agora tem 35 anos/);
});

test('concurrent canon revision makes an earlier conflict confirmation stale', t => {
  const { dir, dbPath } = tempStore();
  const store = new Store(dbPath);
  cleanup(t,dir,()=>store);
  const task = store.createTask('Pesquisa versionada');
  const canon = store.upsertProjectMemory(task.id,{category:'fact',key:'Ano',content:'O ano é 2025.'});
  store.appendMessage(task.id,'user','Fato: o ano agora é 2026.');
  // The explicit fact prefix uses the statement as the key, so create a targeted candidate from named content.
  store.appendMessage(task.id,'user','Personagem Caio: Caio tem 35 anos.');
  const entity = store.upsertProjectMemory(task.id,{category:'entity',key:'Caio',content:'Caio tem 34 anos.'});
  const suggestion = store.memoryCandidates.list(task.id).find(x=>x.category==='entity');
  assert.ok(suggestion?.conflict);
  store.upsertProjectMemory(task.id,{id:entity.id,category:'entity',key:'Caio',content:'Caio tem 36 anos.'});
  assert.throws(() => store.memoryCandidates.review(task.id,suggestion.id,'accept',{
    confirm_conflict:true,expected_canonical_memory_id:entity.id,
    expected_canonical_content:'Caio tem 34 anos.'
  }),/project_memory_conflict_requires_review/);
  assert.equal(store.listProjectMemory(task.id).find(x=>x.key==='Caio').content,'Caio tem 36 anos.');
});

test('a generic long-running project preserves full canonical memory across provider rotations', t => {
  const { dir, dbPath } = tempStore();
  let store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const project = store.createTask('Plataforma de atendimento');
  store.setChatUrl(project.id, 'https://chatgpt.com/c/segment-one');
  store.checkpoint(project.id, 'Base local pronta; próximas etapas: SSO e sincronização.');
  for (let i = 0; i < 60; i++) {
    store.upsertProjectMemory(project.id, {
      category: i % 2 === 0 ? 'decision' : 'open_loop',
      key: 'Workstream ' + i,
      content: 'Contrato canônico do workstream ' + i + ': ' + 'documentado '.repeat(30)
    });
  }
  store.rotateConversation(project.id);
  let task = store.getTask(project.id);
  assert.equal(task.project_memory.summary.total, 60);
  assert.equal(task.chat_url, null);
  const request = 'Continuar a integração SSO sem perder decisões anteriores.';
  const injected = store.buildContinuationPrompt(project.id, request);
  assert.ok(injected.length <= 16000);
  assert.ok(injected.endsWith('Pedido atual:\n' + request));
  assert.match(injected, /\[MEMORIA PARCIAL\]/);
  assert.match(injected, /\[DECISAO\]/);
  assert.match(injected, /\[PENDENCIA\]/);
  store.close();
  store = new Store(dbPath);
  task = store.getTask(project.id);
  assert.equal(task.project_memory.items.length, 60);
  assert.equal(store.buildResumeCapsule(project.id).project_memory.items.length, 60);
  assert.ok(store.buildContinuationPrompt(project.id, request).endsWith('Pedido atual:\n' + request));
});

test('automatic provider rotation counts only completed runs and is restart-safe', t => {
  const { dir, dbPath } = tempStore();
  let store = new Store(dbPath);
  cleanup(t, dir, () => store);
  const task = store.createTask('Projeto permanente');
  store.setChatUrl(task.id,'https://chatgpt.com/c/provider-1');
  const failed = store.startRun(task.id);
  store.finishRun(task.id,failed,'response_not_observed');
  assert.equal(store.getTask(task.id).conversations[0].completed_turns,0);
  const first = store.startRun(task.id);
  store.finishRun(task.id,first);
  assert.equal(store.getTask(task.id).conversations[0].completed_turns,1);
  assert.equal(store.recordConversationCompletion(task.id,first),1);
  assert.equal(store.getTask(task.id).conversations[0].completed_turns,1);
  for (let i=1;i<SUCCESSFUL_TURNS_PER_SEGMENT;i++) {
    const id=store.startRun(task.id);
    store.finishRun(task.id,id);
  }
  let project=store.getTask(task.id);
  assert.equal(project.conversations[0].completed_turns,SUCCESSFUL_TURNS_PER_SEGMENT);
  assert.equal(planProviderConversation(project).automaticRotation,true);
  assert.equal(store.getTask(task.id).chat_url,'https://chatgpt.com/c/provider-1');
  store.close();
  store = new Store(dbPath);
  project=store.getTask(task.id);
  assert.equal(planProviderConversation(project).automaticRotation,true);
  assert.equal(project.conversations.length,1);
  // The provider returns a new URL after a successful send: only then bind another segment.
  store.setChatUrl(task.id,'https://chatgpt.com/c/provider-2',0);
  const newRun=store.startRun(task.id);
  store.finishRun(task.id,newRun);
  project=store.getTask(task.id);
  assert.equal(project.conversations.length,2);
  assert.equal(project.conversations[0].completed_turns,1);
  assert.equal(project.conversations[1].completed_turns,SUCCESSFUL_TURNS_PER_SEGMENT);
  assert.equal(planProviderConversation(project).automaticRotation,false);
  assert.equal(project.conversations[1].status,'archived');
  assert.equal(project.conversations[0].status,'active');
});

test('provider conversation links are canonical: URL params cannot create false chat segments', t => {
  const { dir, dbPath }=tempStore();
  let store=new Store(dbPath);
  cleanup(t,dir,()=>store);
  const task=store.createTask('Projeto contínuo - identidade de conversa');
  const base='https://chatgpt.com/c/segment-alpha';
  const first=store.setChatUrl(task.id,base+'?model=auto#reply');
  const again=store.setChatUrl(task.id,base+'/?model=high');
  assert.equal(first.id,again.id);
  assert.equal(store.getTask(task.id).chat_url,base);
  assert.equal(store.getTask(task.id).conversations.length,1);
  assert.throws(()=>store.setChatUrl(task.id,'https://chatgpt.com/'),/invalid_provider_conversation_url/);
  assert.throws(()=>store.setChatUrl(task.id,'https://not-chatgpt.example/c/segment-alpha'),/invalid_provider_conversation_url/);
  assert.equal(store.getTask(task.id).conversations.length,1);
  store.close();
  store=new Store(dbPath);
  assert.equal(store.getTask(task.id).chat_url,base);
  assert.equal(store.getTask(task.id).conversations.length,1);
});

test('multiple planned provider rotations preserve a single Task and do not recount failed runs', t => {
  // The persistence/reopen contract is covered separately on a real SQLite file.
  // This stress case exercises 72 run records in memory without filesystem fsync overhead.
  const store=new Store(':memory:');
  t.after(()=>store.close());
  const task=store.createTask('Projeto de longa duração');
  store.upsertProjectMemory(task.id,{category:'goal',key:'Produto',content:'Concluir produto modular.'});
  const provider=(n)=>'https://chatgpt.com/c/segment-'+n;
  store.setChatUrl(task.id,provider(1));
  for(let segment=1;segment<=3;segment++){
    for(let turn=0;turn<SUCCESSFUL_TURNS_PER_SEGMENT;turn++){
      const id=store.startRun(task.id);
      if(turn===7){
        store.finishRun(task.id,id,'provider_timeout');
        assert.equal(store.getTask(task.id).conversations[0].completed_turns,turn);
        const recovery=store.startRun(task.id);
        store.finishRun(task.id,recovery);
      }else{
        store.finishRun(task.id,id);
      }
    }
    const current=store.getTask(task.id);
    assert.equal(planProviderConversation(current).automaticRotation,true);
    assert.equal(current.conversations[0].completed_turns,SUCCESSFUL_TURNS_PER_SEGMENT);
    if(segment<3) store.setChatUrl(task.id,provider(segment+1),store.latestCheckpoint(task.id)?.version||0);
  }
  const current=store.getTask(task.id);
  assert.equal(current.conversations.length,3);
  assert.equal(current.project_memory.items.length,1);
  assert.equal(current.conversations.reduce((total,item)=>total+item.completed_turns,0),72);
  assert.ok(store.buildContinuationPrompt(task.id,'Continuar.').includes('Concluir produto modular.'));
});
