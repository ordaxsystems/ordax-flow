// Can a deliberate new OrdaX Task use the provider's already-empty home?
// Only the exact official, parameter-free root is an unambiguous fresh context.
export function canReuseFreshProviderHome({ url, composer } = {}) {
  if (!composer?.found || !composer?.formReady || String(composer.text || '').trim()) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://chatgpt.com'
      && parsed.pathname === '/'
      && parsed.search === ''
      && parsed.hash === '';
  } catch { return false; }
}
