import { app, BrowserWindow, ipcMain, protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Store, MESSAGE_PAGE_SIZE } from '../src/store.mjs';
import { planProviderConversation, assessProviderRotation, canonicalProviderChatUrl } from '../src/conversation-policy.mjs';
import { EmbeddedChatWorker } from './embedded-worker.mjs';

if (process.env.ORDAX_DESKTOP_DEBUG === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', '9444');
}

app.setName('OrdaX Gratis');
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.exit(0);
  process.exit(0);
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || root, 'AppData', 'Local');
const userRoot = path.join(localAppData, 'OrdaX', 'Gratis');
app.setPath('userData', userRoot);

const dataRoot = path.join(userRoot, 'data');
const assetsRoot = path.join(dataRoot, 'assets');
fs.mkdirSync(assetsRoot, { recursive: true });

protocol.registerSchemesAsPrivileged([
  { scheme: 'ordax-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

const store = new Store(path.join(dataRoot, 'ordax-gratis.sqlite'));
const recoveredRunCount = store.recoverInterruptedRuns();
store.updateWorkspaceMetadata({
  last_started_at: new Date().toISOString(),
  recovered_runs_on_start: recoveredRunCount,
  sqlite_open_retries: store.openRetryCount
});

function migrateExternalAssetPaths() {
  const safeRoot = path.resolve(assetsRoot) + path.sep;
  const rows = store.db.prepare('SELECT id,task_id,local_path FROM message_assets').all();
  let migrated = 0;
  for (const row of rows) {
    const source = path.resolve(String(row.local_path || ''));
    if (source.startsWith(safeRoot) || !fs.existsSync(source)) continue;
    const ext = path.extname(source) || '.bin';
    const dir = path.join(assetsRoot, row.task_id);
    const destination = path.join(dir, `${row.id}${ext}`);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
    store.db.prepare('UPDATE message_assets SET local_path=? WHERE id=?').run(destination, row.id);
    migrated++;
  }
  return migrated;
}

const migratedAssetCount = migrateExternalAssetPaths();
if (migratedAssetCount) store.updateWorkspaceMetadata({ migrated_legacy_assets: migratedAssetCount });

const MIME_EXT = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif']
]);

let win;
let worker;
let chatVisible = false;
let liveRun = null;
const persistedObserverMode = store.getWorkspaceSession()?.metadata?.observer_mode;
let observerMode = ['auto','fast','beta'].includes(persistedObserverMode) ? persistedObserverMode : 'auto';
let workerPreload = { ready:false, url:null, at:null };
let providerHealthInFlight = null;
let providerHealthCache = null;
let executionTail = Promise.resolve();
const LEFT_WIDTH = 470;

function enqueueExecution(operation) {
  const next = executionTail.then(operation, operation);
  executionTail = next.catch(() => {});
  return next;
}

function assetUrl(id) {
  return `ordax-asset://local/${encodeURIComponent(id)}`;
}

function decorateMessages(messages) {
  return messages.map(message => ({
    ...message,
    assets: (message.assets || []).map(asset => ({ ...asset, url: assetUrl(asset.id) }))
  }));
}

function decorateTask(task) {
  return task ? { ...task, messages:decorateMessages(task.messages) } : null;
}

function getTaskView(id) {
  return decorateTask(store.getTask(String(id), { messageLimit:MESSAGE_PAGE_SIZE }));
}

function persistImages(taskId, messageId, images = []) {
  if (!images.length) return [];
  const dir = path.join(assetsRoot, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const out = [];

  for (const image of images) {
    const ext = MIME_EXT.get(image.mimeType);
    const bytes = Buffer.from(image.base64 || '', 'base64');
    if (!ext || !bytes.length || bytes.length > 30 * 1024 * 1024) continue;

    const id = `asset_${randomUUID()}`;
    const localPath = path.join(dir, `${id}.${ext}`);
    fs.writeFileSync(localPath, bytes, { flag: 'wx' });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const asset = store.addAsset(taskId, messageId, {
      id,
      kind: 'image',
      mimeType: image.mimeType,
      localPath,
      alt: image.alt || 'Imagem do ChatGPT',
      width: image.width,
      height: image.height,
      sha256
    });
    out.push({ ...asset, url: assetUrl(asset.id) });
  }

  return out;
}

async function runTask(taskId, prompt, { newSession = false, draftRevision = null } = {}) {
  const task = store.getTaskExecutionSnapshot(taskId);
  if (!task) throw new Error('task_not_found');

  const conversationPlan = planProviderConversation(task, { forceNew:newSession });
  const needsContinuation = Boolean(conversationPlan.newSession && task.has_messages);
  const checkpointVersion = task.checkpoint_version;
  const providerPrompt = needsContinuation ? store.buildContinuationPrompt(taskId, prompt) : prompt;
  const userMessage = store.appendMessage(taskId, 'user', prompt);
  // The user's text is durable as a message before clearing its pending draft.
  if (draftRevision != null) store.setDraft(taskId, '', draftRevision);
  const runId = store.startRun(taskId, 'electron-embedded-chatgpt', observerMode);
  liveRun = { taskId, runId, startedAt:Date.now(), firstDeltaAt:null };
  if (win && !win.isDestroyed()) win.webContents.send('ordax:task:run-started', { taskId, runId, userMessage });
  const heartbeat = setInterval(() => store.heartbeatRun(taskId, runId), 5000);

  try {
    const result = await worker.sendPrompt({ prompt: providerPrompt, chatUrl: task.chat_url, newSession: conversationPlan.newSession });
    const rotationOutcome = assessProviderRotation(conversationPlan, task.chat_url, result.chatUrl);
    const confirmedChatUrl = canonicalProviderChatUrl(result.chatUrl);
    // An observed answer is still persisted, but a home/share/login URL must
    // never become the durable conversation identifier. No automatic resend.
    const bound = confirmedChatUrl
      ? store.setChatUrl(taskId, confirmedChatUrl, needsContinuation ? checkpointVersion : null)
      : null;
    if (!confirmedChatUrl) {
      store.rotateConversation(taskId, 'provider_url_unconfirmed');
      store.event(taskId, 'provider.conversation.url_unconfirmed', {
        reason: result.chatUrl ? 'not_a_chat_permalink' : 'missing_url',
        previous_conversation_id: conversationPlan.previousConversationId
      });
    }
    if (conversationPlan.automaticRotation && rotationOutcome === 'rotated' && bound?.id !== conversationPlan.previousConversationId) {
      store.event(taskId, 'provider.conversation.auto_rotated', {
        reason:conversationPlan.reason,
        previous_conversation_id:conversationPlan.previousConversationId,
        new_conversation_id:bound?.id || null,
        previous_completed_turns:conversationPlan.completedTurns
      });
    } else if (conversationPlan.automaticRotation) {
      // Preserve the successful response; never resend a prompt merely because
      // the provider returned the same conversation URL.
      store.event(taskId, 'provider.conversation.rotation_unconfirmed', {
        reason:rotationOutcome,
        previous_conversation_id:conversationPlan.previousConversationId,
        previous_completed_turns:conversationPlan.completedTurns
      });
    }
    const runMetrics = store.recordRunMetrics(taskId, runId, observerMode, { ...(result.metrics || {}), runStartedAt: liveRun?.startedAt || null });
    const assistant = store.appendMessage(taskId, 'assistant', result.text || '');
    const assets = persistImages(taskId, assistant.id, result.images || []);
    const summary = result.text?.trim()
      ? result.text.slice(0, 800)
      : assets.length
        ? `[${assets.length} imagem(ns) armazenada(s) localmente]`
        : '[resposta sem conteúdo]';

    store.checkpoint(taskId, `Última resposta observada em ${result.observedAt}: ${summary}`, {
      run_id: runId,
      chat_url: confirmedChatUrl,
      asset_ids: assets.map(asset => asset.id),
      observer_mode: observerMode,
      run_metrics: runMetrics
    });
    store.finishRun(taskId, runId);
    if (confirmedChatUrl) await worker.showConversation(confirmedChatUrl).catch(() => {});
    return { result: { ...result, assets }, task:getTaskView(taskId) };
  } catch (error) {
    store.finishRun(taskId, runId, String(error?.message || error));
    throw error;
  } finally {
    if (liveRun?.runId === runId) liveRun = null;
    clearInterval(heartbeat);
  }
}

function layoutViews() {
  if (!win || !worker) return;
  const [width, height] = win.getContentSize();
  const workerBounds = chatVisible
    ? { x: LEFT_WIDTH, y: 0, width: Math.max(640, width - LEFT_WIDTH), height }
    : { x: 0, y: 0, width: Math.max(960, width), height: Math.max(700, height) };
  worker.view.setBounds(workerBounds);
  worker.view.setVisible(chatVisible);
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1050,
    minHeight: 700,
    title: 'OrdaX Gratis',
    backgroundColor: '#0b0e13',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  worker = new EmbeddedChatWorker();
  worker.setObserverMode(observerMode);
  worker.setFastStreamSink(delta => {
    if (!liveRun || !win || win.isDestroyed()) return;
    win.webContents.send('ordax:task:stream', { taskId:liveRun.taskId, runId:liveRun.runId, ...delta, mirrorAt:Date.now(), runStartedAt:liveRun.startedAt });
  });

  win.contentView.addChildView(worker.view);
  win.on('resize', layoutViews);
  win.on('maximize', layoutViews);
  win.on('unmaximize', layoutViews);

  await win.loadFile(path.join(here, 'ui.html'));
  layoutViews();
  await worker.load('https://chatgpt.com/');
}

ipcMain.on('ordax:worker:preload-ready', (event, payload) => {
  if (!worker || event.sender.id !== worker.view.webContents.id) return;
  workerPreload = { ready:true, url:String(payload?.url || ''), at:Number(payload?.at || Date.now()) };
});

ipcMain.on('ordax:worker:stream', (event, snapshot) => {
  if (!worker || event.sender.id !== worker.view.webContents.id || !liveRun || !win || win.isDestroyed()) return;
  const delta = worker.acceptStreamSnapshot(snapshot);
  if (!delta) return;
  const mirrorAt = Date.now();
  if (!liveRun.firstDeltaAt) liveRun.firstDeltaAt = delta.firstDeltaAt || mirrorAt;
  win.webContents.send('ordax:task:stream', { taskId:liveRun.taskId, runId:liveRun.runId, source:'beta', ...delta, mirrorAt, runStartedAt:liveRun.startedAt });
});

ipcMain.handle('ordax:workspace:get', () => store.getWorkspaceSession());
ipcMain.handle('ordax:tasks:list', () => store.listTasks());
ipcMain.handle('ordax:tasks:create', (_event, title) => decorateTask(store.createTask(String(title || 'Nova tarefa'))));
ipcMain.handle('ordax:tasks:get', (_event, id) => getTaskView(id));
ipcMain.handle('ordax:tasks:messages:page', (_event, { taskId, before }) => {
  if (!store.getTaskExecutionSnapshot(String(taskId))) throw new Error('task_not_found');
  const page = store.messagesPage(String(taskId), { before });
  return { ...page, messages:decorateMessages(page.messages) };
});
ipcMain.handle('ordax:tasks:rename', (_event, { taskId, title }) => {
  store.renameTask(String(taskId), title);
  return getTaskView(taskId);
});
ipcMain.handle('ordax:tasks:draft:set', (_event, { taskId, content, revision }) =>
  store.setDraft(String(taskId), content, revision));
ipcMain.handle('ordax:tasks:open', async (_event, id) => {
  const task = getTaskView(id);
  if (chatVisible && task?.chat_url) await worker.showConversation(task.chat_url).catch(() => {});
  return task;
});
ipcMain.handle('ordax:tasks:resume-capsule', (_event, id) => store.buildResumeCapsule(String(id)));
ipcMain.handle('ordax:tasks:rotate-conversation', (_event, id) => {
  if (liveRun) throw new Error('conversation_rotation_during_run');
  store.rotateConversation(String(id), 'manual_ui');
  return getTaskView(id);
});
ipcMain.handle('ordax:tasks:memory:upsert', (_event, { taskId, item }) => {
  store.upsertProjectMemory(String(taskId), { ...(item || {}), source_type:'manual' });
  return getTaskView(taskId);
});
ipcMain.handle('ordax:tasks:memory:archive', (_event, { taskId, memoryId }) => {
  store.archiveProjectMemory(String(taskId), String(memoryId));
  return getTaskView(taskId);
});
ipcMain.handle('ordax:tasks:memory:candidates:scan', (_event, taskId) => {
  store.memoryCandidates.scan(String(taskId));
  return getTaskView(taskId);
});
ipcMain.handle('ordax:tasks:memory:candidates:review', (_event, { taskId, candidateId, action, changes }) => {
  store.memoryCandidates.review(String(taskId), String(candidateId), String(action), changes || {});
  return getTaskView(taskId);
});
ipcMain.handle('ordax:provider:status', async () => {
  const base = worker.status();
  if (base.active) {
    const cached = providerHealthCache || { composer_ready:false, verification_required:false, auth_state:'loading' };
    return { ...cached, ...base, observer_mode:observerMode, worker_preload:workerPreload, health_pending:Boolean(providerHealthInFlight) };
  }
  if (!providerHealthInFlight) {
    providerHealthInFlight = worker.health()
      .then(status => { providerHealthCache = status; return status; })
      .finally(() => { providerHealthInFlight = null; });
  }
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), 900));
  const fresh = await Promise.race([providerHealthInFlight, timeout]);
  const status = fresh || providerHealthCache || { ...base, composer_ready:false, verification_required:false, auth_state:'loading' };
  return { ...status, observer_mode:observerMode, worker_preload:workerPreload, health_pending:!fresh };
});
ipcMain.handle('ordax:provider:observer-mode:get', () => observerMode);
ipcMain.handle('ordax:provider:observer-mode:set', (_event, mode) => {
  const next = String(mode || '').toLowerCase();
  if (!['auto','fast','beta'].includes(next)) throw new Error('invalid_observer_mode');
  observerMode = next;
  worker.setObserverMode(next);
  store.updateWorkspaceMetadata({ observer_mode: next });
  return next;
});
ipcMain.handle('ordax:provider:login', () => worker.login());
ipcMain.handle('ordax:provider:login-google', () => worker.loginGoogle());
ipcMain.handle('ordax:provider:home', () => worker.newChat());
ipcMain.handle('ordax:provider:reload', () => worker.view.webContents.reload());
ipcMain.handle('ordax:chat:visible', (_event, visible) => {
  chatVisible = Boolean(visible);
  layoutViews();
  return chatVisible;
});
ipcMain.handle('ordax:tasks:send', async (_event, { taskId, content, newSession = false, draftRevision = null }) => {
  const prompt = String(content || '').trim();
  if (!prompt) throw new Error('content_required');
  return enqueueExecution(() => runTask(String(taskId), prompt, { newSession: Boolean(newSession), draftRevision }));
});

app.whenReady().then(async () => {
  protocol.handle('ordax-asset', request => {
    try {
      const url = new URL(request.url);
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const asset = store.getAsset(id);
      if (!asset) return new Response('Not found', { status: 404 });

      const resolved = path.resolve(asset.local_path);
      const safeRoot = path.resolve(assetsRoot) + path.sep;
      if (!resolved.startsWith(safeRoot) || !fs.existsSync(resolved)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(resolved).href);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  store.close();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
