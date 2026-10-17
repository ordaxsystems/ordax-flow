const { ipcRenderer } = require('electron');

const CHANNEL = 'ordax:worker:stream';
const READY_CHANNEL = 'ordax:worker:preload-ready';
let lastSignature = '';
let timer = null;
let observer = null;

function cleanText(raw) {
  return String(raw || '')
    .replace(/^O ChatGPT disse:\s*/i, '')
    .replace(/^ChatGPT disse:\s*/i, '')
    .replace(/^ChatGPT said:\s*/i, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^(Editar|Edit|Resposta concluída|Response completed|Copiar|Copy|Compartilhar|Share|Gostei|Like|Não gostei|Dislike)$/i.test(line))
    .join('\n')
    .trim();
}

function readImages(root, minSize) {
  return Array.from(root.querySelectorAll('img'))
    .map(img => ({ src: img.currentSrc || img.src || '', alt: img.alt || '', width: img.naturalWidth || 0, height: img.naturalHeight || 0 }))
    .filter(img => img.src && (img.width >= minSize || img.height >= minSize || img.src.includes('images.openai.com')));
}

function snapshot() {
  const nodes = Array.from(document.querySelectorAll('[data-message-role="assistant"], [data-message-author-role="assistant"], [data-message-author="assistant"]'));
  const node = nodes[nodes.length - 1] || null;
  const generating = Boolean(document.querySelector('button[data-testid="stop-button"],button[aria-label*="Parar"],button[aria-label*="Stop"]'));

  if (node) {
    const markdown = node.querySelector('[data-assistant-markdown], [data-message-content]');
    return {
      mode: 'direct',
      assistantCount: nodes.length,
      text: cleanText((markdown && markdown.innerText) || node.innerText || ''),
      rawBody: '',
      images: readImages(node, 64),
      generating,
      complete: node.hasAttribute('data-message-complete') || Boolean(node.querySelector('[data-message-complete]')),
      url: location.href,
      at: Date.now()
    };
  }

  const body = (document.body && document.body.innerText) || '';
  return {
    mode: 'body',
    assistantCount: 0,
    text: '',
    rawBody: body.slice(-20000),
    images: readImages(document, 128),
    generating,
    complete: !generating,
    url: location.href,
    at: Date.now()
  };
}

function emit() {
  timer = null;
  try {
    const state = snapshot();
    const signature = JSON.stringify([
      state.mode,
      state.assistantCount,
      state.text,
      state.rawBody.slice(-8000),
      state.images.map(image => image.src),
      state.generating,
      state.complete,
      state.url
    ]);
    if (signature === lastSignature) return;
    lastSignature = signature;
    ipcRenderer.send(CHANNEL, state);
  } catch {}
}

function schedule() {
  if (timer) return;
  timer = setTimeout(emit, 40);
}

function start() {
  observer?.disconnect();
  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-message-complete', 'src', 'aria-label', 'disabled']
  });
  ipcRenderer.send(READY_CHANNEL, { url: location.href, at: Date.now() });
  schedule();
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
else start();
window.addEventListener('pageshow', () => { ipcRenderer.send(READY_CHANNEL, { url: location.href, at: Date.now() }); schedule(); });
