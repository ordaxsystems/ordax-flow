/** Account SSO boundary — no Flow usernames, passwords, tokens or shadow sessions.
 * The OrdaX Platform owns the session and verifies it on every request.
 * Only a trusted server-side adapter can return the verified session projection.
 */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalOrigin(value, allowLoopbackHttp) {
  let url;
  try { url=new URL(value); } catch { throw new TypeError('flow_public_origin_invalid'); }
  const loopback=allowLoopbackHttp===true && url.protocol==='http:' &&
    ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!loopback)throw new TypeError('flow_public_https_required');
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw new TypeError('flow_public_origin_only');
  return url.origin;
}

/**
 * verifyAccountSession({request}) must inspect only the Platform-owned
 * HttpOnly session via an authenticated backend, not browser-supplied claims.
 * No client-side OAuth exchange, duplicated login database or JWT parser.
 */
export function createFlowBrowserSessionVerifier({
  publicOrigin, verifyAccountSession, allowLoopbackHttp=false, now=()=>Date.now()
}) {
  const origin=canonicalOrigin(publicOrigin,allowLoopbackHttp);
  if(typeof verifyAccountSession!=='function'||typeof now!=='function')
    throw new TypeError('flow_canonical_session_port_required');

  return async function authenticateBrowserSession({request,method}) {
    if(!request || typeof request.headers!=='object')return null;
    if(method!=='GET'&&method!=='POST')return null;

    const fetchSite=String(request.headers['sec-fetch-site']||'').toLowerCase();
    if(fetchSite==='cross-site'||fetchSite==='same-site')return null;
    if(method==='POST'){
      // Cookie-authenticated writes must not rely on SameSite alone.
      const suppliedOrigin=String(request.headers.origin||'');
      if(suppliedOrigin!==origin)return null;
    }
    try{
      const projection=await verifyAccountSession({request});
      const session=projection?.session;
      if(projection?.verified!==true||!session||
         typeof session.subject_id!=='string'||!UUID.test(session.subject_id)||
         !Number.isSafeInteger(session.expires_at_unix)||
         session.expires_at_unix<=Math.floor(now()/1000)+30)return null;
      return {userId:session.subject_id.toLowerCase()};
    }catch{
      // A missing or revoked OrdaX Platform session never downgrades to
      // client-provided identities or a second Flow authentication method.
      return null;
    }
  };
}
