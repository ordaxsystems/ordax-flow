// Non-mutating UI smoke: temporary DOM element only; no provider send.
const http=require('node:http');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const getJson=url=>new Promise((yes,no)=>http.get(url,res=>{let s='';res.on('data',x=>s+=x);res.on('end',()=>{try{yes(JSON.parse(s))}catch(e){no(e)}})}).on('error',no));
(async()=>{
  let target;
  for(let i=0;i<80;i++){const pages=await getJson('http://127.0.0.1:9444/json/list');target=pages.find(p=>p.type==='page'&&p.title==='OrdaX Gratis'&&p.url.endsWith('/desktop/ui.html'));if(target)break;await delay(100)}
  if(!target)throw Error('gratis_renderer_not_found');
  const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let next=0;
  ws.onmessage=e=>{const ev=JSON.parse(e.data),pair=pending.get(ev.id);if(pair){pending.delete(ev.id);ev.error?pair[1](Error(ev.error.message)):pair[0](ev.result)}};
  await new Promise((yes,no)=>{ws.onopen=yes;ws.onerror=no});
  const evaluate=expr=>new Promise((yes,no)=>{const id=++next;pending.set(id,[value=>value.exceptionDetails?no(Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text)):yes(value.result.value),no]);ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:expr,returnByValue:true,awaitPromise:true}}))});
  try{
    const result=await evaluate(`(()=>{
      const list=document.querySelector('#messageList'),status=document.querySelector('#runStatus');
      if(!list||!status||typeof updateLiveStage!=='function'||typeof updateLiveRun!=='function')throw Error('missing_stage_renderer');
      const previous={value:status.textContent,hidden:status.classList.contains('hidden')};
      const node=document.createElement('article');node.id='live-ordax-test-stage-renderer';node.className='message assistant live';
      const body=document.createElement('div');body.className='live-content';body.textContent='Preparando…';
      node.append(body);list.append(node);
      const event={runId:'ordax-test-stage-renderer',at:2000,runStartedAt:1000};
      const phases=[];let stable=false;
      try{
        for(const stage of ['health','prepare','baseline','submit','await-response','assets']){
          updateLiveStage({...event,stage});phases.push({stage,text:body.textContent});
        }
        updateLiveRun({runId:'ordax-test-stage-renderer',taskId:'test',text:'Resposta de teste (não enviada)',source:'beta',generating:true,submitAttemptAt:1000,at:2000});
        updateLiveStage({...event,stage:'prepare',at:2500});
        stable=body.textContent==='Resposta de teste (não enviada)';
      }finally{
        node.remove();status.textContent=previous.value;status.classList.toggle('hidden',previous.hidden);
      }
      return {phases,stable};
    })()`);
    const expected=['Verificando sessão','Preparando conversa','Preparando observação','Preenchendo e acionando','Aguardando a resposta','Finalizando'];
    if(!result.stable||result.phases.length!==expected.length||result.phases.some((p,i)=>!p.text.startsWith(expected[i])))throw Error('stage_renderer_regression:'+JSON.stringify(result));
    console.log('STAGE_RENDERER_SMOKE_PASS',JSON.stringify({stages:result.phases.map(p=>p.stage),streamRetained:result.stable}));
  }finally{ws.close()}
})().catch(e=>{console.error('STAGE_RENDERER_SMOKE_FAIL',String(e));process.exitCode=1});
