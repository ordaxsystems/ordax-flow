const { acquireE2ELock } = require('./e2e-lock.cjs');
acquireE2ELock('text-smoke');
const http=require('http');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function getJson(url){return new Promise((resolve,reject)=>http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on('error',reject));}
(async()=>{
  const mode=String(process.env.ORDAX_E2E_MODE||'auto').toLowerCase();
  if(!['auto','fast','beta'].includes(mode)) throw new Error('invalid_e2e_mode');
  const defaultMarker={auto:'ORDAX_UI_STREAM_OK',fast:'ORDAX_UI_FAST_OK',beta:'ORDAX_UI_BETA_OK'}[mode];
  const marker=String(process.env.ORDAX_E2E_MARKER||defaultMarker);
  const prompt=String(process.env.ORDAX_E2E_PROMPT||('Responda exatamente: '+marker));
  const requireStream=process.env.ORDAX_REQUIRE_STREAM==='1';
  const requireFastDelivery=process.env.ORDAX_REQUIRE_FAST==='1';
  const discoverStarted=Date.now(); let target=null;
  for(let i=0;i<120;i++){const targets=await getJson('http://127.0.0.1:9444/json/list');target=targets.find(t=>t.type==='page'&&t.title==='OrdaX Gratis'&&String(t.url).endsWith('/desktop/ui.html'));if(target)break;await sleep(100);}
  if(!target) throw new Error('ordax_ui_target_not_found');
  const ws=new WebSocket(target.webSocketDebuggerUrl); let seq=0; const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const {resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result);}};
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evalJs=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails){const d=r.exceptionDetails;throw new Error([d.text,d.exception?.description,d.exception?.value].filter(Boolean).join(' | ')||'eval_failed');}return r.result.value;};
  let uiReady=false;for(let i=0;i<200;i++){uiReady=await evalJs(`document.readyState==='complete'&&Boolean(document.querySelector('#newTask'))&&Boolean(document.querySelector('#prompt'))&&Boolean(document.querySelector('#observerMode'))`);if(uiReady)break;await sleep(50);}if(!uiReady)throw new Error('ordax_ui_not_ready');
  const providerWaitStarted=Date.now(); let providerReady=false;
  for(let i=0;i<600;i++){providerReady=await evalJs(`(async()=>{const s=await window.ordax.providerStatus();return Boolean(s?.connected&&s?.composer_ready&&!s?.verification_required)})()`);if(providerReady)break;await sleep(50);}if(!providerReady)throw new Error('provider_not_ready');
  const provider_ready_wait_ms=Date.now()-providerWaitStarted;
  await evalJs(`(()=>{const s=document.querySelector('#observerMode');if(s.value!==${JSON.stringify(mode)}){s.value=${JSON.stringify(mode)};s.dispatchEvent(new Event('change',{bubbles:true}));}return true})()`);
  for(let i=0;i<100;i++){if(await evalJs(`document.querySelector('#observerMode').value===${JSON.stringify(mode)}&&!document.querySelector('#observerMode').disabled`))break;await sleep(30);}
  const initial=await evalJs(`(()=>({observerMode:document.querySelector('#observerMode').value,directMode:document.querySelector('#directMode').textContent,provider:document.querySelector('#providerText').textContent,hint:document.querySelector('#observerHint').textContent}))()`);
  await evalJs(`document.querySelector('#newTask').click(); true`);for(let i=0;i<200;i++){if(await evalJs(`!document.querySelector('#taskPanel').classList.contains('hidden')`))break;await sleep(50);}
  const started=Date.now();
  await evalJs(`(()=>{const p=document.querySelector('#prompt');p.value=${JSON.stringify(prompt)};p.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#composer').requestSubmit();return true})()`);
  let firstVisibleAt=null,firstVisibleText='',firstVisibleSource='',finalAt=null,finalText='',sawLive=false,sawFast=false,sawBeta=false,lastMeaningfulLive='',liveRegressed=false;const samples=[],statuses=[];
  for(let i=0;i<1200;i++){const state=await evalJs(`(()=>({runStatus:document.querySelector('#runStatus')?.textContent||'',send:document.querySelector('#send')?.textContent||'',live:document.querySelector('.message.live .live-content')?.textContent||'',messages:[...document.querySelectorAll('#messages .message')].map(n=>n.innerText)}))()`);if(state.runStatus.includes('Fast'))sawFast=true;if(state.runStatus.includes('Beta'))sawBeta=true;if(statuses.length<20&&state.runStatus&&statuses.at(-1)!==state.runStatus)statuses.push(state.runStatus);const meaningfulLive=state.live&&!/^(?:Preparando|Processando)/i.test(state.live.trim());if(meaningfulLive){sawLive=true;if(lastMeaningfulLive&&state.live.length<lastMeaningfulLive.length)liveRegressed=true;lastMeaningfulLive=state.live;if(!firstVisibleAt){firstVisibleAt=Date.now();firstVisibleText=state.live;firstVisibleSource='stream';}}if(samples.length<16&&state.live&&samples.at(-1)!==state.live)samples.push(state.live);const assistant=state.messages.filter(x=>/chatgpt/i.test(x)).at(-1)||'';if(assistant.includes(marker)&&!firstVisibleAt){firstVisibleAt=Date.now();firstVisibleText=assistant;firstVisibleSource='final';}if(assistant.includes(marker)&&state.send==='Enviar'&&!state.live){finalAt=Date.now();finalText=assistant;break;}await sleep(50);}
  const finalUi=await evalJs(`(()=>({observerMode:document.querySelector('#observerMode').value,directMode:document.querySelector('#directMode').textContent,provider:document.querySelector('#providerText').textContent,hint:document.querySelector('#observerHint').textContent,runStatusHidden:document.querySelector('#runStatus').classList.contains('hidden')}))()`);
  const providerStatus=await evalJs('window.ordax.providerStatus()');
  const fastOperational=mode!=='fast'||Boolean(sawFast||providerStatus?.fast_stream_capable);
  const modeEvidence=mode==='fast'?(fastOperational&&(!requireFastDelivery||sawFast)):mode==='beta'?!sawFast:true;
  const streamEvidence=!requireStream||sawLive;
  const crossRunLeak=/ORDAX_UI_(?:FAST|BETA|STREAM)_OK/.test(firstVisibleText)&&!firstVisibleText.includes(marker);
  const result={mode,marker,target:target.title,url:target.url,discover_ms:Date.now()-discoverStarted,provider_ready_wait_ms,uiReady,initial,prompt,requireStream,requireFastDelivery,sawLive,sawFast,sawBeta,fastOperational,monotonic:!liveRegressed,liveRegressed,crossRunLeak,firstVisibleSource,firstVisibleText,ttfv_ms:firstVisibleAt?firstVisibleAt-started:null,total_ms:finalAt?finalAt-started:null,finalText,samples,statuses,finalUi,providerStatus,passed:Boolean(uiReady&&streamEvidence&&modeEvidence&&!liveRegressed&&!crossRunLeak&&finalText.includes(marker)&&finalUi.runStatusHidden)};
  console.log(JSON.stringify(result,null,2));ws.close();process.exit(result.passed?0:2);
})().catch(e=>{console.error(e);process.exit(1)});
