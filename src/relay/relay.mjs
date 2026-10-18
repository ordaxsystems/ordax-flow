/** OrdaX Flow — shared authenticated gateway; Flow Client and Flow Hub stay separate. */
import { createHash } from 'node:crypto';

const MAX_BODY = 64 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HUB_CAPABILITY = 'flow:hub:read';

function reply(response, status, value) {
  response.writeHead(status, {
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff'
  });
  response.end(JSON.stringify(value));
}

async function parseRequest(request) {
  let size=0;
  const buffers=[];
  for await (const chunk of request) {
    size+=chunk.length;
    if (size>MAX_BODY) throw Object.assign(new Error('request_too_large'),{status:413});
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

function projectProjection(projects) {
  if (!Array.isArray(projects)) throw new TypeError('invalid_projects_projection');
  return projects.slice(0,100).map(project=>{
    if (!project || typeof project.id!=='string' || !IDENTIFIER.test(project.id) ||
        typeof project.title!=='string') throw new TypeError('invalid_project');
    return {id:project.id,title:project.title.slice(0,160)};
  });
}

function hubProjection(overview) {
  // Deliberately no email, prompt, response, token, user list or tenant secret.
  const names=['activeUsers','activeDevices','totalProjects','completedRequests',
    'failedRequests','pendingRequests'];
  if (!overview || typeof overview!=='object') throw new TypeError('invalid_hub_projection');
  const stats={};
  for (const name of names) {
    const value=overview[name];
    if (!Number.isSafeInteger(value) || value<0) throw new TypeError('invalid_hub_metric');
    stats[name]=value;
  }
  return {stats};
}

/**
 * Identity, ownership, quota/model routing, durable idempotency and observability
 * are external authoritative adapters. No production adapter defaults.
 * authenticateRequest, when enabled, MUST verify a secure HttpOnly OrdaX session
 * and same-origin + CSRF for mutations (passed method/path/request).
 */
export function createFlowRelay({
  authenticate, authenticateRequest, authorizeTask, dispatch, idempotency,
  listProjects, authorizeHub, getHubOverview,
  createConversation, getHistory, recordTurn
}) {
  if (![authenticate,authorizeTask,dispatch].every(fn=>typeof fn==='function') ||
      typeof idempotency?.execute!=='function') {
    throw new TypeError('flow_relay_requires_canonical_adapters');
  }
  if (authenticateRequest!==undefined && typeof authenticateRequest!=='function')
    throw new TypeError('invalid_session_adapter');
  if (listProjects!==undefined && typeof listProjects!=='function')
    throw new TypeError('invalid_projects_adapter');
  if ([createConversation,getHistory,recordTurn].some(fn=>fn!==undefined&&typeof fn!=='function'))
    throw new TypeError('invalid_conversation_adapter');
  if (Boolean(authorizeHub)!==Boolean(getHubOverview) ||
      (authorizeHub!==undefined && typeof authorizeHub!=='function') ||
      (getHubOverview!==undefined && typeof getHubOverview!=='function'))
    throw new TypeError('flow_hub_requires_explicit_rbac_and_projection_adapters');

  return async function relay(request,response) {
    const pathname=new URL(request.url||'/', 'http://localhost').pathname;
    if(request.method==='GET' && pathname==='/health')
      return reply(response,200,{service:'ordax-flow-relay',status:'ready'});

    const sessionRoute=request.method==='GET' && pathname==='/v1/session';
    const hubSessionRoute=request.method==='GET' && pathname==='/v1/hub/session' &&
      typeof authorizeHub==='function';
    const messageRoute=request.method==='POST' && pathname==='/v1/messages';
    const createRoute=request.method==='POST' && pathname==='/v1/conversations' &&
      typeof createConversation==='function';
    const historyMatch=request.method==='GET'&&typeof getHistory==='function'
      ? /^\/v1\/history\/([A-Za-z0-9_.:-]{1,128})$/.exec(pathname) : null;
    const projectRoute=request.method==='GET' && pathname==='/v1/projects' &&
      typeof listProjects==='function';
    const hubRoute=request.method==='GET' && pathname==='/v1/hub/overview' &&
      typeof authorizeHub==='function';
    if (!sessionRoute && !hubSessionRoute && !messageRoute && !createRoute &&
        !historyMatch && !projectRoute && !hubRoute)
      return reply(response,404,{error:'not_found'});

    const header=String(request.headers.authorization||'');
    const bearer=/^Bearer ([^\s]{1,4096})$/.exec(header);
    let principal;
    try {
      if (header) {
        if (!bearer) return reply(response,401,{error:'unauthorized'});
        principal=await authenticate(bearer[1]);
      } else if (authenticateRequest) {
        principal=await authenticateRequest({request,method:request.method,path:pathname});
      }
    } catch { return reply(response,401,{error:'unauthorized'}); }

    const userId=principal?.userId;
    if(typeof userId!=='string'||!IDENTIFIER.test(userId)) {
      if(sessionRoute)return reply(response,200,{authenticated:false});
      return reply(response,401,{error:'unauthorized'});
    }

    try {
      if(sessionRoute)return reply(response,200,{
        authenticated:true,
        ...(createConversation&&getHistory?{features:{conversations:true,history:true}}:{})
      });
      if(hubSessionRoute){
        const allowed=await authorizeHub({principal,capability:HUB_CAPABILITY});
        if(allowed!==true)return reply(response,403,{error:'forbidden'});
        return reply(response,200,{authenticated:true,operator:true});
      }
      if (hubRoute) {
        const granted=await authorizeHub({principal,capability:HUB_CAPABILITY});
        if (granted!==true) return reply(response,403,{error:'forbidden'});
        return reply(response,200,hubProjection(await getHubOverview({principal})));
      }
      if (projectRoute)
        return reply(response,200,{projects:projectProjection(await listProjects({principal,limit:100}))});
      if(createRoute){
        const body=await parseRequest(request);
        if(!body||typeof body!=='object'||Array.isArray(body)||
           Object.keys(body).some(k=>k!=='title')||typeof body.title!=='string'||
           !body.title.trim()||body.title.trim().length>160)
          return reply(response,400,{error:'invalid_title'});
        return reply(response,201,{conversation:await createConversation({principal,title:body.title})});
      }
      if(historyMatch){
        const taskId=historyMatch[1];
        if(await authorizeTask({principal,taskId})!==true)
          return reply(response,404,{error:'task_not_found'});
        const url=new URL(request.url||'/', 'http://localhost');
        if([...url.searchParams.keys()].some(k=>k!=='before')||
           url.searchParams.getAll('before').length>1)
          return reply(response,400,{error:'invalid_cursor'});
        const before=url.searchParams.get('before');
        if(before!==null && !/^[1-9][0-9]{0,18}$/.test(before))
          return reply(response,400,{error:'invalid_cursor'});
        return reply(response,200,await getHistory({principal,taskId,before,limit:50}));
      }

      const body=await parseRequest(request);
      if(!valid(body)) return reply(response,400,{error:'invalid_message'});
      const {taskId,requestId,text}=body;
      if(await authorizeTask({principal,taskId})!==true)
        return reply(response,404,{error:'task_not_found'});

      // Receipt identity is bound to the verified principal, never body/device/provider.
      const key=JSON.stringify([userId,taskId,requestId]);
      const fingerprint=createHash('sha256').update(text,'utf8').digest('hex');
      const result=await idempotency.execute(key,fingerprint,async()=>{
        const answer=await dispatch({principal,taskId,requestId,text});
        if(typeof answer?.text!=='string')throw Error('invalid_provider_response');
        if(recordTurn)await recordTurn({principal,taskId,requestId,userText:text,assistantText:answer.text});
        return {taskId,requestId,message:{role:'assistant',content:answer.text}};
      });
      return reply(response,200,result);
    } catch(error) {
      const status=[400,409,413,429].includes(error?.status)?error.status:502;
      return reply(response,status,{error:status===502?'upstream_unavailable':error.message});
    }
  };
}
