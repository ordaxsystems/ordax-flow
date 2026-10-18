/** OrdaX Flow central relay. No ChatGPT Web automation, no OS imports. */
import { createHash } from 'node:crypto';
const MAX_BODY = 65536;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function reply(response, status, value) {
  response.writeHead(status, { 'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store', 'x-content-type-options':'nosniff' });
  response.end(JSON.stringify(value));
}
async function parseRequest(request) {
  let size=0; const buffers=[];
  for await (const chunk of request) {
    size+=chunk.length;
    if(size>MAX_BODY) throw Object.assign(new Error('request_too_large'),{status:413});
    buffers.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid_json'),{status:400}); }
}
function valid(body) {
  return body && typeof body==='object' && !Array.isArray(body) &&
    Object.keys(body).every(key=>['taskId','requestId','text'].includes(key)) &&
    typeof body.taskId==='string' && IDENTIFIER.test(body.taskId) &&
    typeof body.requestId==='string' && IDENTIFIER.test(body.requestId) &&
    typeof body.text==='string' && body.text.trim().length>0 && body.text.length<=24000;
}
/**
 * Required ports are authoritative adapters, not second sources of truth:
 * authenticate: OrdaX account identity; authorizeTask: project ownership;
 * dispatch: approved model router; idempotency: durable receipt/transaction.
 * No production defaults: missing adapters fail closed.
 */
export function createFlowRelay({ authenticate, authorizeTask, dispatch, idempotency }) {
  if (![authenticate,authorizeTask,dispatch].every(fn=>typeof fn==='function') ||
      typeof idempotency?.execute!=='function') {
    throw new TypeError('flow_relay_requires_canonical_adapters');
  }
  return async function relay(request,response) {
    const path=new URL(request.url||'/', 'http://localhost').pathname;
    if(request.method==='GET' && path==='/health')
      return reply(response,200,{service:'ordax-flow-relay',status:'ready'});
    if(request.method!=='POST'||path!=='/v1/messages')
      return reply(response,404,{error:'not_found'});
    const auth=/^Bearer ([^\s]{1,4096})$/.exec(String(request.headers.authorization||''));
    if(!auth) return reply(response,401,{error:'unauthorized'});
    let principal;
    try{principal=await authenticate(auth[1]);}catch{return reply(response,401,{error:'unauthorized'});}
    const userId=principal?.userId;
    if(typeof userId!=='string'||!IDENTIFIER.test(userId))
      return reply(response,401,{error:'unauthorized'});
    try{
      const body=await parseRequest(request);
      if(!valid(body)) return reply(response,400,{error:'invalid_message'});
      const {taskId,requestId,text}=body;
      if(await authorizeTask({principal,taskId})!==true)
        return reply(response,404,{error:'task_not_found'});
      // The authenticated principal wins over anything a device claims.
      const key=JSON.stringify([userId,taskId,requestId]);
      const fingerprint=createHash('sha256').update(text,'utf8').digest('hex');
      const result=await idempotency.execute(key,fingerprint,async()=>{
        const answer=await dispatch({principal,taskId,requestId,text});
        if(typeof answer?.text!=='string')throw Error('invalid_provider_response');
        // Never trust provider-echoed tenant, task, session or request IDs.
        return {taskId,requestId,message:{role:'assistant',content:answer.text}};
      });
      return reply(response,200,result);
    }catch(error){
      const status=[400,409,413,429].includes(error?.status)?error.status:502;
      return reply(response,status,{error:status===502?'upstream_unavailable':error.message});
    }
  };
}
