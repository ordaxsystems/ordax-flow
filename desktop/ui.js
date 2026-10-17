const $ = selector => document.querySelector(selector);
let currentTaskId = null;
let workspace = null;
let directMode = false;
let loginFlowVisible = false;
let observerMode = 'auto';

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function assetHtml(asset) {
  if (asset.kind !== 'image' || !asset.url) return '';
  return `<figure class="asset"><img src="${esc(asset.url)}" alt="${esc(asset.alt || 'Imagem')}" /><figcaption>${esc(asset.alt || '')}</figcaption></figure>`;
}

function messageHtml(message) {
  return `<article class="message ${message.role}">
    <div class="message-role">${message.role === 'user' ? 'Você' : 'ChatGPT'}</div>
    ${message.content ? `<div class="message-content">${esc(message.content)}</div>` : ''}
    ${(message.assets || []).map(assetHtml).join('')}
  </article>`;
}

function appendLiveRun(runId, userMessage) {
  const box = $('#messages');
  box.insertAdjacentHTML('beforeend', messageHtml({ role:'user', content:userMessage.content, assets:[] }) +
    `<article class="message assistant live" id="live-${esc(runId)}"><div class="message-role">ChatGPT</div><div class="message-content live-content">Preparando…</div></article>`);
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
    chatgpt_draft_present: 'Há um rascunho no painel do ChatGPT. Envie ou apague esse rascunho antes de executar a Task.',
    chatgpt_verification_required: 'O ChatGPT exige uma verificação oficial. Conclua-a no painel ao lado e tente novamente.',
    chatgpt_login_required: 'Entre na sua conta do ChatGPT para continuar.',
    chatgpt_authentication_in_progress: 'Conclua o login no painel do ChatGPT antes de enviar.',
    composer_not_found: 'O campo de mensagem do ChatGPT ainda não está pronto. Recarregue o painel e tente novamente.',
    send_not_observed: 'O ChatGPT não confirmou o envio. O texto foi preservado; nada foi enviado novamente automaticamente.',
    response_not_observed: 'O envio ocorreu, mas a resposta não pôde ser confirmada. A Task foi preservada para recuperação.',
    google_login_button_not_found: 'O botão de login do Google não ficou disponível na tela oficial do ChatGPT.',
    google_login_navigation_not_observed: 'O fluxo do Google não confirmou a navegação. Tente novamente pelo painel ao lado.'
  };
  return messages[code] || raw.replace(/^Error invoking remote method '[^']+': Error: /, '');
}

function statusLabel(status) {
  return ({
    ready: 'Pronta', running: 'Executando', error: 'Erro', interrupted: 'Interrompida', succeeded: 'Concluída'
  })[status] || status;
}

async function refreshProvider() {
  try {
    const status = await window.ordax.providerStatus();
    const verification = status.verification_required;
    const authenticating = status.auth_state === 'authenticating';
    const anonymous = status.auth_state === 'anonymous';
    $('#providerText').textContent = verification
      ? 'ChatGPT • verificação necessária'
      : status.active
        ? 'ChatGPT • gerando'
        : authenticating
          ? 'ChatGPT • autenticação'
          : status.ready && status.composer_ready
            ? 'ChatGPT • pronto'
            : 'ChatGPT • carregando';
    $('#providerDetail').textContent = verification
      ? 'Entre com Google ou conclua a verificação oficial no painel ao lado'
      : authenticating
        ? 'Conclua o login no painel ao lado'
        : anonymous
          ? 'Sessão anônima; entre para imagens e continuidade da conta'
          : 'Sessão persistente do OrdaX';
    $('#providerDot').className = `dot ${verification ? 'error' : status.ready && status.composer_ready ? 'ok' : ''}`;
    observerMode = status.observer_mode || observerMode;
    if ($('#observerMode').value !== observerMode) $('#observerMode').value = observerMode;
    $('#observerHint').textContent = observerMode === 'beta'
      ? 'Beta: observa a interface renderizada.'
      : observerMode === 'fast'
        ? `Fast experimental${status.fast_observer_ready ? ' • rede observada' : ' • safety net Beta ativo'}`
        : `Automático${status.fast_observer_ready ? ' • Fast medindo rede + Beta entregando conteúdo' : ' • Beta ativo'}`;
    if (loginFlowVisible && status.auth_state === 'session_present' && !verification) {
      loginFlowVisible = false;
      if (!directMode) await window.ordax.setChatVisible(false);
    }
  } catch (error) {
    $('#providerText').textContent = 'ChatGPT • erro';
    $('#providerDetail').textContent = friendlyError(error);
    $('#providerDot').className = 'dot error';
  }
}

async function loadTasks() {
  const tasks = await window.ordax.listTasks();
  $('#tasks').innerHTML = tasks.map(task => `
    <button class="task ${task.id === currentTaskId ? 'active' : ''}" data-id="${task.id}">
      <strong>${esc(task.title)}</strong>
      <span>${esc(statusLabel(task.status))}</span>
    </button>`).join('');
  document.querySelectorAll('.task').forEach(button => {
    button.addEventListener('click', () => openTask(button.dataset.id));
  });
}

async function openTask(id) {
  const task = await window.ordax.openTask(id);
  if (!task) return;
  currentTaskId = id;
  $('#empty').classList.add('hidden');
  $('#taskPanel').classList.remove('hidden');
  $('#taskTitle').textContent = task.title;
  $('#taskCheckpoint').textContent = task.checkpoint || 'Estado persistente local.';
  $('#taskId').textContent = task.id;
  $('#workspaceId').textContent = workspace ? `sessão ${workspace.id.slice(-8)}` : '';
  $('#messages').innerHTML = task.messages.map(messageHtml).join('');
  $('#messages').scrollTop = $('#messages').scrollHeight;

  const recovery = $('#recoveryBanner');
  if (task.status === 'interrupted') {
    const capsule = await window.ordax.resumeCapsule(id);
    const checkpointVersion = capsule?.checkpoint?.version || 0;
    recovery.textContent = `Execução interrompida detectada. Checkpoint v${checkpointVersion} preservado; a próxima mensagem retoma esta Task sem apagar o histórico.`;
    recovery.classList.remove('hidden');
  } else {
    recovery.classList.add('hidden');
    recovery.textContent = '';
  }
  await loadTasks();
}

$('#newTask').addEventListener('click', async () => {
  const task = await window.ordax.createTask(`Nova tarefa ${new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })}`);
  await loadTasks();
  await openTask(task.id);
  $('#prompt').focus();
});

$('#login').addEventListener('click', async () => {
  const button = $('#login');
  button.disabled = true;
  button.textContent = 'Abrindo Google…';
  loginFlowVisible = true;
  await window.ordax.setChatVisible(true);
  try {
    await window.ordax.loginGoogle();
  } catch (error) {
    $('#providerDetail').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Entrar com Google';
    await refreshProvider();
  }
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
  $('#directMode').textContent = directMode ? 'Voltar ao OrdaX' : 'Modo direto';
});

$('#composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentTaskId) return;
  const input = $('#prompt');
  const content = input.value.trim();
  if (!content) return;
  const submittingTaskId = currentTaskId;
  input.value = '';
  $('#runStatus').textContent = 'Enviando…';
  $('#runStatus').classList.remove('hidden');
  $('#send').disabled = true;
  $('#send').textContent = 'Executando…';
  try {
    const { task } = await window.ordax.send({ taskId: submittingTaskId, content });
    if (currentTaskId === submittingTaskId) {
      $('#taskCheckpoint').textContent = task.checkpoint || '';
      $('#messages').innerHTML = task.messages.map(messageHtml).join('');
      $('#messages').scrollTop = $('#messages').scrollHeight;
      $('#recoveryBanner').classList.add('hidden');
    }
    await loadTasks();
  } catch (error) {
    const message = friendlyError(error);
    if (currentTaskId === submittingTaskId) {
      await openTask(submittingTaskId).catch(() => null);
      $('#messages').insertAdjacentHTML('beforeend', `<article class="message error"><div class="message-role">Erro</div><div class="message-content">${esc(message)}</div></article>`);
      $('#messages').scrollTop = $('#messages').scrollHeight;
    }
  } finally {
    $('#runStatus').classList.add('hidden');
    $('#runStatus').textContent = '';
    $('#send').disabled = false;
    $('#send').textContent = 'Enviar';
    input.focus();
    refreshProvider();
  }
});

$('#prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#composer').requestSubmit();
  }
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
await refreshProvider();
setInterval(refreshProvider, 1500);
