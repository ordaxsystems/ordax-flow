/**
 * Canonical Flow application composition.
 * This is the only composition point for Flow Client + Flow Hub.
 * No default auth, quota, project database, model key or operator grants.
 */
import { createFlowPlatformAuthenticator } from './platform-account.mjs';
import { createFlowBrowserSessionVerifier } from './browser-session.mjs';
import { createFlowRelay } from './relay.mjs';
import { createFlowWebHandler } from './web-apps.mjs';

export function createFlowPlatformGateway({
  platformOrigin, platformFetch, platformTimeoutMs=12000, allowLoopbackHttp=false,
  publicOrigin, authenticateBrowserSession,
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
  return createFlowWebHandler(createFlowRelay({
    authenticate,authenticateRequest:browserSession,
    authorizeTask,listProjects,authorizeHub,getHubOverview,
    dispatch,idempotency
  }));
}
