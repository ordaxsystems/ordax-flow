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
