/** Two separate Flow user-facing apps, one canonical API (no second backend). */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const asset = relative => fileURLToPath(new URL(relative, import.meta.url));
const FILES = new Map([
  ['/client',{file:asset('../../apps/flow-client/index.html'),type:'text/html; charset=utf-8'}],
  ['/client/',{file:asset('../../apps/flow-client/index.html'),type:'text/html; charset=utf-8'}],
  ['/client/app.mjs',{file:asset('../../apps/flow-client/app.mjs'),type:'text/javascript; charset=utf-8'}],
  ['/hub',{file:asset('../../apps/flow-hub/index.html'),type:'text/html; charset=utf-8'}],
  ['/hub/',{file:asset('../../apps/flow-hub/index.html'),type:'text/html; charset=utf-8'}],
  ['/hub/app.mjs',{file:asset('../../apps/flow-hub/app.mjs'),type:'text/javascript; charset=utf-8'}],
  ['/shared/api.mjs',{file:asset('../../apps/shared/api.mjs'),type:'text/javascript; charset=utf-8'}],
  ['/shared/styles.css',{file:asset('../../apps/shared/styles.css'),type:'text/css; charset=utf-8'}]
]);
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'",
  "connect-src 'self'", "img-src 'self'", "base-uri 'none'",
  "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'"
].join('; ');

export function createFlowWebHandler(gateway) {
  if (typeof gateway !== 'function') throw new TypeError('flow_web_requires_gateway');
  return async (request,response) => {
    const pathname=new URL(request.url||'/', 'http://localhost').pathname;
    const item=request.method==='GET' ? FILES.get(pathname) : null;
    if (!item) return gateway(request,response);
    try {
      const contents=await readFile(item.file);
      response.writeHead(200, {
        'content-type':item.type,
        'content-security-policy':CONTENT_SECURITY_POLICY,
        'cache-control':'no-store',
        'x-content-type-options':'nosniff',
        'x-frame-options':'DENY',
        'referrer-policy':'no-referrer'
      });
      response.end(contents);
    } catch {
      response.writeHead(503,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});
      response.end('Flow app indisponível');
    }
  };
}
