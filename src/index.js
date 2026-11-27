// yondr-feedback: the Yondr feedback tool on https://feedback.overyondrdev.com.
//   /widget.js        the embeddable widget (public; any *.overyondrdev.com site adds it with one script tag)
//   /brand/*          logos and brand fonts the widget and admin use (public, CORS *)
//   /admin            the admin dashboard (sign-in required; non-admins see "Admins only")
//   /api/*            the feedback API (sign-in required; CORS + CSRF rules in ./http.js)
// Every other request needs a valid Yondr sign-in (yondr_session cookie): pages redirect to the sign-in page,
// the API answers 401 JSON. Static files are bundled into the script (src/static.generated.js, from public/).
import { handleApi } from './api.js';
import { currentUser } from './auth.js';
import { corsHeaders, csrfProblem, preflight, withHeaders } from './http.js';
import { FILES } from './static.generated.js';
import { loginUrl } from './yondr-session.js';

const PUBLIC_FILE = /^\/(widget\.js|robots\.txt|brand\/[\w./-]+)$/;
const COMMON = {
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'strict-origin-when-cross-origin',
};
// auth.overyondrdev.com: the shared Yondr people picker (people-picker.js and its /api/people directory lookup).
const PEOPLE = 'https://auth.overyondrdev.com';
const ADMIN_CSP = `default-src 'none'; script-src 'self' ${PEOPLE}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; ` +
  `font-src 'self'; connect-src 'self' ${PEOPLE}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

/** Cache policy per bundled file. */
export function cacheControl(path) {
  if (path === '/widget.js') return 'public, max-age=300';                    // embedders pick up changes within 5 min
  if (path.startsWith('/brand/')) return 'public, max-age=2592000';          // logos and fonts: 30 days
  if (path === '/admin.html') return 'private, no-cache';                     // always revalidate; refs carry ?v=hash
  if (path === '/admin.js' || path === '/admin.css') return 'private, max-age=31536000, immutable';
  return 'public, max-age=86400';
}

const bytesCache = new Map();
function body(path, f) {
  if (f.text != null) return f.text;
  if (!bytesCache.has(path)) bytesCache.set(path, Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)));
  return bytesCache.get(path);
}

function serveFile(request, path) {
  const f = FILES[path];
  if (!f) return notFound();
  const headers = { ...COMMON, 'content-type': f.type, 'cache-control': cacheControl(path), etag: f.etag };
  if (PUBLIC_FILE.test(path)) {
    // Fonts are fetched in CORS mode by the pages that embed the widget; no credentials involved.
    headers['access-control-allow-origin'] = '*';
    headers['cross-origin-resource-policy'] = 'cross-origin';
  }
  if (path.endsWith('.html')) { headers['content-security-policy'] = ADMIN_CSP; headers['x-frame-options'] = 'DENY'; }
  if (request.headers.get('if-none-match') === f.etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : body(path, f), { headers });
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { ...COMMON, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
function jsonError(status, error, extra = {}) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...COMMON, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

async function api(request, env, url, user, ctx) {
  const cors = corsHeaders(request, env);
  const problem = csrfProblem(request, env);
  if (problem) return jsonError(403, problem, cors);
  try {
    const res = await handleApi(request, env, url.pathname.slice('/api/'.length), user, ctx);
    return withHeaders(res, { ...COMMON, ...cors });
  } catch (e) {
    console.error('api error', request.method, url.pathname, e && e.stack);
    return jsonError(500, 'Something went wrong. Please try again.', cors);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const isApi = path.startsWith('/api/');

    if (isApi && request.method === 'OPTIONS') return preflight(request, env);
    if ((request.method === 'GET' || request.method === 'HEAD') && PUBLIC_FILE.test(path)) return serveFile(request, path);

    const user = await currentUser(request, env).catch(() => null);
    if (!user) {
      if (!isApi && (request.method === 'GET' || request.method === 'HEAD'))
        return new Response(null, { status: 302, headers: { location: loginUrl(request), 'cache-control': 'no-store' } });
      return jsonError(401, 'Please sign in with your Yondr Google account.', isApi ? corsHeaders(request, env) : {});
    }

    if (isApi) return api(request, env, url, user, ctx);
    if (request.method !== 'GET' && request.method !== 'HEAD') return jsonError(405, 'Method not allowed');
    if (path === '/' || path === '/admin/' || path === '/index.html') return Response.redirect(new URL('/admin', url).toString(), 302);
    if (path === '/admin') return serveFile(request, '/admin.html');
    if (path === '/admin.js' || path === '/admin.css') return serveFile(request, path);
    return notFound();
  },
};
