/**
 * Canonical Flow application composition.
 * This is the only composition point for Flow Client + Flow Hub.
 * No default auth, quota, project database, model key or operator grants.
 */
import { createFlowPlatformAuthenticator } from './platform-account.mjs';
import { createFlowBrowserSessionVerifier } from './browser-session.mjs';
import { createFlowRelay } from './relay.mjs';
import { createFlowWebHandler } from './web-apps.mjs';
import { createFlowOAuthHandler } from './oauth-entry.mjs';
import { createFlowPostgresOAuthTransactionStore } from './postgres-oauth-transactions.mjs';

export function createFlowPlatformGateway({
  platformOrigin, platformFetch, platformTimeoutMs=12000, allowLoopbackHttp=false,
  publicOrigin, authenticateBrowserSession, oauth,
  authorizeTask, listProjects, authorizeHub, getHubOverview,
  dispatch, idempotency
}) {
  if (typeof authenticateBrowserSession!=='function' ||
      typeof authorizeTask!=='function' ||
      typeof listProjects!=='function' ||
      typeof authorizeHub!=='function' ||
      typeof getHubOverview!=='function' ||
      typeof dispatch!=='function' ||
      typeof idempotency?.execute!=='function') {
    throw new TypeError('flow_production_ports_unconfigured');
  }
  const authenticate=createFlowPlatformAuthenticator({
    platformOrigin,fetchImpl:platformFetch??globalThis.fetch,timeoutMs:platformTimeoutMs,allowLoopbackHttp
  });
  const browserSession=createFlowBrowserSessionVerifier({
    publicOrigin,verifyAccountSession:authenticateBrowserSession,allowLoopbackHttp
  });
  const web=createFlowWebHandler(createFlowRelay({
    authenticate,authenticateRequest:browserSession,
    authorizeTask,listProjects,authorizeHub,getHubOverview,
    dispatch,idempotency
  }));
  if(oauth!==undefined){
    // Production must use the canonical, durable PostgreSQL query executor;
    // an in-memory OAuth state adapter is permitted only for loopback E2Es.
    if(typeof oauth.postgresQuery!=='function' && !allowLoopbackHttp)
      throw new TypeError('flow_oauth_durable_postgres_required');
    const transactionStore=typeof oauth.postgresQuery==='function'
      ? createFlowPostgresOAuthTransactionStore({query:oauth.postgresQuery})
      : oauth.transactionStore;
    const oauthHandler=createFlowOAuthHandler({
      ...oauth,transactionStore,publicOrigin,allowLoopbackHttp
    });
    return (request,response)=>oauthHandler(request,response,web);
  }
  return async(request,response)=>{
    if(request.method==='GET'&&new URL(request.url||'/',publicOrigin).pathname==='/v1/auth/config'){
      response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
      response.end(JSON.stringify({loginAvailable:false}));
      return;
    }
    return web(request,response);
  };
}
