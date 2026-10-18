import { callFlow } from '/shared/api.mjs';
const el=id=>document.getElementById(id);
let taskId=null,epoch=0,busy=false;
function state(text,failed=false){el('state').textContent=text;el('state').classList.toggle('error',failed);}
function sync(){el('prompt').disabled=!taskId||busy;el('send').disabled=!taskId||busy;el('selected').textContent=taskId?'Projeto autorizado selecionado':'Selecione um projeto.';}
function bubble(role,content){const p=document.createElement('div');p.className='bubble '+(role==='user'?'me':'bot');p.textContent=content;el('thread').append(p);el('thread').scrollTop=el('thread').scrollHeight;}
function choose(project,button){
  taskId=project.id;epoch++;el('heading').textContent=project.title;
  for(const other of el('projects').querySelectorAll('button'))other.classList.toggle('active',other===button);
  el('thread').replaceChildren();state('Projeto selecionado.');sync();
}
async function initialize(){
  try {
    const session=await callFlow('/v1/session');
    if(session.authenticated!==true){
      state('A Conta OrdaX não está autenticada neste navegador. A entrada única depende da sessão oficial da plataforma.',true);
      el('projects').textContent='Entre na Conta OrdaX pelo portal oficial.';
      return;
    }
    const data=await callFlow('/v1/projects');
    const projects=Array.isArray(data.projects)?data.projects:[];
    el('projects').replaceChildren();
    if(!projects.length){state('Nenhum projeto autorizado disponível.');return;}
    for(const project of projects){
      const button=document.createElement('button');button.className='project';button.type='button';
      button.textContent=project.title;button.addEventListener('click',()=>choose(project,button));
      el('projects').append(button);
    }
    el('projects').querySelector('button').click();
  }catch(error){state(error.message,true);el('projects').textContent='Sessão OrdaX necessária.';}
}
el('composer').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!taskId)return;
  const text=el('prompt').value.trim();if(!text)return;
  const requestedTask=taskId,requestedEpoch=epoch,requestId=crypto.randomUUID();
  busy=true;sync();state('Aguardando resposta da central…');
  try{
    const result=await callFlow('/v1/messages',{method:'POST',body:{taskId:requestedTask,requestId,text}});
    if(result.taskId!==requestedTask||result.requestId!==requestId||typeof result.message?.content!=='string')
      throw Error('Resposta não corresponde à solicitação. Nada foi exibido.');
    if(taskId===requestedTask&&epoch===requestedEpoch){
      bubble('user',text);bubble('assistant',result.message.content);
      el('prompt').value='';state('Resposta associada ao projeto correto.');
    }
  }catch(error){if(taskId===requestedTask&&epoch===requestedEpoch)state(error.message,true);}
  finally{busy=false;sync();}
});
initialize();