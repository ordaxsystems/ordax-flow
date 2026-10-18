// Pure UI adapter for provider stages; no access to tasks, IPC or persistence.
export const RUN_STAGE_TEXT = Object.freeze({
  health:'Verificando sessão do ChatGPT…',
  prepare:'Preparando conversa do provedor…',
  baseline:'Preparando observação de resposta…',
  submit:'Preenchendo e acionando o envio…',
  'await-response':'Aguardando a resposta do ChatGPT…',
  assets:'Finalizando e verificando os resultados…'
});

export function renderLiveStage(payload, { getNode, statusElement }) {
  const node = getNode?.(`live-${payload.runId}`);
  if (!node || node.dataset.streamStarted === 'true') return false;
  const content = node.querySelector('.live-content');
  const label = RUN_STAGE_TEXT[payload.stage];
  if (!label) return false;
  content.textContent = label;
  const elapsed = payload.runStartedAt ? Math.max(0, Math.round((payload.at - payload.runStartedAt) / 1000)) : 0;
  statusElement.textContent = `${label} • ${elapsed}s desde o início`;
  statusElement.classList.remove('hidden');
  return true;
}

