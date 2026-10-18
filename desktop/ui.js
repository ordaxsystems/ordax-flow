import { renderLiveStage } from './ui-stage.mjs';
const $ = selector => document.querySelector(selector);
let currentTaskId = null;
let currentTask = null;
let workspace = null;
let directMode = false;
let loginFlowVisible = false;
let observerMode = 'auto';
let allTasks = [];
let providerRefreshPending = false;
let navigationEpoch = 0;
let submittingTaskId = null;
const draftCache = new Map();
let draftTimer = null;
let pendingDraft = null;
let historyEpoch = 0;
let historyCursors = [null];
let historyPageIndex = 0;
let historyLoading = false;

function flushDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  if (!pendingDraft) return;
  const { taskId, content, revision } = pendingDraft;
  pendingDraft = null;
  void window.ordax.setDraft(taskId, content, revision).then(() => {
    if (currentTaskId === taskId && draftCache.get(taskId)?.revision === revision) {
      $('#draftState').textContent = content ? 'Rascunho local • salvo' : '';
    }
  }).catch(error => {
    if (currentTaskId === taskId && draftCache.get(taskId)?.revision === revision) {
      $('#draftState').textContent = `Rascunho não salvo: ${friendlyError(error)}`;
    }
  });
}

function stageDraft() {
  if (!currentTaskId) return;
  const taskId = currentTaskId;
  const previous = draftCache.get(taskId);
  const revision = Math.max(previous?.revision || 0, Number(currentTask?.draft_revision || 0)) + 1;
  const content = $('#prompt').value;
  draftCache.set(taskId, { content, revision });
  pendingDraft = { taskId, content, revision };
  $('#draftState').textContent = content ? 'Rascunho local • salvando…' : '';
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 300);
}

function showDraft(task) {
  const cached = draftCache.get(task.id);
  const revision = Number(task.draft_revision || 0);
  const entry = cached && cached.revision >= revision ? cached : { content: task.draft || '', revision };
  draftCache.set(task.id, entry);
  $('#prompt').value = entry.content;
  $('#prompt').dispatchEvent(new Event('draft-restored'));
  $('#draftState').textContent = entry.content ? 'Rascunho local • preservado nesta conversa' : '';
}

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function compactDate(value) {
  if (!value) return '';
  try { return new Date(value).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }); }
  catch { return ''; }
}

function plural(value, singular, pluralText) {
  return `${value} ${value === 1 ? singular : pluralText}`;
}

function assetHtml(asset) {
  if (asset.kind !== 'image' || !asset.url) return '';
  return `<figure class="asset"><img src="${esc(asset.url)}" alt="${esc(asset.alt || 'Imagem')}" /><figcaption>${esc(asset.alt || '')}</figcaption></figure>`;
}

function messageHtml(message) {
  const role = message.role === 'user' ? 'Você' : 'ChatGPT';
  return `<article class="message ${esc(message.role)}">
    <div class="message-body">
      <div class="message-role">${role}</div>
      ${message.content ? `<div class="message-content">${esc(message.content)}</div>` : ''}
      ${(message.assets || []).map(assetHtml).join('')}
    </div>
  </article>`;
}

function appendLiveRun(runId, userMessage) {
  const box = $('#messages');
  // Temporary messages belong to the same replaceable page as the durable history.
  // Appending to #messages would leave orphan live nodes after renderHistory().
  $('#messageList').insertAdjacentHTML('beforeend', messageHtml({ role:'user', content:userMessage.content, assets:[] }) +
    `<article class="message assistant live" id="live-${esc(runId)}"><div class="message-body"><div class="message-role">ChatGPT</div><div class="message-content live-content">Preparando…</div></div></article>`);
  box.scrollTop = box.scrollHeight;
}

function updateLiveStage(payload) {
  renderLiveStage(payload, { getNode:id=>document.getElementById(id), statusElement:$('#runStatus') });
}

function updateLiveRun(payload) {
  const node = document.getElementById(`live-${payload.runId}`);
  if (!node) return;
  const content = node.querySelector('.live-content');
  if (payload.text) node.dataset.streamStarted = 'true';
  content.textContent = payload.text || (payload.generating ? 'Gerando…' : 'Processando…');
  node.classList.toggle('streaming', Boolean(payload.generating));
  const base = payload.submitAttemptAt || payload.submittedAt || payload.runStartedAt;
  const activity = payload.firstActivityAt && base ? Math.max(0, payload.firstActivityAt - base) : null;
  const ttft = payload.firstDeltaAt && base ? Math.max(0, payload.firstDeltaAt - base) : null;
  const source = payload.source === 'fast' ? 'Fast' : 'Beta';
  $('#runStatus').textContent = ttft != null
    ? `Respondendo • ${source} • primeiro texto em ${ttft} ms`
    : activity != null
      ? `ChatGPT ativo em ${activity} ms • ${source} aguardando texto…`
      : `Respondendo • ${source}`;
  $('#runStatus').classList.remove('hidden');
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function friendlyError(error) {
  const raw = String(error?.message || error || 'Erro desconhecido');
  const lastSegment = raw.split(':').at(-1)?.trim() || '';
  const code = /^[a-z][a-z0-9_]*$/i.test(lastSegment) ? lastSegment : (raw.match(/Error: ([a-z0-9_]+)/i)?.[1] || raw);
  const messages = {
    chatgpt_draft_present: 'Esta conversa já existente tem um rascunho no ChatGPT. Preserve ou apague o texto antes de continuar; ao criar uma nova conversa, o worker prepara um campo vazio.',
    new_chat_composer_unavailable: 'A nova conversa abriu, mas o campo de mensagem do ChatGPT não ficou pronto.',
    new_chat_composer_focus_failed: 'Não foi possível selecionar o editor da nova conversa do ChatGPT.',
    new_chat_composer_clear_failed: 'O ChatGPT recusou a limpeza do rascunho antigo na nova conversa. Nada foi enviado.',
    new_chat_composer_not_empty: 'O campo do ChatGPT não ficou vazio após criar a nova conversa. Nada foi enviado; verifique a página oficial.',
    chatgpt_verification_required: 'O ChatGPT exige uma verificação oficial. Conclua-a no modo direto e tente novamente.',
    chatgpt_login_required: 'Entre na sua conta do ChatGPT para continuar.',
    chatgpt_authentication_in_progress: 'Conclua o login antes de enviar.',
    composer_not_found: 'O campo de mensagem do ChatGPT ainda não está pronto.',
    send_not_observed: 'O ChatGPT não confirmou o envio. Nada foi reenviado automaticamente.',
    send_confirmation_unknown: 'O campo do ChatGPT foi esvaziado, mas o envio não pôde ser confirmado. Confira a conversa no ChatGPT antes de tentar novamente; não houve reenvio automático.',
    send_control_unavailable: 'Não foi possível localizar um botão de envio utilizável no ChatGPT. Confira o estado da sessão oficial.',
    response_not_observed: 'O envio ocorreu, mas a resposta não pôde ser confirmada. A memória da tarefa foi preservada.',
    google_login_button_not_found: 'O botão de login do Google não ficou disponível.',
    google_login_navigation_not_observed: 'O fluxo do Google não confirmou a navegação.',
    invalid_project_memory_category: 'Escolha uma categoria válida para a memória.',
    project_memory_key_required: 'Dê um nome ou chave para este item de memória.',
    project_memory_content_required: 'Descreva o conteúdo que deve permanecer canônico.',
    project_memory_key_conflict: 'Já existe outro item com essa categoria e chave.',
    project_memory_too_large: 'Este item de memória excede o limite permitido.',
    project_memory_candidate_not_found: 'Esta sugestão não foi encontrada.',
    project_memory_candidate_reviewed: 'Esta sugestão já foi revisada.',
    invalid_project_memory_review: 'Ação de revisão inválida.',
    project_memory_conflict_requires_review: 'A memória aprovada mudou ou exige comparação. Revise os dois valores antes de confirmar.',
    invalid_task_title: 'Informe um nome válido de até 140 caracteres para o projeto.',
    task_draft_too_large: 'O rascunho excede 20 mil caracteres.'
  };
  return messages[code] || raw.replace(/^Error invoking remote method '[^']+': Error: /, '');
}

function statusLabel(status) {
  return ({ ready:'Pronta', running:'Executando', error:'Erro', interrupted:'Interrompida', succeeded:'Concluída' })[status] || status;
}

const memoryCategoryLabels = {
  entity:'Entidade', structure:'Estrutura', fact:'Fato', decision:'Decisão',
  constraint:'Restrição', goal:'Objetivo', open_loop:'Pendência', reference:'Referência'
};

function setMemoryEditor(open, item = null) {
  const editor = $('#memoryEditor');
  $('#memoryConflictReview').classList.add('hidden');
  $('#memoryConfirmReplace').checked = false;
  const add = $('#addMemoryItem');
  editor.classList.toggle('hidden', !open);
  add?.setAttribute('aria-expanded', String(Boolean(open)));
  if (!open) {
    editor.reset();
    delete editor.dataset.memoryId;
    delete editor.dataset.candidateId;
    return;
  }
  if (item) {
    if (item.id) editor.dataset.memoryId = item.id;
    else delete editor.dataset.memoryId;
    $('#memoryCategory').value = item.category;
    $('#memoryKey').value = item.key;
    $('#memoryContent').value = item.content;
  } else {
    editor.reset();
    delete editor.dataset.memoryId;
  }
  delete editor.dataset.candidateId;
  $('#memoryKey').focus();
}

function syncMemoryConflictReview() {
  const editor = $('#memoryEditor');
  const box = $('#memoryConflictReview');
  const candidateId = editor.dataset.candidateId;
  const category = $('#memoryCategory').value;
  const key = $('#memoryKey').value.trim().toLocaleLowerCase('pt-BR');
  const proposed = $('#memoryContent').value.trim();
  const canon = candidateId ? (currentTask?.project_memory?.items || []).find(item =>
    item.category === category && item.key.toLocaleLowerCase('pt-BR') === key) : null;
  const conflict = Boolean(canon && canon.content.trim() !== proposed);
  box.classList.toggle('hidden', !conflict);
  $('#memoryConfirmReplace').checked = false;
  if (conflict) {
    $('#memoryCanonicalBefore').textContent = canon.content;
    $('#memoryCanonicalAfter').textContent = proposed;
  }
  return canon && conflict ? canon : null;
}

function renderMemoryCandidates(task) {
  const candidates = task.project_memory?.candidates || [];
  $('#memoryCandidateCount').textContent = String(task.project_memory?.pending_count || candidates.length);
  $('#memoryCandidates').innerHTML = candidates.length ? candidates.map(item =>
    '<article class="memory-candidate" data-candidate-id="' + esc(item.id) + '">' +
      '<div class="memory-item-top"><span class="memory-kind">' + esc(memoryCategoryLabels[item.category] || item.category) + '</span>' +
      '<strong>' + esc(item.key) + '</strong></div>' +
      '<p>' + esc(item.content) + '</p>' +
      (item.conflict ? '<div class="memory-conflict-alert"><strong>⚠ Diverge da memória aprovada</strong><p>Atual: ' + esc(item.canonical_content) + '</p><p>Proposto: ' + esc(item.content) + '</p></div>' : '') +
      '<small>Origem: mensagem da conversa · ' + esc(item.evidence) + '</small>' +
      '<div class="memory-review-actions">' +
        (item.conflict ? '<button class="mini-primary" type="button" data-review="edit">Revisar conflito</button>' : '<button class="mini-primary" type="button" data-review="accept">Aprovar</button>') +
        '<button class="mini-secondary" type="button" data-review="edit">Editar</button>' +
        '<button class="mini-secondary" type="button" data-review="reject">Descartar</button>' +
      '</div></article>'
  ).join('') : '<div class="context-empty">Nenhuma sugestão pendente. Só itens aprovados entram no cânone.</div>';

  document.querySelectorAll('.memory-candidate [data-review]').forEach(button => button.addEventListener('click', async () => {
    const card = button.closest('[data-candidate-id]');
    const item = candidates.find(row => row.id === card?.dataset.candidateId);
    if (!item) return;
    if (button.dataset.review === 'edit') {
      setMemoryEditor(true, { category:item.category, key:item.key, content:item.content });
      $('#memoryEditor').dataset.candidateId = item.id;
      syncMemoryConflictReview();
      $('#memoryContent').focus();
      return;
    }
    const taskId = currentTaskId;
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const updated = await window.ordax.reviewMemoryCandidate(taskId, item.id, button.dataset.review);
      if (currentTaskId === taskId) {
        renderContext(acceptTaskRefresh(updated));
        await loadTasks();
      }
    } catch (error) {
      $('#providerDetail').textContent = friendlyError(error);
      card.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }));
}

function renderTaskList() {
  const query = ($('#taskSearch')?.value || '').trim().toLocaleLowerCase('pt-BR');
  const tasks = query ? allTasks.filter(task => String(task.title || '').toLocaleLowerCase('pt-BR').includes(query)) : allTasks;
  $('#taskCount').textContent = String(allTasks.length);
  $('#tasks').innerHTML = tasks.map(task => `
    <button class="task ${task.id === currentTaskId ? 'active' : ''}" data-id="${esc(task.id)}">
      <strong>${esc(task.title)}</strong>
      <span class="task-sub"><span>${esc(statusLabel(task.status))}</span><span>Projeto persistente</span></span>
    </button>`).join('');
  document.querySelectorAll('.task').forEach(button => button.addEventListener('click', () => openTask(button.dataset.id)));
}

async function loadTasks() {
  allTasks = await window.ordax.listTasks();
  renderTaskList();
}

function acceptTaskRefresh(updated) {
  // A memory/title refresh must not silently jump away from an older history page.
  if (historyPageIndex > 0 && currentTask?.id === updated?.id) {
    currentTask = { ...updated, messages:currentTask.messages, message_page:currentTask.message_page };
  } else {
    currentTask = updated;
  }
  return currentTask;
}

function updateHistoryNav() {
  const page = currentTask?.message_page;
  const hasOlder = Boolean(page?.has_more);
  const hasNewer = historyPageIndex > 0;
  $('#messageHistoryNav').classList.toggle('hidden', !hasOlder && !hasNewer);
  $('#olderMessages').disabled = historyLoading || !hasOlder;
  $('#newerMessages').disabled = historyLoading || !hasNewer;
  const total = Number(currentTask?.continuation?.total_messages ?? currentTask?.messages?.length ?? 0);
  $('#historyPageStatus').textContent = historyLoading
    ? 'Carregando histórico…'
    : `Página ${historyPageIndex + 1} • ${currentTask?.messages?.length || 0} de ${total} mensagens`;
}

function renderHistory(task, { reset = false, scrollToLatest = false } = {}) {
  if (reset) {
    historyEpoch++;
    historyCursors = [null];
    historyPageIndex = 0;
    historyLoading = false;
  }
  $('#messageList').innerHTML = (task.messages || []).map(messageHtml).join('');
  updateHistoryNav();
  $('#messages').scrollTop = scrollToLatest ? $('#messages').scrollHeight : 0;
}

async function changeHistoryPage(direction) {
  if (!currentTaskId || historyLoading || !currentTask?.message_page) return;
  const older = direction === 'older';
  const cursor = older ? currentTask.message_page.next_cursor : historyCursors[historyPageIndex - 1];
  if (older && !currentTask.message_page.has_more) return;
  if (!older && historyPageIndex === 0) return;
  const taskId = currentTaskId;
  const requestEpoch = historyEpoch;
  const requestNavigation = navigationEpoch;
  historyLoading = true;
  updateHistoryNav();
  try {
    const page = await window.ordax.loadMessagePage(taskId, cursor);
    if (currentTaskId !== taskId || historyEpoch !== requestEpoch || navigationEpoch !== requestNavigation) return;
    if (older) {
      historyCursors = historyCursors.slice(0, historyPageIndex + 1);
      historyCursors.push(cursor);
      historyPageIndex++;
    } else {
      historyPageIndex--;
    }
    currentTask = { ...currentTask, messages:page.messages,
      continuation:{ ...currentTask.continuation, total_messages:page.total_messages },
      message_page:{ has_more:page.has_more, next_cursor:page.next_cursor, page_size:page.page_size } };
    renderHistory(currentTask, { scrollToLatest:!older && historyPageIndex === 0 });
    renderContext(currentTask);
  } catch (error) {
    if (currentTaskId === taskId && historyEpoch === requestEpoch) {
      $('#providerDetail').textContent = friendlyError(error);
    }
  } finally {
    if (currentTaskId === taskId && navigationEpoch === requestNavigation && historyEpoch === requestEpoch) {
      historyLoading = false;
      updateHistoryNav();
    }
  }
}

function renderContext(task) {
  const continuation = task.continuation || {};
  const conversations = task.conversations || [];
  const assets = task.messages.flatMap(message => (message.assets || []).map(asset => ({ ...asset, message })));
  const checkpointVersion = task.checkpoint_record?.version || continuation.checkpoint_version || 0;

  $('#conversationBadge').textContent = 'Projeto contínuo';

  $('#memorySummary').textContent = task.checkpoint_record?.summary || task.checkpoint ||
    'A memória desta tarefa será formada por checkpoints, mensagens, decisões e artefatos locais conforme o trabalho evoluir.';
  $('#memoryStats').innerHTML = `
    <div class="stat"><strong>${Number(continuation.total_messages || task.messages.length)}</strong><span>mensagens</span></div>
    <div class="stat"><strong>v${checkpointVersion}</strong><span>checkpoint</span></div>
    <div class="stat"><strong>${Number(continuation.structured_memory_count || 0)}</strong><span>memórias</span></div>`;

  renderMemoryCandidates(task);
  const memoryItems = task.project_memory?.items || [];
  $('#structuredMemoryCount').textContent = String(memoryItems.length);
  $('#structuredMemory').innerHTML = memoryItems.length ? memoryItems.map(item => `
    <article class="memory-item" data-memory-id="${esc(item.id)}" title="Editar item">
      <button class="memory-archive" type="button" data-archive-memory="${esc(item.id)}" title="Arquivar memória" aria-label="Arquivar memória">×</button>
      <div class="memory-item-top">
        <span class="memory-kind">${esc(memoryCategoryLabels[item.category] || item.category)}</span>
        <strong>${esc(item.key)}</strong>
      </div>
      <p>${esc(item.content)}</p>
      <small>${item.source_type === 'manual' ? 'Revisado manualmente' : `Fonte: ${esc(item.source_type)}`}</small>
    </article>`).join('') : '<div class="context-empty">Itens canônicos do projeto aparecerão aqui.</div>';
  document.querySelectorAll('.memory-item').forEach(card => card.addEventListener('click', event => {
    if (event.target.closest('[data-archive-memory]')) return;
    const item = memoryItems.find(row => row.id === card.dataset.memoryId);
    if (item) setMemoryEditor(true, item);
  }));
  document.querySelectorAll('[data-archive-memory]').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    if (!currentTaskId) return;
    button.disabled = true;
    try {
      const updated = await window.ordax.archiveProjectMemory(currentTaskId, button.dataset.archiveMemory);
      renderContext(acceptTaskRefresh(updated));
      await loadTasks();
    } catch (error) {
      $('#providerDetail').textContent = friendlyError(error);
      button.disabled = false;
    }
  }));

  $('#assetCount').textContent = String(assets.length);
  $('#contentAssets').innerHTML = assets.length ? assets.slice().reverse().map(asset => `
    <button class="content-asset" type="button" data-asset-id="${esc(asset.id)}" title="${esc(asset.alt || 'Imagem')}">
      <img src="${esc(asset.url)}" alt="${esc(asset.alt || 'Imagem')}" />
      <span>${esc(asset.alt || 'Imagem')}</span>
    </button>`).join('') : '<div class="context-empty">Imagens e outros artefatos aparecerão aqui.</div>';

  document.querySelectorAll('.content-asset').forEach(button => button.addEventListener('click', () => {
    const image = [...document.querySelectorAll('#messages img')].find(img => img.src.includes(button.dataset.assetId));
    image?.scrollIntoView({ behavior:'smooth', block:'center' });
  }));

  $('#internalConversationCount').textContent = String(conversations.length);
  const ordered = conversations.slice().sort((a,b) => b.sequence - a.sequence);
  $('#conversationTimeline').innerHTML = ordered.length ? ordered.map(conversation => `
    <div class="conversation-item ${conversation.status === 'active' ? 'active' : ''}">
      <span class="conversation-node"></span>
      <div class="conversation-copy">
        <strong>Conversa ${conversation.sequence}${conversation.status === 'active' ? ' • atual' : ''}</strong>
        <span>${conversation.status === 'active' ? 'Contexto ativo' : `Arquivada ${compactDate(conversation.ended_at)}`}${conversation.context_checkpoint_version ? ` • retomou v${conversation.context_checkpoint_version}` : ''}</span>
      </div>
    </div>`).join('') : '<div class="context-empty">A primeira conversa será registrada ao enviar uma mensagem.</div>';
}

async function openTask(id) {
  if (id !== currentTaskId) flushDraft();
  const epoch = ++navigationEpoch;
  const task = await window.ordax.openTask(id);
  if (epoch !== navigationEpoch || !task) return;
  currentTaskId = id;
  currentTask = task;
  showDraft(task);
  $('#send').disabled = Boolean(submittingTaskId);
  setMemoryEditor(false);
  $('#empty').classList.add('hidden');
  $('#taskPanel').classList.remove('hidden');
  $('#taskTitle').textContent = task.title;
  $('#renameTaskForm').classList.add('hidden');
  $('#taskTitle').classList.remove('hidden');
  $('#renameTask').classList.remove('hidden');
  const version = task.checkpoint_record?.version || 0;
  const total = task.continuation?.total_messages || task.messages.length;
  $('#taskCheckpoint').textContent = version ? `Memória local v${version} • ${plural(total, 'mensagem', 'mensagens')}` : 'Memória local pronta para começar.';
  $('#taskCheckpoint').title = task.checkpoint || '';
  $('#taskId').textContent = task.id;
  $('#workspaceId').textContent = workspace ? `sessão ${workspace.id.slice(-8)}` : '';
  renderHistory(task, { reset:true, scrollToLatest:true });
  renderContext(task);

  const recovery = $('#recoveryBanner');
  if (task.status === 'interrupted') {
    const capsule = await window.ordax.resumeCapsule(id);
    const checkpointVersion = capsule?.checkpoint?.version || 0;
    recovery.textContent = `Execução interrompida detectada. A memória v${checkpointVersion} e o histórico local foram preservados.`;
    recovery.classList.remove('hidden');
  } else {
    recovery.classList.add('hidden');
    recovery.textContent = '';
  }
  await loadTasks();
}

function toggleTaskRename(editing) {
  $('#renameTaskForm').classList.toggle('hidden', !editing);
  $('#taskTitle').classList.toggle('hidden', editing);
  $('#renameTask').classList.toggle('hidden', editing);
  if (editing) {
    $('#renameTaskInput').value = currentTask?.title || '';
    $('#renameTaskInput').focus();
    $('#renameTaskInput').select();
  }
}

async function saveTaskRename(event) {
  event.preventDefault();
  if (!currentTaskId) return;
  const taskId = currentTaskId;
  const title = $('#renameTaskInput').value.trim();
  if (!title) return;
  const submit = $('#renameTaskForm').querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const updated = await window.ordax.renameTask(taskId, title);
    if (currentTaskId === taskId) {
      acceptTaskRefresh(updated);
      $('#taskTitle').textContent = updated.title;
      toggleTaskRename(false);
    }
    await loadTasks();
  } catch (error) {
    $('#providerDetail').textContent = friendlyError(error);
  } finally {
    submit.disabled = false;
  }
}

async function createTask() {
  const task = await window.ordax.createTask(`Nova conversa ${new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })}`);
  await loadTasks();
  await openTask(task.id);
  $('#prompt').focus();
}

async function rotateConversation() {
  if (!currentTaskId) return;
  const button = $('#rotateConversation');
  button.disabled = true;
  button.textContent = 'Preparando…';
  try {
    const task = await window.ordax.rotateConversation(currentTaskId);
    currentTask = task;
    await openTask(currentTaskId);
    $('#recoveryBanner').textContent = 'Nova conversa interna preparada. Sua próxima mensagem abrirá um chat novo e receberá automaticamente a memória local desta tarefa.';
    $('#recoveryBanner').classList.remove('hidden');
    $('#prompt').focus();
  } catch (error) {
    $('#providerDetail').textContent = friendlyError(error);
  } finally {
    button.disabled = false;
    button.textContent = 'Preparar outra sessão interna';
  }
}

async function saveMemoryItem(event) {
  event.preventDefault();
  if (!currentTaskId) return;
  const editor = $('#memoryEditor');
  const category = $('#memoryCategory').value;
  const key = $('#memoryKey').value.trim();
  const content = $('#memoryContent').value.trim();
  if (!key || !content) return;
  const submit = editor.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const taskId = currentTaskId;
    const canon = editor.dataset.candidateId ? (currentTask?.project_memory?.items || []).find(item =>
      item.category === category && item.key.toLocaleLowerCase('pt-BR') === key.toLocaleLowerCase('pt-BR')) : null;
    const conflict = Boolean(canon && canon.content.trim() !== content);
    if (conflict && !$('#memoryConfirmReplace').checked) {
      $('#providerDetail').textContent = 'Confira e confirme a substituição da memória aprovada.';
      return;
    }
    const updated = editor.dataset.candidateId
      ? await window.ordax.reviewMemoryCandidate(taskId, editor.dataset.candidateId, 'accept', {
        category, key, content,
        ...(conflict ? {
          confirm_conflict:true,
          expected_canonical_memory_id:canon.id,
          expected_canonical_content:canon.content
        } : {})
      })
      : await window.ordax.upsertProjectMemory(taskId, { id:editor.dataset.memoryId || undefined, category, key, content });
    if (currentTaskId === taskId) {
      setMemoryEditor(false);
      renderContext(acceptTaskRefresh(updated));
      await loadTasks();
    }
  } catch (error) {
    $('#providerDetail').textContent = friendlyError(error);
  } finally {
    submit.disabled = false;
  }
}

async function refreshProvider() {
  if (providerRefreshPending) return;
  providerRefreshPending = true;
  try {
    const status = await window.ordax.providerStatus();
    const verification = status.verification_required;
    const authenticating = status.auth_state === 'authenticating';
    const anonymous = status.auth_state === 'anonymous';
    $('#providerText').textContent = verification ? 'ChatGPT • verificação necessária' : status.active ? 'ChatGPT • gerando' : authenticating ? 'ChatGPT • autenticação' : status.ready && status.composer_ready ? 'ChatGPT • pronto' : 'ChatGPT • carregando';
    $('#providerDetail').textContent = verification ? 'Conclua a verificação no modo direto' : authenticating ? 'Conclua o login no modo direto' : anonymous ? 'Sessão anônima' : 'Sessão persistente do OrdaX';
    $('#providerDot').className = `dot ${verification ? 'error' : status.ready && status.composer_ready ? 'ok' : ''}`;
    observerMode = status.observer_mode || observerMode;
    if ($('#observerMode').value !== observerMode) $('#observerMode').value = observerMode;
    $('#observerHint').textContent = observerMode === 'beta' ? 'Beta observa a interface.' : observerMode === 'fast' ? `Fast${status.fast_observer_ready ? ' • rede observada' : ' • Beta de segurança'}` : `Automático${status.fast_observer_ready ? ' • Fast + Beta' : ' • Beta ativo'}`;
    if (loginFlowVisible && status.auth_state === 'session_present' && !verification) {
      loginFlowVisible = false;
      if (!directMode) await window.ordax.setChatVisible(false);
    }
  } catch (error) {
    $('#providerText').textContent = 'ChatGPT • erro';
    $('#providerDetail').textContent = friendlyError(error);
    $('#providerDot').className = 'dot error';
  } finally {
    providerRefreshPending = false;
  }
}

function setContextOpen(open) {
  const rail = $('#contextRail');
  const toggle = $('#toggleContext');
  const next = Boolean(open);
  rail.classList.toggle('open', next);
  toggle?.setAttribute('aria-expanded', String(next));
}

$('#newTask').addEventListener('click', createTask);
$('#olderMessages').addEventListener('click', () => changeHistoryPage('older'));
$('#newerMessages').addEventListener('click', () => changeHistoryPage('newer'));
$('#renameTask').addEventListener('click', () => toggleTaskRename(true));
$('#cancelTaskRename').addEventListener('click', () => toggleTaskRename(false));
$('#renameTaskForm').addEventListener('submit', saveTaskRename);
document.querySelector('[data-create-task]')?.addEventListener('click', createTask);
$('#taskSearch').addEventListener('input', renderTaskList);
$('#rotateConversation').addEventListener('click', rotateConversation);
$('#addMemoryItem').addEventListener('click', () => setMemoryEditor($('#memoryEditor').classList.contains('hidden')));
$('#cancelMemoryItem').addEventListener('click', () => setMemoryEditor(false));
$('#memoryEditor').addEventListener('submit', saveMemoryItem);
for (const id of ['memoryCategory','memoryKey','memoryContent']) {
  $('#'+id).addEventListener(id === 'memoryCategory' ? 'change' : 'input', () => {
    if ($('#memoryEditor').dataset.candidateId) syncMemoryConflictReview();
  });
}
$('#scanMemoryCandidates').addEventListener('click', async () => {
  if (!currentTaskId) return;
  const taskId = currentTaskId;
  const button = $('#scanMemoryCandidates');
  button.disabled = true;
  try {
    const task = await window.ordax.scanMemoryCandidates(taskId);
    if (currentTaskId === taskId) { renderContext(acceptTaskRefresh(task)); await loadTasks(); }
  } catch (error) {
    $('#providerDetail').textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
});
$('#toggleContext').addEventListener('click', () => setContextOpen(!$('#contextRail').classList.contains('open')));
$('#closeContext').addEventListener('click', () => setContextOpen(false));
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!$('#renameTaskForm').classList.contains('hidden')) { toggleTaskRename(false); return; }
  if (!$('#memoryEditor').classList.contains('hidden')) { setMemoryEditor(false); return; }
  if ($('#contextRail').classList.contains('open')) setContextOpen(false);
});
window.matchMedia('(min-width:1181px)').addEventListener('change', event => {
  if (event.matches) setContextOpen(false);
});

$('#login').addEventListener('click', async () => {
  const button = $('#login');
  button.disabled = true;
  button.textContent = 'Abrindo…';
  loginFlowVisible = true;
  await window.ordax.setChatVisible(true);
  try { await window.ordax.loginGoogle(); }
  catch (error) { $('#providerDetail').textContent = friendlyError(error); }
  finally { button.disabled = false; button.textContent = 'Entrar'; await refreshProvider(); }
});

$('#observerMode').addEventListener('change', async event => {
  const select = event.currentTarget;
  select.disabled = true;
  try { observerMode = await window.ordax.setObserverMode(select.value); await refreshProvider(); }
  catch (error) { $('#providerDetail').textContent = friendlyError(error); select.value = observerMode; }
  finally { select.disabled = false; }
});

$('#directMode').addEventListener('click', async () => {
  directMode = !directMode;
  loginFlowVisible = false;
  await window.ordax.setChatVisible(directMode);
  if (directMode && currentTaskId) await window.ordax.openTask(currentTaskId).catch(() => null);
  $('#directMode').textContent = directMode ? 'Voltar' : 'Modo direto';
});

$('#composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentTaskId) return;
  const input = $('#prompt');
  const content = input.value.trim();
  if (!content) return;
  if (submittingTaskId) return;
  const taskId = currentTaskId;
  flushDraft();
  const draftRevision = Math.max(draftCache.get(taskId)?.revision || 0, Number(currentTask?.draft_revision || 0)) + 1;
  draftCache.set(taskId, { content:'', revision:draftRevision });
  submittingTaskId = taskId;
  input.value = '';
  input.style.height = '';
  $('#draftState').textContent = '';
  $('#runStatus').textContent = currentTask?.chat_url ? 'Enviando…' : currentTask?.continuation?.total_messages ? 'Abrindo nova conversa com memória…' : 'Enviando…';
  $('#runStatus').classList.remove('hidden');
  $('#send').disabled = true;
  try {
    const { task } = await window.ordax.send({ taskId, content, draftRevision });
    if (currentTaskId === taskId) {
      currentTask = task;
      renderHistory(task, { reset:true, scrollToLatest:true });
      renderContext(task);
      $('#recoveryBanner').classList.add('hidden');
      const version = task.checkpoint_record?.version || 0;
      $('#taskCheckpoint').textContent = `Memória local v${version} • ${plural(task.continuation?.total_messages || task.messages.length, 'mensagem', 'mensagens')}`;
    }
    await loadTasks();
  } catch (error) {
    const message = friendlyError(error);
    if (currentTaskId === taskId) {
      await openTask(taskId).catch(() => null);
      if (currentTaskId === taskId) {
        $('#messageList').insertAdjacentHTML('beforeend', `<article class="message error"><div class="message-body"><div class="message-role">Erro</div><div class="message-content">${esc(message)}</div></div></article>`);
        $('#messages').scrollTop = $('#messages').scrollHeight;
      }
    }
  } finally {
    $('#runStatus').classList.add('hidden');
    $('#runStatus').textContent = '';
    submittingTaskId = null;
    $('#send').disabled = false;
    if (currentTaskId === taskId) input.focus();
    refreshProvider();
  }
});

$('#prompt').addEventListener('input', event => {
  const input = event.currentTarget;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  stageDraft();
});
$('#prompt').addEventListener('draft-restored', () => {
  const input = $('#prompt');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
});
window.addEventListener('pagehide', flushDraft);
$('#prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); }
});

window.ordax.onRunStarted(payload => {
  if (payload.taskId !== currentTaskId) return;
  appendLiveRun(payload.runId, payload.userMessage);
});
window.ordax.onTaskStage(payload => {
  if (payload.taskId !== currentTaskId) return;
  updateLiveStage(payload);
});
window.ordax.onTaskStream(payload => {
  if (payload.taskId !== currentTaskId) return;
  updateLiveRun(payload);
});

await window.ordax.setChatVisible(false);
workspace = await window.ordax.workspace();
await loadTasks();
refreshProvider();
setInterval(refreshProvider, 1500);
