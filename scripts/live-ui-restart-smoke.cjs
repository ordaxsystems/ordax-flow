const { acquireE2ELock } = require('./e2e-lock.cjs');
acquireE2ELock('restart-smoke');
const http=require('http');
const path=require('path');
const {DatabaseSync}=require('node:sqlite');
const get=u=>new Promise((r,j)=>http.get(u,x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>r(JSON.parse(d)))}).on('error',j));
(async()=>{
  const dbPath=path.join(process.env.LOCALAPPDATA,'OrdaX','Gratis','data','ordax-gratis.sqlite');
  const db=new DatabaseSync(dbPath,{readOnly:true});
  const latest=db.prepare(`SELECT a.task_id,a.id AS asset_id,a.width,a.height,m.content FROM message_assets a JOIN messages m ON m.id=a.message_id ORDER BY a.created_at DESC LIMIT 1`).get();
  db.close();
  if(!latest)throw new Error('persisted_asset_not_found');
  const expectedAssetUrl=`ordax-asset://local/${latest.asset_id}`;
  const target=(await get('http://127.0.0.1:9444/json/list')).find(x=>x.type==='page'&&String(x.url).endsWith('/desktop/ui.html'));
  if(!target)throw new Error('ordax_ui_target_not_found');
  const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});let id=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const q=pending.get(m.id);pending.delete(m.id);m.error?q.reject(new Error(m.error.message)):q.resolve(m.result)}};
  const call=(method,params)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
  for(let i=0;i<160;i++){if(await ev(`document.querySelectorAll('.task').length>0`))break;await new Promise(r=>setTimeout(r,50));}
  const started=Date.now();
  const clicked=await ev(`(()=>{const target=document.querySelector('.task[data-id=${JSON.stringify(latest.task_id)}]');if(!target)return null;target.click();return target.dataset.id})()`);
  if(clicked!==latest.task_id)throw new Error('persisted_task_button_not_found');
  let image=null,text='';
  for(let i=0;i<240;i++){
    const s=await ev(`(()=>({text:[...document.querySelectorAll('#messages .message')].slice(-3).map(n=>n.innerText).join(' | '),images:[...document.querySelectorAll('#messages img')].map(i=>({src:i.getAttribute('src')||'',w:i.naturalWidth||0,h:i.naturalHeight||0,complete:i.complete,alt:i.alt||''}))}))()`);
    text=s.text;
    image=s.images.find(x=>x.src===expectedAssetUrl&&x.complete&&x.w>0&&x.h>0)||null;
    if(image)break;
    await new Promise(r=>setTimeout(r,50));
  }
  const result={taskId:clicked,assetId:latest.asset_id,reopen_render_ms:Date.now()-started,image,text,expected:{width:latest.width,height:latest.height},passed:Boolean(image&&image.w===latest.width&&image.h===latest.height)};
  console.log(JSON.stringify(result,null,2));ws.close();process.exit(result.passed?0:2);
})().catch(e=>{console.error(e);process.exit(1)});
