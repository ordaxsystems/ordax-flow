const http=require('http');
const getJson=url=>new Promise((resolve,reject)=>http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on('error',reject));
(async()=>{
  const target=(await getJson('http://127.0.0.1:9444/json/list')).find(t=>t.type==='page'&&String(t.url).includes('/desktop/ui.html'));
  if(!target) throw new Error('ordax_ui_target_not_found');
  const ws=new WebSocket(target.webSocketDebuggerUrl);let seq=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}};
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});return {value:r.result?.value,exception:r.exceptionDetails?.exception?.description||r.exceptionDetails?.text||null}};
  const basic=await ev(`(()=>({ready:document.readyState,url:location.href,title:document.title,ordaxType:typeof window.ordax,ordaxKeys:Object.keys(window.ordax||{}),provider:document.querySelector('#providerText')?.textContent||'',taskCount:document.querySelectorAll('.task').length}))()`);
  const status=await ev(`(async()=>{try{return await window.ordax.providerStatus()}catch(e){return {error:String(e?.stack||e)}}})()`);
  const workspace=await ev(`(async()=>{try{return await window.ordax.workspace()}catch(e){return {error:String(e?.stack||e)}}})()`);
  console.log(JSON.stringify({basic,status,workspace},null,2));
  ws.close();
})().catch(e=>{console.error(e);process.exit(1)});
