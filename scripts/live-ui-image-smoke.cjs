const http=require('http');
const getJson=url=>new Promise((resolve,reject)=>http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on('error',reject));
(async()=>{
  const targets=await getJson('http://127.0.0.1:9444/json/list');
  const target=targets.find(t=>t.type==='page'&&String(t.url).includes('/desktop/ui.html'));
  if(!target) throw new Error('ordax_ui_target_not_found');
  const ws=new WebSocket(target.webSocketDebuggerUrl); let seq=0; const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text||'eval_failed');return r.result.value;};
  await ev(`document.querySelector('#newTask').click(); true`);
  for(let i=0;i<100;i++){if(await ev(`!document.querySelector('#taskPanel').classList.contains('hidden')`))break;await new Promise(r=>setTimeout(r,50));}
  const prompt='Gere uma imagem simples de um cubo azul sobre fundo branco. Não pesquise imagens; crie uma imagem.';
  const started=Date.now();
  await ev(`(()=>{const p=document.querySelector('#prompt');p.value=${JSON.stringify(prompt)};p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#composer').requestSubmit();return true})()`);
  let firstActivityAt=null, firstPreviewAt=null, completedAt=null, image=null, lastStatus='';
  for(let i=0;i<2400;i++){
    const state=await ev(`(()=>({send:document.querySelector('#send')?.textContent||'',run:document.querySelector('#runStatus')?.textContent||'',live:document.querySelector('.message.live .live-content')?.textContent||'',images:[...document.querySelectorAll('#messages img')].map(img=>({src:img.getAttribute('src')||'',alt:img.alt||'',complete:img.complete,width:img.naturalWidth||0,height:img.naturalHeight||0})),messages:[...document.querySelectorAll('#messages .message')].slice(-3).map(n=>n.innerText)}))()`);
    if(!firstActivityAt && (state.run||state.live)) firstActivityAt=Date.now();
    if(state.run!==lastStatus) lastStatus=state.run;
    const persisted=state.images.find(x=>x.src.startsWith('ordax-asset://'));
    if(persisted&&persisted.complete&&persisted.width>0&&persisted.height>0){image=persisted;if(!firstPreviewAt)firstPreviewAt=Date.now();}
    if(image&&state.send==='Enviar'&&!state.live){completedAt=Date.now();break;}
    await new Promise(r=>setTimeout(r,100));
  }
  const result={target:target.title,first_activity_ms:firstActivityAt?firstActivityAt-started:null,image_visible_ms:firstPreviewAt?firstPreviewAt-started:null,total_ms:completedAt?completedAt-started:null,image,lastStatus,passed:Boolean(image&&image.src.startsWith('ordax-asset://')&&image.width>0&&image.height>0)};
  console.log(JSON.stringify(result,null,2)); ws.close(); process.exit(result.passed?0:2);
})().catch(e=>{console.error(e);process.exit(1)});
