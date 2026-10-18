/* Shared browser transport: same-origin, session-only; no tokens in localStorage. */
export async function callFlow(path,{method='GET',body}={}) {
  const response=await fetch(path,{
    method,
    credentials:'same-origin',
    headers:{'accept':'application/json', ...(body ? {'content-type':'application/json'} : {})},
    ...(body ? {body:JSON.stringify(body)} : {})
  });
  let data;
  try { data=await response.json(); } catch { throw new Error('Resposta inválida da central.'); }
  if (!response.ok) {
    if (response.status===401) throw new Error('Entre com sua conta OrdaX para continuar.');
    if (response.status===403) throw new Error('Sua conta não tem permissão para esta operação.');
    if (response.status===404) throw new Error('Recurso não disponível para esta conta.');
    if (response.status===429) throw new Error('Limite de uso atingido. Consulte sua cota.');
    throw new Error('Falha na central: '+String(data.error||response.status));
  }
  return data;
}
