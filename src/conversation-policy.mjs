// Policy for starting another provider-chat segment under one permanent OrdaX Task.
// This is proactive context hygiene, NEVER a workaround for rate limits or provider gates.

const HOSTS = new Set(['chatgpt.com','chat.openai.com']);

// A navigation to home, login, share or another website is not a durable chat.
// Ignore query/hash and trailing slashes: they must not create phantom segments.
export function canonicalProviderChatUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname.toLowerCase()) ||
        url.username || url.password || url.port) return null;
    const sections = url.pathname.split('/').filter(Boolean);
    const index = sections[0] === 'c' ? 0 :
      (sections[0] === 'g' && sections[1] && sections[2] === 'c' ? 2 : -1);
    if (index < 0 || sections.length !== index + 2 ||
      !/^[a-zA-Z0-9_-]+$/.test(sections[index + 1])) return null;
    return url.origin.toLowerCase() + '/' + sections.join('/');
  } catch { return null; }
}
export const SUCCESSFUL_TURNS_PER_SEGMENT = 24;

export function planProviderConversation(task, { forceNew = false } = {}) {
  if (!task) throw new Error('task_not_found');
  const currentUrl = canonicalProviderChatUrl(task.chat_url);
  const active = currentUrl ? (task.conversations || []).find(row =>
    row.status === 'active' && canonicalProviderChatUrl(row.chat_url) === currentUrl
  ) || null : null;
  const firstSegment = !currentUrl;
  const completedTurns = Number(active?.completed_turns || 0);
  const automaticRotation = Boolean(task.chat_url && active &&
    completedTurns >= SUCCESSFUL_TURNS_PER_SEGMENT);
  const newSession = Boolean(forceNew || firstSegment || automaticRotation);
  return {
    newSession,
    automaticRotation,
    reason: forceNew ? 'explicit' : firstSegment ? 'new_or_prepared' :
      automaticRotation ? 'completed_turn_threshold' : 'continue_active',
    completedTurns,
    previousConversationId: active?.id || null
  };
}

export function assessProviderRotation(plan, previousUrl, returnedUrl) {
  if (!plan?.automaticRotation) return 'not_requested';
  const previous=canonicalProviderChatUrl(previousUrl);
  const returned=canonicalProviderChatUrl(returnedUrl);
  if (!returned) return returnedUrl ? 'invalid_url' : 'missing_url';
  return previous && previous === returned ? 'same_url' : 'rotated';
}
