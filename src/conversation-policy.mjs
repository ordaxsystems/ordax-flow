// Policy for starting another provider-chat segment under one permanent OrdaX Task.
// This is proactive context hygiene, NEVER a workaround for rate limits or provider gates.
export const SUCCESSFUL_TURNS_PER_SEGMENT = 24;

export function planProviderConversation(task, { forceNew = false } = {}) {
  if (!task) throw new Error('task_not_found');
  const active = (task.conversations || []).find(row =>
    row.status === 'active' && row.chat_url === task.chat_url
  ) || null;
  const firstSegment = !task.chat_url;
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
  const previous=String(previousUrl || '').trim();
  const returned=String(returnedUrl || '').trim();
  if (!returned) return 'missing_url';
  return previous && previous === returned ? 'same_url' : 'rotated';
}
