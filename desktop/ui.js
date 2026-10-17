const $ = selector => document.querySelector(selector);
let currentTaskId = null;
let currentTask = null;
let workspace = null;
let directMode = false;
let loginFlowVisible = false;
let observerMode = 'auto';
let allTasks = [];
let providerRefreshPending = false;

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
  box.insertAdjacentHTML('beforeend', messageHtml({ role:'user', content:userMessage.content, assets:[] }) +
    `<article class="message assistant live" id="live-${esc(runId)}"><div class="message-body"><div class="message-role">ChatGPT</div><div class="message-content live-content">Preparando…</div></div></article>`);
  box.scrollTop = box.scrollHeight;
}

function updateLiveRun(payload) {
  const node = document.getElementById(`live-${payload.runId}`);
  if (!node) return;
  const content = node.querySelector('.live-content');
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
  const code = raw.match(/Error: ([a-z0-9_]+)/i)?.[1] || raw;
  const messages = {
    chatgpt_draft_present: 'Há um rascunho no ChatGPT. Envie ou apague esse rascunho antes de executar.',
    chatgpt_verification_required: 'O ChatGPT exige uma verificação oficial. Conclua-a no modo direto e tente novamente.',
    chatgpt_login_required: 'Entre na sua conta do ChatGPT para continuar.',
    chatgpt_authentication_in_progress: 'Conclua o login antes de enviar.',
    composer_not_found: 'O campo de mensagem do ChatGPT ainda não está pronto.',
    send_not_observed: 'O ChatGPT não confirmou o envio. Nada foi reenviado automaticamente.',
    response_not_observed: 'O envio ocorreu, mas a resposta não pôde ser confirmada. A memória da tarefa foi preservada.',
    google_login_button_not_found: 'O botão de login do Google não ficou disponível.',
    google_login_navigation_not_observed: 'O fluxo do Google não confirmou a navegação.'
  };
  return messages[code] || raw.replace(/^Error invoking remote method '[^']+': Error: /, '');
}

function statusLabel(status) {
  return ({ ready:'Pronta', running:'Executando', error:'Erro', interrupted:'Interrompida', succeeded:'Concluída' })[status] || status;
}

function renderTaskList() {
  const query = ($('#taskSearch')?.value || '').trim().toLocaleLowerCase('pt-BR');
  const tasks = query ? allTasks.filter(task => String(task.title || '').toLocaleLowerCase('pt-BR').includes(query)) : allTasks;
  $('#taskCount').textContent = String(allTasks.length);
  $('#tasks').innerHTML = tasks.map(task => `
    <button class="task ${task.id === currentTaskId ? 'active' : ''}" data-id="${esc(task.id)}">
      <strong>${esc(task.title)}</strong>
      <span class="task-sub"><span>${esc(statusLabel(task.status))}</span><span>${plural(Number(task.conversation_count || 0), 'chat', 'chats')}</span></span>
    </button>`).join('');
  document.querySelectorAll('.task').forEach(button => button.addEventListener('click', () => openTask(button.dataset.id)));
}

async function loadTasks() {
  allTasks = await window.ordax.listTasks();
  renderTaskList();
}

function renderContext(task) {
  const continuation = task.continuation || {};
  const conversations = task.conversations || [];
  const assets = task.messages.flatMap(message => (message.assets || []).map(asset => ({ ...asset, message })));
  const checkpointVersion = task.checkpoint_record?.version || continuation.checkpoint_version || 0;

  $('#conversationBadge').textContent = task.chat_url
    ? plural(Math.max(1, conversations.length), 'conversa', 'conversas')
    : conversations.length
      ? 'continuidade pronta'
      : 'primeira conversa';

  $('#memorySummary').textContent = task.checkpoint_record?.summary || task.checkpoint ||
    'A memória desta tarefa será formada por checkpoints, mensagens, decisões e artefatos locais conforme o trabalho evoluir.';
  $('#memoryStats').innerHTML = `
    <div class="stat"><strong>${Number(continuation.total_messages || task.messages.length)}</strong><span>mensagens</span></div>
    <div class="stat"><strong>v${checkpointVersion}</strong><span>checkpoint</span></div>
    <div class="stat"><strong>${conversations.length}</strong><span>conversas</span></div>`;

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
  const task = await window.ordax.openTask(id);
  if (!task) return;
  currentTaskId = id;
  currentTask = task;
  $('#empty').classList.add('hidden');
  $('#taskPanel').classList.remove('hidden');
  $('#taskTitle').textContent = task.title;
  const version = task.checkpoint_record?.version || 0;
  const total = task.continuation?.total_messages || task.messages.length;
  $('#taskCheckpoint').textContent = version ? `Memória local v${version} • ${plural(total, 'mensagem', 'mensagens')}` : 'Memória local pronta para começar.';
  $('#taskCheckpoint').title = task.checkpoint || '';
  $('#taskId').textContent = task.id;
  $('#workspaceId').textContent = workspace ? `sessão ${workspace.id.slice(-8)}` : '';
  $('#messages').innerHTML = task.messages.map(messageHtml).join('');
  $('#messages').scrollTop = $('#messages').scrollHeight;
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
    button.textContent = 'Nova conversa interna';
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
document.querySelector('[data-create-task]')?.addEventListener('click', createTask);
$('#taskSearch').addEventListener('input', renderTaskList);
$('#rotateConversation').addEventListener('click', rotateConversation);
$('#toggleContext').addEventListener('click', () => setContextOpen(!$('#contextRail').classList.contains('open')));
$('#closeContext').addEventListener('click', () => setContextOpen(false));
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('#contextRail').classList.contains('open')) setContextOpen(false);
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
  const submittingTaskId = currentTaskId;
  input.value = '';
  input.style.height = '';
  $('#runStatus').textContent = currentTask?.chat_url ? 'Enviando…' : currentTask?.messages?.length ? 'Abrindo nova conversa com memória…' : 'Enviando…';
  $('#runStatus').classList.remove('hidden');
  $('#send').disabled = true;
  try {
    const { task } = await window.ordax.send({ taskId: submittingTaskId, content });
    if (currentTaskId === submittingTaskId) {
      currentTask = task;
      $('#messages').innerHTML = task.messages.map(messageHtml).join('');
      $('#messages').scrollTop = $('#messages').scrollHeight;
      renderContext(task);
      $('#recoveryBanner').classList.add('hidden');
      const version = task.checkpoint_record?.version || 0;
      $('#taskCheckpoint').textContent = `Memória local v${version} • ${plural(task.continuation?.total_messages || task.messages.length, 'mensagem', 'mensagens')}`;
    }
    await loadTasks();
  } catch (error) {
    const message = friendlyError(error);
    if (currentTaskId === submittingTaskId) {
      await openTask(submittingTaskId).catch(() => null);
      $('#messages').insertAdjacentHTML('beforeend', `<article class="message error"><div class="message-body"><div class="message-role">Erro</div><div class="message-content">${esc(message)}</div></div></article>`);
      $('#messages').scrollTop = $('#messages').scrollHeight;
    }
  } finally {
    $('#runStatus').classList.add('hidden');
    $('#runStatus').textContent = '';
    $('#send').disabled = false;
    input.focus();
    refreshProvider();
  }
});

$('#prompt').addEventListener('input', event => {
  const input = event.currentTarget;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
});
$('#prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); }
});

window.ordax.onRunStarted(payload => {
  if (payload.taskId !== currentTaskId) return;
  appendLiveRun(payload.runId, payload.userMessage);
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
