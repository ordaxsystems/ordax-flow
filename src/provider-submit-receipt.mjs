// Browser-agnostic contract for observing an official provider UI.
// A cleared composer alone is never evidence that the message was sent.
const normalized = value => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const chatPermalink = url => {
  try { return /^\/c\/[a-z0-9-]{8,}\/?$/i.test(new URL(url).pathname); }
  catch { return false; }
};

export function providerSubmissionConfirmed({ baseline, current, prompt }) {
  if (!current || normalized(current.composerText)) return false;
  const userBubble = Number(current.userCount || 0) > Number(baseline.userCount || 0)
    && normalized(current.latestUserText) === normalized(prompt);
  const canonicalNewUrl = current.url !== baseline.url && chatPermalink(current.url);
  return userBubble || canonicalNewUrl;
}

export function unresolvedSubmitCode(state) {
  return normalized(state?.composerText) ? 'send_not_observed' : 'send_confirmation_unknown';
}

export async function submitExactlyOnce({ fire, readState, wait, baseline, prompt, maxChecks = 80 }) {
  if (typeof fire !== 'function' || typeof readState !== 'function' || typeof wait !== 'function') {
    throw new TypeError('submission_dependencies_required');
  }
  if (!baseline || !normalized(prompt) || !Number.isInteger(maxChecks) || maxChecks < 1) {
    throw new TypeError('invalid_submission_parameters');
  }
  // One and only one submit interaction. Do not attempt alternative click,
  // form, mouse or Enter submissions after firing.
  await fire();
  let latest = null;
  for (let i = 0; i < maxChecks; i++) {
    await wait();
    latest = await readState();
    if (providerSubmissionConfirmed({baseline,current:latest,prompt})) return latest;
  }
  throw new Error(unresolvedSubmitCode(latest));
}

export async function waitForSubmitControl({ read, wait, maxChecks = 40 }) {
  if (typeof read !== 'function' || typeof wait !== 'function' || !Number.isInteger(maxChecks) || maxChecks < 1) {
    throw new TypeError('invalid_submit_control_dependencies');
  }
  for (let i = 0; i < maxChecks; i++) {
    const control = await read();
    if (control?.button && Number.isFinite(control.x) && Number.isFinite(control.y)) return control;
    await wait();
  }
  // If React has not committed an enabled visible submit control after the
  // input is recognized, no attempt was made. Do not fire a speculative Enter.
  throw new Error('send_control_unavailable');
}
