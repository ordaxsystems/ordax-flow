import { callFlow } from '/shared/api.mjs';
const names=['activeUsers','activeDevices','totalProjects','completedRequests','failedRequests','pendingRequests'];
const state=document.getElementById('state'),refresh=document.getElementById('refresh');
async function load(){
  refresh.disabled=true;state.textContent='Carregando indicadores autorizados…';state.classList.remove('error');
  for(const name of names)document.getElementById(name).textContent='—';
  try{
    const result=await callFlow('/v1/hub/overview');
    if(!result.stats||names.some(name=>!Number.isSafeInteger(result.stats[name])))
      throw Error('Indicadores inválidos.');
    for(const name of names)document.getElementById(name).textContent=
      result.stats[name].toLocaleString('pt-BR');
    state.textContent='Indicadores agregados carregados.';
  }catch(error){state.textContent=error.message;state.classList.add('error');}
  finally{refresh.disabled=false;}
}
refresh.addEventListener('click',load);
load();