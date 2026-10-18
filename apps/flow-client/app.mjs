import { callFlow } from '/shared/api.mjs';
const el=id=>document.getElementById(id);
let taskId=null,epoch=0,busy=false,historyEnabled=false,nextBefore=null;
let historyRequest=null;

function state(text,failed=false){
  el('state').textContent=text;
  el('state').classList.toggle('error',failed);
}
function sync(){
  el('prompt').disabled=!taskId||busy;
  el('send').disabled=!taskId||busy;
  el('selected').textContent=taskId?'Projeto autorizado selecionado':'Selecione um projeto.';
}
function bubbleNode(role,content){
  const node=document.createElement('div');
  node.className='bubble '+(role==='user'?'me':'bot');
  node.textContent=content;
  return node;
}
function bubble(role,content){
  const thread=el('thread');
  thread.append(bubbleNode(role,content));
  thread.scrollTop=thread.scrollHeight;
}
function projectButton(project){
  const button=document.createElement('button');
  button.className='project';
  button.type='button';
  button.textContent=project.title;
  button.addEventListener('click',()=>choose(project,button));
  return button;
}
function choose(project,button){
  taskId=project.id;
  epoch++;
  historyRequest=null;
  nextBefore=null;
  el('heading').textContent=project.title;
  for(const other of el('projects').querySelectorAll('button'))
    other.classList.toggle('active',other===button);
  el('thread').replaceChildren();
  el('olderMessages').hidden=true;
  state('Projeto selecionado.');
  sync();
  if(historyEnabled)void loadHistory(null);
}
async function loadHistory(before){
  if(!taskId||!historyEnabled)return;
  const requestedTask=taskId,requestedEpoch=epoch;
  if(historyRequest?.taskId===requestedTask&&historyRequest?.epoch===requestedEpoch)return;
  const token={taskId:requestedTask,epoch:requestedEpoch};
  historyRequest=token;
  const olderButton=el('olderMessages');
  olderButton.disabled=true;
  try{
    const path='/v1/history/'+encodeURIComponent(requestedTask)+
      (before?'?before='+encodeURIComponent(before):'');
    const data=await callFlow(path);
    if(taskId!==requestedTask||epoch!==requestedEpoch)return;
    if(!Array.isArray(data.messages)||
       data.messages.some(m=>!['user','assistant'].includes(m.role)||
         typeof m.content!=='string'||typeof m.id!=='string')||
       !(data.nextBefore===null||typeof data.nextBefore==='string')){
      throw Error('Histórico retornado pela central é inválido.');
    }
    const thread=el('thread');
    const previousHeight=thread.scrollHeight;
    const previousTop=thread.scrollTop;
    const fragment=document.createDocumentFragment();
    for(const message of data.messages)
      fragment.append(bubbleNode(message.role,message.content));
    if(before){
      thread.prepend(fragment);
      thread.scrollTop=previousTop+(thread.scrollHeight-previousHeight);
    }else{
      thread.replaceChildren(fragment);
      thread.scrollTop=thread.scrollHeight;
    }
    nextBefore=data.nextBefore;
    olderButton.hidden=!nextBefore;
    state('Histórico recuperado da central para este projeto.');
  }catch(error){
    if(taskId===requestedTask&&epoch===requestedEpoch)state(error.message,true);
  }finally{
    if(historyRequest===token)historyRequest=null;
    if(taskId===requestedTask&&epoch===requestedEpoch)olderButton.disabled=false;
  }
}
async function initialize(){
  try{
    const session=await callFlow('/v1/session');
    if(session.authenticated!==true){
      state('A Conta OrdaX não está autenticada neste navegador.',true);
      el('projects').textContent='Entre na Conta OrdaX pelo portal oficial.';
      try{
        const auth=await callFlow('/v1/auth/config');
        if(auth.loginAvailable===true)el('login').hidden=false;
      }catch{/* Nenhum login fictício. */}
      return;
    }
    historyEnabled=session.features?.history===true;
    el('newConversation').hidden=session.features?.conversations!==true;
    const data=await callFlow('/v1/projects');
    const projects=Array.isArray(data.projects)?data.projects:[];
    el('projects').replaceChildren();
    if(!projects.length){state('Nenhum projeto autorizado disponível.');return;}
    for(const project of projects)el('projects').append(projectButton(project));
    el('projects').querySelector('button').click();
  }catch(error){
    state(error.message,true);
    el('projects').textContent='Sessão OrdaX necessária.';
  }
}
el('newConversation').addEventListener('submit',async event=>{
  event.preventDefault();
  const field=el('conversationTitle'),title=field.value.trim();
  if(!title)return;
  const submit=el('newConversation').querySelector('button');
  submit.disabled=true;
  try{
    const result=await callFlow('/v1/conversations',{method:'POST',body:{title}});
    if(typeof result.conversation?.id!=='string'||result.conversation.title!==title)
      throw Error('Criação não confirmada pela central.');
    const button=projectButton(result.conversation);
    el('projects').prepend(button);
    field.value='';
    button.click();
  }catch(error){state(error.message,true);}
  finally{submit.disabled=false;}
});
el('olderMessages').addEventListener('click',()=>{
  if(nextBefore)void loadHistory(nextBefore);
});
el('thread').addEventListener('scroll',()=>{
  const thread=el('thread');
  if(thread.scrollTop<=25&&nextBefore&&!historyRequest)
    void loadHistory(nextBefore);
});
el('composer').addEventListener('submit',async event=>{
  event.preventDefault();
  if(busy||!taskId)return;
  const text=el('prompt').value.trim();
  if(!text)return;
  const requestedTask=taskId,requestedEpoch=epoch,requestId=crypto.randomUUID();
  busy=true;
  sync();
  state('Aguardando resposta da central…');
  try{
    const result=await callFlow('/v1/messages',{
      method:'POST',body:{taskId:requestedTask,requestId,text}
    });
    if(result.taskId!==requestedTask||result.requestId!==requestId||
       typeof result.message?.content!=='string')
      throw Error('Resposta não corresponde à solicitação. Nada foi exibido.');
    if(taskId===requestedTask&&epoch===requestedEpoch){
      bubble('user',text);
      bubble('assistant',result.message.content);
      el('prompt').value='';
      state('Resposta registrada no projeto correto.');
    }
  }catch(error){
    if(taskId===requestedTask&&epoch===requestedEpoch)state(error.message,true);
  }finally{busy=false;sync();}
});
initialize();
