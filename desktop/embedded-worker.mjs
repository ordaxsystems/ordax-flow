import { WebContentsView, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHAT_ORIGINS = /^https:\/\/(chatgpt\.com|auth\.openai\.com|accounts\.google\.com)\//i;
const here = path.dirname(fileURLToPath(import.meta.url));

const selectors = {
  composer: [
    '#prompt-textarea',
    '#mobile-composer-prompt',
    'textarea[placeholder="Pergunte ao ChatGPT"]',
    'textarea[aria-label*="ChatGPT"]',
    '[contenteditable="true"][data-composer-markdown]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    '[contenteditable="true"][role="textbox"]'
  ],
  send: [
    'button[data-testid="send-button"]',
    'button[aria-label="Enviar"]',
    'button[aria-label="Send"]',
    'button[aria-label*="Enviar"]',
    'button[aria-label*="Send"]'
  ]
};

function createView(partition) {
  return new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(here, 'worker-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
}

function composerExpression() {
  return `(() => {
    const sels = ${JSON.stringify(selectors.composer)};
    const all = sels.flatMap(selector => Array.from(document.querySelectorAll(selector)));
    const usable = element => {
      if (!element || !element.closest('form') || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return all.find(usable) || all.find(element => element && element.closest('form')) || null;
  })()`;
}

function cleanBodyCandidate(raw) {
  const noise = [
    /^\d+(?:\.\d+)?\s+(?:Medium|High|Low)$/i,
    /^(?:Medium|High|Low)$/i,
    /^(?:Copiar|Copy|Gostei|Like|Não gostei|Dislike|Regenerar|Retry|Compartilhar|Share|Editar|Edit|Resposta concluída|Response completed|ChatGPT está respondendo|ChatGPT is responding)$/i,
    /^(?:Pergunte ao ChatGPT|Message ChatGPT)$/i,
    /^(?:Você gosta dessa personalidade\??|Do you like this personality\??)$/i,
    /^(?:Conte-nos mais|Tell us more)$/i
  ];
  return String(raw || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !noise.some(pattern => pattern.test(line)))
    .join('\n')
    .trim();
}

export class EmbeddedChatWorker {
  constructor() {
    this.partition = process.env.ORDAX_CHATGPT_PARTITION || 'persist:ordax-gratis-chatgpt';
    this.session = session.fromPartition(this.partition);
    this.view = createView(this.partition);
    this.active = false;
    this.lastError = null;
    this.ready = false;
    this.chain = Promise.resolve();
    this.streamContext = null;
    this.seenAssistantMessageIds = new Set();
    this.stage = 'idle';
    this.observerMode = 'auto';
    this.fastNetwork = { enabled:false, streamCapable:false, firstByteAt:null, activeRequestId:null, text:'', requests:new Map() };
    this.fastStreamSink = null;
    this.#configureView();
    this.#configureFastNetworkObserver();
  }

  setObserverMode(mode = 'auto') {
    if (!['auto', 'fast', 'beta'].includes(mode)) throw new Error('invalid_observer_mode');
    this.observerMode = mode;
    return this.observerMode;
  }

  setFastStreamSink(fn) {
    this.fastStreamSink = typeof fn === 'function' ? fn : null;
  }

  #applyFastFragment(fragment) {
    const value = String(fragment || '');
    if (!value || value.length > 20000 || !this.streamContext) return;
    const current = this.fastNetwork.text;
    this.fastNetwork.text = value.startsWith(current) ? value : current + value;
    const text = this.fastNetwork.text.trim();
    if (!text) return;
    const ctx = this.streamContext;
    ctx.fastSeen = true;
    const internalKeys = /(?:transparent_background|referenced_image_ids|is_style_transfer|tool_call|tool_calls|recipient|arguments)/i;
    const structuredPayload = /^(?:null\s*,|[\[{])/.test(text) && /["']?[A-Za-z_][A-Za-z0-9_]*["']?\s*:/.test(text);
    if (internalKeys.test(text) || structuredPayload) {
      ctx.fastSuppressed = true;
      ctx.fastSuppressionReason = internalKeys.test(text) ? 'internal_tool_payload' : 'structured_payload';
      return;
    }
    if (ctx.fastSuppressed || text.length < 2) return;
    const at = Date.now();
    if (!ctx.fastFirstDeltaAt) ctx.fastFirstDeltaAt = at;
    if (!ctx.firstDeltaAt) { ctx.firstDeltaAt = at; ctx.firstObserver = 'fast'; }
    const previous = String(ctx.lastDeliveredText || '');
    if (previous) {
      if (previous === text || previous.startsWith(text)) return;
      if (ctx.lastDeliveredSource === 'beta' && !text.startsWith(previous)) return;
      if (!text.startsWith(previous) && text.length < previous.length) return;
    }
    ctx.lastDeliveredText = text;
    ctx.lastDeliveredSource = 'fast';
    ctx.fastDelivered = true;
    this.fastStreamSink?.({ text, generating:true, complete:false, source:'fast', at, firstDeltaAt:ctx.firstDeltaAt, submitAttemptAt:ctx.submitAttemptAt, submittedAt:ctx.submittedAt });
  }

  #consumeFastPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    const v = payload.v;
    if (Array.isArray(v)) {
      for (const patch of v) {
        if (!patch || typeof patch !== 'object' || !['append','add'].includes(String(patch.o || patch.op || '').toLowerCase())) continue;
        const value = patch.v ?? patch.value;
        if (typeof value === 'string') this.#applyFastFragment(value);
      }
    } else if (typeof v === 'string') {
      this.#applyFastFragment(v);
    }
    if (typeof payload.delta === 'string') this.#applyFastFragment(payload.delta);
  }

  #consumeFastData(requestId, encoded) {
    const req = this.fastNetwork.requests.get(requestId);
    if (!req || !encoded) return;
    let chunk = '';
    try { chunk = Buffer.from(encoded, 'base64').toString('utf8'); } catch { return; }
    req.buffer += chunk;
    const lines = req.buffer.split(/\r?\n/);
    req.buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try { this.#consumeFastPayload(JSON.parse(raw)); } catch {}
    }
  }

  #configureFastNetworkObserver() {
    const wc = this.view.webContents;
    wc.debugger.on('message', (_event, method, params = {}) => {
      if (!this.streamContext || this.observerMode === 'beta') return;
      if (method === 'Network.requestWillBeSent') {
        const request = params.request || {};
        const armedAt = this.streamContext.submitAttemptAt;
        if (!armedAt || String(request.method || '').toUpperCase() !== 'POST' || !['Fetch','XHR'].includes(String(params.type || ''))) return;
        try { if (new URL(request.url).origin !== 'https://chatgpt.com') return; } catch { return; }
        const postData = String(request.postData || '');
        if (!postData || !postData.includes(this.streamContext.promptText)) return;
        const seenAt = Date.now();
        this.streamContext.providerRequestSeenAt = seenAt;
        this.fastNetwork.requests.set(params.requestId, { url:request.url, startedAt:seenAt, buffer:'', streaming:false });
        return;
      }
      if (method === 'Network.responseReceived') {
        const req = this.fastNetwork.requests.get(params.requestId);
        if (!req) return;
        const mime = String(params.response?.mimeType || '');
        if (!/event-stream|json|octet-stream/i.test(mime)) return;
        wc.debugger.sendCommand('Network.streamResourceContent', { requestId:params.requestId }).then(result => {
          req.streaming = true;
          this.fastNetwork.streamCapable = true;
          this.fastNetwork.activeRequestId = params.requestId;
          if (!this.fastNetwork.firstByteAt) { this.fastNetwork.firstByteAt = Date.now(); this.streamContext.networkFirstByteAt = this.fastNetwork.firstByteAt; }
          if (result?.bufferedData) this.#consumeFastData(params.requestId, result.bufferedData);
        }).catch(() => {});
        return;
      }
      if (method === 'Network.dataReceived') {
        const req = this.fastNetwork.requests.get(params.requestId);
        if (!req?.streaming || !params.data) return;
        if (!this.fastNetwork.firstByteAt) { this.fastNetwork.firstByteAt = Date.now(); this.streamContext.networkFirstByteAt = this.fastNetwork.firstByteAt; }
        this.#consumeFastData(params.requestId, params.data);
      }
    });
  }

  async #ensureNetworkObserver() {
    if (this.observerMode === 'beta') return false;
    const wc = this.view.webContents;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      if (!this.fastNetwork.enabled) {
        await wc.debugger.sendCommand('Network.enable');
        this.fastNetwork.enabled = true;
      }
      return true;
    } catch {
      this.fastNetwork.enabled = false;
      return false;
    }
  }

  #configureView() {
    this.view.webContents.setWindowOpenHandler(({ url }) => {
      if (CHAT_ORIGINS.test(url)) this.view.webContents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    this.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.view.webContents.on('will-navigate', (event, url) => {
      if (!CHAT_ORIGINS.test(url)) { event.preventDefault(); this.lastError = 'navigation_blocked'; }
    });
    this.view.webContents.on('did-finish-load', () => { this.ready = true; });
    this.view.webContents.on('did-fail-load', (_event, code, description) => {
      if (code !== -3) this.lastError = `load_failed:${code}:${description}`;
    });
  }

  async load(url = 'https://chatgpt.com/') {
    await this.#safeLoad(url, { requireComposer: false });
  }

  status() {
    return {
      connected: !this.view.webContents.isDestroyed(),
      active: this.active,
      ready: this.ready,
      url: this.view.webContents.getURL(),
      title: this.view.webContents.getTitle(),
      backend: 'electron-embedded-chatgpt',
      persistent_session: true,
      single_visual_session: true,
      api_used: false,
      private_endpoint_used: false,
      last_error: this.lastError,
      stage: this.stage,
      observer_mode: this.observerMode,
      fast_observer_ready: this.fastNetwork.enabled,
      fast_stream_capable: this.fastNetwork.streamCapable
    };
  }

  async health() {
    const base = this.status();
    if (!base.connected) return { ...base, verification_required:false, auth_state:'unavailable' };
    const page = await this.view.webContents.executeJavaScript(`(() => {
      const body=document.body?.innerText||'';
      const composer=${composerExpression()};
      return {
        body:body.slice(-5000),
        composer:Boolean(composer),
        hasLogin:/Entrar|Log in|Sign in/i.test(body),
        hasSignup:/Cadastre-se|Sign up/i.test(body),
        verification:/Ocorreu um erro durante a verificação|verification.*(?:failed|error)|verificação.*erro/i.test(body)
      };
    })()`).catch(() => ({ body:'', composer:false, hasLogin:false, hasSignup:false, verification:false }));
    const url = this.view.webContents.getURL();
    const authState = /accounts\.google\.com|auth\.openai\.com|chatgpt\.com\/auth\//i.test(url)
      ? 'authenticating'
      : (page.hasLogin && page.hasSignup ? 'anonymous' : 'session_present');
    return { ...base, composer_ready:page.composer, verification_required:Boolean(page.verification), auth_state:authState };
  }

  enqueue(fn) {
    const run = async () => {
      this.active = true;
      try { return await fn(); }
      finally { this.active = false; }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async login() {
    await this.#safeLoad('https://chatgpt.com/auth/login', { requireComposer: false });
    return this.status();
  }

  async loginGoogle() {
    await this.#safeLoad('https://chatgpt.com/auth/login', { requireComposer: false });
    let point = null;
    for (let i = 0; i < 40; i++) {
      const currentUrl = this.view.webContents.getURL();
      if (currentUrl && !currentUrl.includes('chatgpt.com/auth/login')) return this.status();
      point = await this.view.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find(el => /Continuar com o Google|Continue with Google/i.test((el.innerText || el.textContent || '').trim()));
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`).catch(() => null);
      if (point) break;
      await sleep(250);
    }
    if (!point) throw new Error('google_login_button_not_found');
    const wc = this.view.webContents;
    wc.focus();
    wc.sendInputEvent({ type:'mouseMove', x:point.x, y:point.y });
    wc.sendInputEvent({ type:'mouseDown', x:point.x, y:point.y, button:'left', clickCount:1 });
    wc.sendInputEvent({ type:'mouseUp', x:point.x, y:point.y, button:'left', clickCount:1 });
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const url = wc.getURL();
      if (url && !url.includes('chatgpt.com/auth/login')) return this.status();
    }
    throw new Error('google_login_navigation_not_observed');
  }

  async #startNewChat() {
    const wc = this.view.webContents;
    const currentUrl = wc.getURL();
    try {
      const current = new URL(currentUrl);
      if (current.origin === 'https://chatgpt.com') {
        const clicked = await wc.executeJavaScript(`(() => {
          const visible = node => Boolean(node && node.getClientRects().length);
          const controls = [...document.querySelectorAll('button,a')].filter(visible);
          const semantic = controls.find(node => /^(Novo chat|New chat)$/i.test((node.innerText || node.textContent || '').trim()));
          const selectors = [
            '[data-testid=\"create-new-chat-button\"]',
            'button[aria-label*=\"Novo chat\" i]',
            'a[aria-label*=\"Novo chat\" i]',
            'button[aria-label*=\"New chat\" i]',
            'a[aria-label*=\"New chat\" i]'
          ];
          const structural = selectors.map(s => document.querySelector(s)).find(visible);
          const el = semantic || structural;
          if (!el) return false;
          el.click();
          return true;
        })()`).catch(() => false);
        if (clicked) {
          const started = Date.now();
          while (Date.now() - started < 2500) {
            await sleep(50);
            const url = wc.getURL();
            const state = await this.#composerState().catch(() => ({ found:false, formReady:false, text:'' }));
            try {
              const parsed = new URL(url);
              const contextChanged = url !== currentUrl || parsed.pathname === '/';
              if (parsed.origin === 'https://chatgpt.com' && contextChanged && state.found && state.formReady && !state.text?.trim()) return true;
            } catch {}
          }
        }
      }
    } catch {}
    await this.#safeLoad('https://chatgpt.com/', { requireComposer:true, protectDraft:true });
    return false;
  }

  async newChat() {
    await this.#startNewChat();
    return this.status();
  }

  async showConversation(url, { force = false } = {}) {
    if (!/^https:\/\/chatgpt\.com\//i.test(String(url || ''))) throw new Error('invalid_chat_url');
    const current = this.view.webContents.getURL();
    if (!force && current !== url) {
      const state = await this.#composerState().catch(() => ({ found:false, text:'' }));
      if (state.text?.trim()) return { ...this.status(), navigated:false, reason:'visible_draft_present' };
    }
    if (current !== url) await this.#safeLoad(url, { requireComposer: true, protectDraft: !force });
    return { ...this.status(), navigated:true };
  }

  async #composerState() {
    return this.view.webContents.executeJavaScript(`(() => {
      const sels = ${JSON.stringify(selectors.composer)};
      const el = ${composerExpression()};
      if (!el) return { found:false, text:'' };
      const text = 'value' in el ? el.value : (el.innerText || el.textContent || '');
      return { found:true, formReady:Boolean(el.closest('form')), text:String(text || ''), tag:el.tagName, id:el.id || '' };
    })()`);
  }

  async #waitForComposer(timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const state = await this.#composerState().catch(() => ({ found:false, text:'' }));
      if (state.found && state.formReady) return state;
      await sleep(250);
    }
    throw new Error('composer_not_found');
  }

  async #safeLoad(url, { requireComposer = false, protectDraft = false } = {}) {
    const wc = this.view.webContents;
    if (protectDraft) {
      const state = await this.#composerState().catch(() => ({ found:false, text:'' }));
      if (state.text?.trim()) throw new Error('chatgpt_draft_present');
    }
    const target = new URL(url);
    const currentUrl = wc.getURL();
    if (currentUrl) {
      try {
        const current = new URL(currentUrl);
        if (current.origin === target.origin && current.pathname === target.pathname && current.search === target.search) {
          if (!requireComposer) return;
          const state = await this.#composerState().catch(() => ({ found:false }));
          if (state.found) return;
        }
      } catch {}
    }
    try {
      await wc.loadURL(url);
    } catch (error) {
      const message = String(error?.message || error);
      if (!(error?.code === -3 || /\(-3\)|ERR_ABORTED/i.test(message))) throw error;
    }
    if (requireComposer) await this.#waitForComposer();
  }

  async #assistantSnapshot() {
    return this.view.webContents.executeJavaScript(`(() => {
      const nodes = Array.from(document.querySelectorAll('[data-message-role="assistant"], [data-message-author-role="assistant"], [data-message-author="assistant"], [data-chatgpt-selection-message-id]'));
      const userNodes = Array.from(document.querySelectorAll('[data-message-role="user"], [data-message-author-role="user"], [data-message-author="user"], [data-user-message-bubble="true"]'));
      const latestUserText = String(userNodes.at(-1)?.innerText || userNodes.at(-1)?.textContent || '').trim();
      const imageData = img => ({ src: img.currentSrc || img.src || '', alt: img.alt || '', width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
      const validImage = (img, min) => Boolean(img.src) && (img.width >= min || img.height >= min || img.src.includes('images.openai.com'));
      const generatedImages = Array.from(document.querySelectorAll('[data-testid="generated-image-preview"] img')).map(imageData).filter(img => validImage(img, 64));
      const readNode = node => {
        const id = node.getAttribute('data-chatgpt-selection-message-id') || node.getAttribute('data-message-id') || '';
        const markdown = node.querySelector('[data-assistant-markdown], [data-message-content]');
        let text = String((markdown && markdown.innerText) || node.innerText || '').trim();
        text = text.replace(/^O ChatGPT disse:\\s*/i, '').replace(/^ChatGPT disse:\\s*/i, '').replace(/^ChatGPT said:\\s*/i, '').trim();
        text = text.split(/\\r?\\n/).map(line => line.trim()).filter(line => line && !/^(Editar|Edit|Resposta concluída|Response completed|Copiar|Copy|Compartilhar|Share|Você gosta dessa personalidade\??|Do you like this personality\??|Conte-nos mais|Tell us more)$/i.test(line)).join('\\n').trim();
        const images = Array.from(node.querySelectorAll('img')).map(imageData).filter(img => validImage(img, 64));
        const generating = Boolean(document.querySelector('button[data-testid="stop-button"],button[aria-label*="Parar"],button[aria-label*="Stop"]'));
        return { id, text, images, complete: !generating || node.hasAttribute('data-message-complete') || Boolean(node.querySelector('[data-message-complete]')) };
      };
      if (nodes.length) return { mode:'direct', messages:nodes.map(readNode), rawBody:'', images:generatedImages, latestUserText };
      const conversationRoot = document.querySelector('main,[role="main"]');
      const body = (conversationRoot && conversationRoot.innerText) || '';
      const images = Array.from((conversationRoot || document).querySelectorAll('img')).map(imageData).filter(img => validImage(img, 128));
      return { mode:'body', messages:[], rawBody:body, images:[...images, ...generatedImages].filter((image,index,all) => all.findIndex(other => other.src === image.src) === index), latestUserText };
    })()`);
  }

  async #setComposerAndSend(prompt) {
    const wc = this.view.webContents;
    const initial = await this.#waitForComposer();
    if (initial.text.trim()) throw new Error('chatgpt_draft_present');

    const beforeUserCount = await wc.executeJavaScript(`(() => document.querySelectorAll('[data-message-role="user"],[data-message-author-role="user"],[data-message-author="user"]').length)()`).catch(() => 0);
    const prepared = await wc.executeJavaScript(`(() => {
      const sels = ${JSON.stringify(selectors.composer)};
      const input = ${composerExpression()};
      if (!input) return false;
      input.focus();
      return true;
    })()`).catch(() => false);
    if (!prepared) throw new Error('composer_not_found');

    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    } catch (error) {
      if (!wc.debugger.isAttached()) throw new Error('chromium_input_channel_unavailable');
    }

    await wc.debugger.sendCommand('Input.insertText', { text: prompt });
    let recognized = false;
    for (let i = 0; i < 50; i++) {
      const state = await this.#composerState().catch(() => ({ found:false, text:'' }));
      if (state.text.trim() === prompt.trim()) { recognized = true; break; }
      await sleep(80);
    }
    if (!recognized) throw new Error('composer_input_not_recognized');

    const observeSent = async attempts => {
      for (let i = 0; i < attempts; i++) {
        await sleep(100);
        const sent = await wc.executeJavaScript(`(() => {
          const composer = ${composerExpression()};
          const text = composer ? ('value' in composer ? composer.value : (composer.innerText || composer.textContent || '')) : '';
          const body = document.body?.innerText || '';
          const userCount = document.querySelectorAll('[data-message-role=\"user\"],[data-message-author-role=\"user\"],[data-message-author=\"user\"]').length;
          return { empty:!String(text||'').trim(), promptVisible:body.includes(${JSON.stringify(prompt)}), userCount }; 
        })()`).catch(() => ({ empty:false, promptVisible:false, userCount:0 }));
        if (sent.empty && (sent.userCount > beforeUserCount || sent.promptVisible || this.streamContext?.providerRequestSeenAt)) return true;
      }
      return false;
    };

    const submitState = await wc.executeJavaScript(`(() => {
      const input = ${composerExpression()};
      const form = input?.closest('form');
      const send = form ? ${JSON.stringify(selectors.send)}.flatMap(selector => Array.from(form.querySelectorAll(selector))).find(el => el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length) : null;
      const r = send?.getBoundingClientRect();
      return { form:!!form, button:!!send, x:r? r.left+r.width/2:null, y:r? r.top+r.height/2:null };
    })()`).catch(() => ({ form:false, button:false, x:null, y:null }));

    if (submitState.button) {
      if (this.streamContext && !this.streamContext.submitAttemptAt) this.streamContext.submitAttemptAt = Date.now();
      await wc.executeJavaScript(`(() => {
        const input = ${composerExpression()};
        const form = input?.closest('form');
        const send = form ? ${JSON.stringify(selectors.send)}.flatMap(selector => Array.from(form.querySelectorAll(selector))).find(el => el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length) : null;
        if (!send) return false; send.click(); return true;
      })()`).catch(() => false);
      if (await observeSent(18)) { if (this.streamContext) this.streamContext.submittedAt = Date.now(); return; }
    }

    if (submitState.form) {
      if (this.streamContext && !this.streamContext.submitAttemptAt) this.streamContext.submitAttemptAt = Date.now();
      await wc.executeJavaScript(`(() => {
        const input = ${composerExpression()};
        const form = input?.closest('form');
        const send = form ? ${JSON.stringify(selectors.send)}.flatMap(selector => Array.from(form.querySelectorAll(selector))).find(el => el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length) : null;
        if (!form) return false;
        if (typeof form.requestSubmit === 'function') form.requestSubmit(send || undefined);
        else form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
        return true;
      })()`).catch(() => false);
      if (await observeSent(18)) { if (this.streamContext) this.streamContext.submittedAt = Date.now(); return; }
    }

    if (submitState.button && Number.isFinite(submitState.x) && Number.isFinite(submitState.y)) {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mousePressed', x:submitState.x, y:submitState.y, button:'left', clickCount:1 });
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseReleased', x:submitState.x, y:submitState.y, button:'left', clickCount:1 });
      if (await observeSent(18)) { if (this.streamContext) this.streamContext.submittedAt = Date.now(); return; }
    }

    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13 });
    if (await observeSent(18)) return;

    const gate = await wc.executeJavaScript(`(() => {
      const body=document.body?.innerText||'';
      return {
        login:/Entre ou cadastre-se|Continuar com o Google|Continue with Google|Log in or sign up/i.test(body),
        verification:/Ocorreu um erro durante a verificação|verification.*(?:failed|error)|verificação.*erro/i.test(body)
      };
    })()`).catch(() => ({ login:false, verification:false }));
    if (gate.verification) throw new Error('chatgpt_verification_required');
    if (gate.login) throw new Error('chatgpt_login_required');
    throw new Error('send_not_observed');
  }

  async #fetchImages(images = []) {
    const out = [];
    for (const image of images) {
      try {
        const data = await this.view.webContents.executeJavaScript(`(async () => {
          const response=await fetch(${JSON.stringify(image.src)}); if(!response.ok)return null;
          const blob=await response.blob(),buffer=await blob.arrayBuffer(),bytes=new Uint8Array(buffer);
          let binary=''; for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
          return {mimeType:blob.type||'image/png',base64:btoa(binary)};
        })()`);
        if (data?.base64) out.push({ ...image, ...data });
      } catch {}
    }
    return out;
  }

  acceptStreamSnapshot(snapshot) {
    const ctx = this.streamContext;
    if (!ctx || !snapshot) return null;
    const latestUserText = String(snapshot.latestUserText || '').trim();
    if (snapshot.mode === 'direct' && latestUserText && latestUserText !== ctx.promptText) return null;
    const messageId = String(snapshot.messageId || '').trim();
    const freshVisualImages = (snapshot.images || []).filter(image => image?.src && !ctx.beforeImageSources.has(image.src));
    let staleAssistantMessage = false;
    if (snapshot.mode === 'direct' && messageId) {
      staleAssistantMessage = this.seenAssistantMessageIds.has(messageId) && messageId !== ctx.currentAssistantMessageId;
      if (!staleAssistantMessage) {
        if (!ctx.currentAssistantMessageId) ctx.currentAssistantMessageId = messageId;
        else if (ctx.currentAssistantMessageId !== messageId && !freshVisualImages.length) return null;
      }
      if (staleAssistantMessage && !freshVisualImages.length) return null;
    }

    let text = '';
    let images = freshVisualImages;
    if (snapshot.mode === 'body') {
      const raw = String(snapshot.rawBody || '');
      const index = raw.lastIndexOf(ctx.promptText);
      if (index < 0) return null;
      let scoped = raw.slice(index + ctx.promptText.length);
      const assistantBoundary = scoped.search(/(?:O ChatGPT disse:|ChatGPT disse:|ChatGPT said:)/i);
      if (assistantBoundary < 0) return null;
      scoped = scoped.slice(assistantBoundary);
      for (const footer of ['O ChatGPT pode cometer erros','ChatGPT é uma IA','ChatGPT can make mistakes','Pergunte ao ChatGPT','Message ChatGPT','Esta conversa está sendo útil até agora?','Has this conversation been helpful so far?']) {
        const boundary = scoped.indexOf(footer);
        if (boundary >= 0) scoped = scoped.slice(0, boundary);
      }
      text = cleanBodyCandidate(scoped.replace(/^\s*(O ChatGPT disse:|ChatGPT disse:|ChatGPT said:)\s*/i, ''));
      images = images.filter(image => !ctx.beforeImageSources.has(image.src));
    } else {
      text = staleAssistantMessage ? '' : String(snapshot.text || '').trim();
      images = freshVisualImages.length ? freshVisualImages : (staleAssistantMessage ? [] : (snapshot.images || []));
    }

    const activityAt = Number(snapshot.at || Date.now());
    if (!ctx.firstActivityAt && (snapshot.generating || text || images.length)) ctx.firstActivityAt = activityAt;
    const imageSources = images.map(image => image.src).filter(Boolean);
    const signature = JSON.stringify([text, imageSources]);
    const isNew = snapshot.mode === 'body'
      ? Boolean(text || imageSources.length)
      : (Number(snapshot.assistantCount || 0) > ctx.beforeCount || signature !== ctx.baseline);
    if (!isNew || (!text && !imageSources.length) || signature === ctx.lastSignature) return null;
    if (!ctx.betaFirstDeltaAt) ctx.betaFirstDeltaAt = Number(snapshot.at || Date.now());
    ctx.betaSeen = true;
    if (!ctx.firstDeltaAt) { ctx.firstDeltaAt = ctx.betaFirstDeltaAt; ctx.firstObserver = 'beta'; }
    const previous = String(ctx.lastDeliveredText || '');
    let deliveryText = text;
    if (text && previous) {
      const wouldRegress = previous.startsWith(text) || (!text.startsWith(previous) && text.length < previous.length);
      if (wouldRegress) {
        ctx.lastSignature = signature;
        if (!imageSources.length) return null;
        deliveryText = previous;
      }
    }
    if (deliveryText && deliveryText !== previous) {
      ctx.lastDeliveredText = deliveryText;
      ctx.lastDeliveredSource = 'beta';
    }
    ctx.lastSignature = signature;
    return {
      text: deliveryText,
      images,
      generating: Boolean(snapshot.generating),
      complete: Boolean(snapshot.complete),
      at: Number(snapshot.at || Date.now()),
      firstActivityAt: ctx.firstActivityAt,
      firstDeltaAt: ctx.firstDeltaAt,
      submitAttemptAt: ctx.submitAttemptAt || null,
      submittedAt: ctx.submittedAt || null
    };
  }

  async sendPrompt({ prompt, chatUrl = null, newSession = false }) {
    return this.enqueue(async () => {
      const wc = this.view.webContents;
      const prepareStartedAt = Date.now();
      this.stage = 'health';
      const health = await this.health();
      const healthCompletedAt = Date.now();
      if (health.verification_required) throw new Error('chatgpt_verification_required');
      if (health.auth_state === 'authenticating') throw new Error('chatgpt_authentication_in_progress');
      this.stage = 'prepare';
      const currentDraft = await this.#composerState().catch(() => ({ found:false, text:'' }));
      const draftCheckedAt = Date.now();
      if (currentDraft.text?.trim()) throw new Error('chatgpt_draft_present');
      const previousSnapshot = await this.#assistantSnapshot().catch(() => ({ messages:[] }));
      for (const message of previousSnapshot.messages || []) {
        if (message?.id) this.seenAssistantMessageIds.add(String(message.id));
      }

      if (newSession || !chatUrl) await this.#startNewChat();
      else if (wc.getURL() !== chatUrl) await this.#safeLoad(chatUrl, { requireComposer:true, protectDraft:true });
      else await this.#waitForComposer();
      const conversationReadyAt = Date.now();

      this.stage = 'baseline';
      this.fastNetwork.firstByteAt = null;
      this.fastNetwork.activeRequestId = null;
      this.fastNetwork.text = '';
      this.fastNetwork.requests.clear();
      await this.#ensureNetworkObserver();
      const observerReadyAt = Date.now();
      const before = await this.#assistantSnapshot();
      const beforeCount = before.messages.length;
      const beforeLast = before.messages.at(-1) || { text:'', images:[] };
      const beforeImages = new Set((before.images || beforeLast.images || []).map(image => image.src));
      const signatureFor = message => JSON.stringify({ text:String(message?.text||'').trim(), images:(message?.images||[]).map(i=>i.src).filter(Boolean) });
      const baseline = signatureFor(beforeLast);
      const baselineReadyAt = Date.now();
      const promptText = String(prompt || '').trim();
      this.streamContext = { beforeCount, baseline, promptText, beforeImageSources:new Set(beforeImages), currentAssistantMessageId:null, lastSignature:'', firstActivityAt:null, firstDeltaAt:null, firstObserver:null, fastFirstDeltaAt:null, betaFirstDeltaAt:null, submitAttemptAt:null, providerRequestSeenAt:null, submittedAt:null, networkFirstByteAt:null, fastSeen:false, betaSeen:false, fastDelivered:false, fastSuppressed:false, fastSuppressionReason:null, lastDeliveredText:'', lastDeliveredSource:null, prepareStartedAt, healthCompletedAt, draftCheckedAt, conversationReadyAt, observerReadyAt, baselineReadyAt };

      this.stage = 'submit';
      await this.#setComposerAndSend(promptText);
      if (!this.streamContext.submittedAt) this.streamContext.submittedAt = Date.now();

      this.stage = 'await-response';
      const started = Date.now();
      let latest = null, latestSignature = '', stable = 0;
      while (Date.now() - started < 180000) {
        await sleep(300);
        const snap = await this.#assistantSnapshot().catch(() => ({ mode:'unknown', messages:[], rawBody:'', images:[] }));
        let candidate = snap.messages.at(-1) || null;
        if (snap.mode === 'direct' && snap.latestUserText && String(snap.latestUserText).trim() !== promptText) continue;
        const freshVisualImages = (snap.images || []).filter(image => image?.src && !beforeImages.has(image.src));
        if (snap.mode === 'direct' && candidate?.id) {
          const messageId = String(candidate.id);
          const stale = this.seenAssistantMessageIds.has(messageId) && messageId !== this.streamContext.currentAssistantMessageId;
          if (stale && !freshVisualImages.length) continue;
          if (stale) candidate = { text:'', images:freshVisualImages, complete:true };
          else if (!this.streamContext.currentAssistantMessageId) this.streamContext.currentAssistantMessageId = messageId;
          else if (this.streamContext.currentAssistantMessageId !== messageId && !freshVisualImages.length) continue;
        }
        if (snap.mode === 'direct' && freshVisualImages.length && candidate) candidate = { ...candidate, images:[...(candidate.images || []), ...freshVisualImages].filter((image,index,all) => all.findIndex(other => other.src === image.src) === index) };
        if (snap.mode === 'body') {
          const index = String(snap.rawBody || '').lastIndexOf(promptText);
          let scoped = index >= 0 ? String(snap.rawBody).slice(index + promptText.length) : '';
          const assistantBoundary = scoped.search(/(?:O ChatGPT disse:|ChatGPT disse:|ChatGPT said:)/i);
          if (assistantBoundary < 0) continue;
          scoped = scoped.slice(assistantBoundary);
          for (const footer of ['O ChatGPT pode cometer erros','ChatGPT é uma IA','ChatGPT can make mistakes','Pergunte ao ChatGPT','Message ChatGPT','Esta conversa está sendo útil até agora?','Has this conversation been helpful so far?']) {
            const boundary = scoped.indexOf(footer); if (boundary >= 0) scoped = scoped.slice(0,boundary);
          }
          scoped = cleanBodyCandidate(scoped.replace(/^\s*(O ChatGPT disse:|ChatGPT disse:|ChatGPT said:)\s*/i,''));
          const newImages = (snap.images || []).filter(image => !beforeImages.has(image.src));
          candidate = scoped || newImages.length ? { text:scoped, images:newImages, complete:true } : null;
        }
        if (!candidate || (!candidate.text && !candidate.images?.length)) continue;
        const signature = signatureFor(candidate);
        const isNew = snap.mode === 'body' ? signature !== baseline : (snap.messages.length > beforeCount || signature !== baseline);
        if (!isNew) continue;
        if (signature === latestSignature) stable++; else stable = 0;
        latest = candidate; latestSignature = signature;
        const transient = /^(criando|gerando)\s+imagem/i.test(candidate.text||'') || /^(creating|generating)\s+image/i.test(candidate.text||'');
        const generating = await wc.executeJavaScript(`(() => Boolean(document.querySelector('button[data-testid="stop-button"],button[aria-label*="Parar"],button[aria-label*="Stop"]')))()`).catch(() => false);
        if (!transient && !generating && ((candidate.complete && stable >= 2) || stable >= 4)) break;
      }
      if (!latest) throw new Error('response_not_observed');
      this.stage = 'assets';
      const images = await this.#fetchImages(latest.images || []);
      this.lastError = null;
      if (this.streamContext?.currentAssistantMessageId) this.seenAssistantMessageIds.add(this.streamContext.currentAssistantMessageId);
      const metrics = this.streamContext ? { prepareStartedAt:this.streamContext.prepareStartedAt, healthCompletedAt:this.streamContext.healthCompletedAt, draftCheckedAt:this.streamContext.draftCheckedAt, conversationReadyAt:this.streamContext.conversationReadyAt, observerReadyAt:this.streamContext.observerReadyAt, baselineReadyAt:this.streamContext.baselineReadyAt, submitAttemptAt:this.streamContext.submitAttemptAt, providerRequestSeenAt:this.streamContext.providerRequestSeenAt, submittedAt:this.streamContext.submittedAt, firstActivityAt:this.streamContext.firstActivityAt, firstDeltaAt:this.streamContext.firstDeltaAt, fastFirstDeltaAt:this.streamContext.fastFirstDeltaAt, betaFirstDeltaAt:this.streamContext.betaFirstDeltaAt, networkFirstByteAt:this.streamContext.networkFirstByteAt, completedAt:Date.now(), observerUsed:this.streamContext.firstObserver || (this.streamContext.fastDelivered ? 'fast' : 'beta'), firstObserver:this.streamContext.firstObserver || null, fastSeen:Boolean(this.streamContext.fastSeen), betaSeen:Boolean(this.streamContext.betaSeen), fastDelivered:Boolean(this.streamContext.fastDelivered), fastSuppressed:Boolean(this.streamContext.fastSuppressed), fastSuppressionReason:this.streamContext.fastSuppressionReason || null } : null;
      this.streamContext = null;
      this.stage = 'idle';
      return { text:String(latest.text||'').trim(), images, chatUrl:wc.getURL(), observedAt:new Date().toISOString(), metrics };
    }).catch(error => {
      const stage = this.stage || 'unknown';
      this.streamContext = null;
      this.stage = 'idle';
      this.lastError = `${stage}:${String(error?.message || error)}`;
      throw new Error(this.lastError);
    });
  }
}
