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
  const nodes = Array.from(document.querySelectorAll('[data-message-role="assistant"], [data-message-author-role="assistant"], [data-message-author="assistant"], [data-chatgpt-selection-message-id]'));
  const node = nodes[nodes.length - 1] || null;
  const userNodes = Array.from(document.querySelectorAll('[data-message-role="user"], [data-message-author-role="user"], [data-message-author="user"], [data-user-message-bubble="true"]'));
  const latestUserText = String(userNodes.at(-1)?.innerText || userNodes.at(-1)?.textContent || '').trim();
  const generating = Boolean(document.querySelector('button[data-testid="stop-button"],button[aria-label*="Parar"],button[aria-label*="Stop"]'));
  const generatedImages = readImages(document, 64).filter(image => {
    const el = Array.from(document.querySelectorAll('[data-testid="generated-image-preview"] img')).find(img => (img.currentSrc || img.src || '') === image.src);
    return Boolean(el);
  });

  // ChatGPT can render a provisional assistant MarkdownRoot before its final
  // message wrapper exists. Only prefer it while generation is active and it
  // is outside the previous assistant message; never mirror general page text.
  const provisionalMarkdown = Array.from(document.querySelectorAll('[data-markdown-text-style="assistant-message"]')).at(-1);
  if (generating && provisionalMarkdown && (!node || !node.contains(provisionalMarkdown))) {
    return {
      mode:'direct',
      assistantCount:nodes.length + 1,
      messageId:'',
      latestUserText,
      text:cleanText(provisionalMarkdown.innerText || ''),
      rawBody:'',
      images:[...readImages(provisionalMarkdown, 64), ...generatedImages],
      generating:true,
      complete:false,
      url:location.href,
      at:Date.now()
    };
  }

  if (node) {
    const markdown = node.querySelector('[data-assistant-markdown], [data-message-content]');
    const messageId = node.getAttribute('data-chatgpt-selection-message-id') || node.getAttribute('data-message-id') || '';
    return {
      mode: 'direct',
      assistantCount: nodes.length,
      messageId,
      latestUserText,
      text: cleanText((markdown && markdown.innerText) || node.innerText || ''),
      rawBody: '',
      images: [...readImages(node, 64), ...generatedImages].filter((image,index,all) => all.findIndex(other => other.src === image.src) === index),
      generating,
      complete: !generating || node.hasAttribute('data-message-complete') || Boolean(node.querySelector('[data-message-complete]')),
      url: location.href,
      at: Date.now()
    };
  }

  const conversationRoot = document.querySelector('main,[role="main"]');
  const body = (conversationRoot && conversationRoot.innerText) || '';
  return {
    mode: 'body',
    assistantCount: 0,
    latestUserText,
    text: '',
    rawBody: body.slice(-20000),
    images: [...readImages(conversationRoot || document, 128), ...generatedImages].filter((image,index,all) => all.findIndex(other => other.src === image.src) === index),
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
      state.messageId || '',
      state.latestUserText || '',
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
