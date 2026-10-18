// The OrdaX project composer owns the user's task draft. The embedded ChatGPT
// composer is a separate, transient provider surface. Never confuse the two.
export function assertProviderDraftAllowed({ newConversation, draftText }) {
  // A deliberate new conversation can reset the old provider composer.
  // Existing conversations must preserve anything typed there.
  if (!newConversation && String(draftText || '').trim()) {
    throw new Error('chatgpt_draft_present');
  }
}

export async function ensureEmptyNewComposer({ readComposer, clearComposer }) {
  const state = await readComposer();
  if (!state?.found || !state?.formReady) throw new Error('new_chat_composer_unavailable');
  if (String(state.text || '').trim()) await clearComposer();
  const confirmed = await readComposer();
  if (!confirmed?.found || !confirmed?.formReady || String(confirmed.text || '').trim()) {
    throw new Error('new_chat_composer_not_empty');
  }
  return confirmed;
}
