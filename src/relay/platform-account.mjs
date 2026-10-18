/**
 * Flow -> OrdaX Platform account-identity adapter.
 *
 * Reuses the existing, signed Product owner account session boundary:
 * GET /v3/product/session. This verifies identity only. It does not mint
 * new sessions, infer MCP grants or grant Hub privileges.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 4096;

export const PLATFORM_ACCOUNT_SESSION_PATH = '/v3/product/session';

function platformEndpoint(baseUrl, allowLoopbackHttp) {
  if (typeof baseUrl!=='string') throw new TypeError('platform_origin_required');
  let parsed;
  try { parsed=new URL(baseUrl); } catch { throw new TypeError('platform_origin_invalid'); }
  const allowedHttp = allowLoopbackHttp===true &&
    parsed.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(parsed.hostname);
  if (parsed.protocol!=='https:' && !allowedHttp) throw new TypeError('platform_https_required');
  if (parsed.username || parsed.password || parsed.pathname!=='/' ||
      parsed.search || parsed.hash || !parsed.hostname) {
    throw new TypeError('platform_origin_only');
  }
  return new URL(PLATFORM_ACCOUNT_SESSION_PATH,parsed).href;
}

/**
 * createFlowPlatformAuthenticator does not cache tokens, transfer them to
 * providers or trust unsigned JWT claims. The Platform endpoint authenticates
 * each request, with issuer, audience and signed owner claims as its SSOT.
 */
export function createFlowPlatformAuthenticator({
  platformOrigin, fetchImpl=globalThis.fetch, timeoutMs=12000,
  allowLoopbackHttp=false, now=()=>Date.now()
}) {
  const endpoint=platformEndpoint(platformOrigin,allowLoopbackHttp);
  if (typeof fetchImpl!=='function' || typeof now!=='function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs<100 || timeoutMs>15000) {
    throw new TypeError('platform_adapter_invalid');
  }

  return async function authenticate(accountToken) {
    if (typeof accountToken!=='string' ||
        accountToken.length<16 || accountToken.length>4096 ||
        !/^[\x21-\x7e]+$/.test(accountToken)) return null;

    try {
      const response=await fetchImpl(endpoint,{
        method:'GET',redirect:'error',
        headers:{authorization:'Bearer '+accountToken,accept:'application/json'},
        signal:AbortSignal.timeout(timeoutMs)
      });
      if (!response || response.status!==200 ||
          !String(response.headers.get('content-type')||'').toLowerCase().includes('application/json')) {
        return null;
      }
      // Guard against unbounded responses from proxies or compromised hosts.
      const reader=response.body?.getReader();
      if (!reader) return null;
      const parts=[];
      let bytes=0;
      try {
        while(true) {
          const {value,done}=await reader.read();
          if(done)break;
          bytes+=value.byteLength;
          if(bytes>MAX_RESPONSE_BYTES)return null;
          parts.push(value);
        }
      }finally{reader.releaseLock();}
      const payload=JSON.parse(new TextDecoder().decode(
        Uint8Array.from(parts.flatMap(part=>Array.from(part)))));
      const session=payload?.session;
      if(payload?.ok!==true || !session ||
          typeof session.subject_id!=='string' ||
          !UUID_RE.test(session.subject_id) ||
          typeof session.issuer!=='string' || !session.issuer ||
          !(typeof session.audience==='string' ||
            (Array.isArray(session.audience) && session.audience.length>0 &&
             session.audience.every(item=>typeof item==='string' && item.length>0))) ||
          !Number.isSafeInteger(session.expires_at_unix) ||
          session.expires_at_unix <= Math.floor(now()/1000)+30) {
        return null;
      }
      // Only return the subject. Operator privileges and project ownership
      // have their own canonical authorizers; no role inferred from tokens.
      return {userId:session.subject_id.toLowerCase()};
    }catch{
      // Signature, network, timeout, proxy, malformed JSON and expiry failures
      // all deny without retry or fallback to local/legacy authentication.
      return null;
    }
  };
}
