/* Keyboard-only E2E on OrdaX UI. It never submits text to ChatGPT. */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { acquireE2ELock } from './e2e-lock.cjs';
acquireE2ELock('typing-smoke');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const getJson=url=>new Promise((resolve,reject)=>http.get(url,res=>{
  let s='';res.on('data',c=>s+=c);res.on('end',()=>{try{resolve(JSON.parse(s));}catch(e){reject(e);}});
}).on('error',reject));
const until=async(fn,label)=>{for(let i=0;i<120;i++){const v=await fn();if(v)return v;await sleep(100);}throw Error('timeout:'+label);};
const target=(await getJson('http://127.0.0.1:9444/json/list'))
  .find(t=>t.type==='page'&&String(t.url).endsWith('/desktop/ui.html'));
if(!target)throw Error('ordax_ui_target_not_found');
const ws=new WebSocket(target.webSocketDebuggerUrl);let seq=0;const pending=new Map();
ws.onmessage=event=>{const msg=JSON.parse(event.data);const p=pending.get(msg.id);
if(p){pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);}};
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
});
const evalJs=async expression=>{
  const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.text||'eval_failed');
  return result.result.value;
};
let db;const fixtureIds=[];
const previousId=await evalJs("document.querySelector('#taskId')?.textContent||''");
const current=()=>evalJs("document.querySelector('#taskId')?.textContent||''");
async function create(){
  const before=await current();
  await evalJs("document.querySelector('#newTask').click();true");
  const id=await until(async()=>{const next=await current();return next&&next!==before?next:null;},'new-task');
  fixtureIds.push(id);return id;
}
async function type(value){
  await evalJs("document.querySelector('#prompt').focus();true");
  for(const char of value) {
    // Chromium key event, not a DOM value assignment or bot-disguise.
    await call('Input.dispatchKeyEvent',{type:'char',text:char,unmodifiedText:char});
  }
}
const draft=()=>evalJs("document.querySelector('#prompt')?.value||''");
const persisted=id=>db.prepare('SELECT draft FROM tasks WHERE id=?').get(id)?.draft||'';
const select=id=>evalJs('document.querySelector(\'.task[data-id="'+id+'"]\')?.click();true');
try {
  db=new DatabaseSync(path.join(process.env.LOCALAPPDATA,'OrdaX','Gratis','data','ordax-gratis.sqlite'));
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  const a=await create(),valueA='Teste OrdaX cliente A: rascunho unico 123.';
  await type(valueA);
  if(await draft()!==valueA)throw Error('typed_value_a_mismatch');
  await until(()=>persisted(a)===valueA,'persist_a');
  const b=await create(),valueB='Teste OrdaX cliente B: rascunho distinto 456.';
  await type(valueB);
  if(await draft()!==valueB)throw Error('typed_value_b_mismatch');
  await until(()=>persisted(b)===valueB,'persist_b');
  await select(a);await until(async()=>await current()===a,'select_a');
  await until(async()=>await draft()===valueA,'restore_a');
  await select(b);await until(async()=>await current()===b,'select_b');
  await until(async()=>await draft()===valueB,'restore_b');
  console.log(JSON.stringify({passed:true,typedVia:'Chromium Input.dispatchKeyEvent',
    independentDrafts:true,projects:2,persistedToSQLite:true,providerMessagesSent:0},null,2));
} finally {
  try{
    if(previousId&&!fixtureIds.includes(previousId))await select(previousId);
    else await evalJs('document.querySelector("#newTask").click();true');
    await until(async()=>!fixtureIds.includes(await current()),'fixture_unselected');
    db?.exec('BEGIN IMMEDIATE;');
    try{
      for(const id of fixtureIds){
        db.prepare('DELETE FROM events WHERE task_id=?').run(id);
        db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      }
      db.exec('COMMIT;');
    }catch(e){db.exec('ROLLBACK;');throw e;}
    await evalJs('location.reload();true');
  }catch(e){console.error('fixture_cleanup_failed',String(e));}
  db?.close();ws.close();
}
