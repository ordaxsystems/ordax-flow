const http=require('http');
const getJson=url=>new Promise((resolve,reject)=>http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}})}).on('error',reject));
(async()=>{
  const targets=(await getJson('http://127.0.0.1:9444/json/list')).filter(t=>t.type==='page'&&/^https:\/\/chatgpt\.com\//i.test(String(t.url)));
  for(const target of targets){
    const ws=new WebSocket(target.webSocketDebuggerUrl);let seq=0;const pending=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}};
    await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
    const expression=`(()=>{const sels=['#prompt-textarea','#mobile-composer-prompt','textarea[placeholder="Pergunte ao ChatGPT"]','textarea[aria-label*="ChatGPT"]','[contenteditable="true"][data-composer-markdown]','[contenteditable="true"][data-lexical-editor="true"]','[contenteditable="true"][role="textbox"]'];const all=sels.flatMap(s=>[...document.querySelectorAll(s)]);const read=e=>({tag:e.tagName,id:e.id||'',role:e.getAttribute('role')||'',contenteditable:e.getAttribute('contenteditable'),form:Boolean(e.closest('form')),disabled:Boolean(e.disabled),ariaDisabled:e.getAttribute('aria-disabled'),display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,rect:(()=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})(),text:'value'in e?e.value:(e.innerText||e.textContent||'')});return{url:location.href,active:document.activeElement?read(document.activeElement):null,composers:all.map(read),forms:document.querySelectorAll('form').length}})()`;
    const r=await call('Runtime.evaluate',{expression,returnByValue:true});
    console.log(JSON.stringify({target:{title:target.title,url:target.url,id:target.id},state:r.result?.value},null,2));
    ws.close();
  }
})().catch(e=>{console.error(e);process.exit(1)});
