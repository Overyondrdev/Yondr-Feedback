// Cross-origin rules for the API. The widget runs on other *.overyondrdev.com hosts and calls
// https://feedback.overyondrdev.com/api/... with credentials: 'include'. The yondr_session cookie is
// SameSite=Lax on .overyondrdev.com: those hosts are same-site, so it is sent; any other site's requests carry no
// cookie at all. On top of that:
//   CORS  the exact Origin is echoed (with credentials) only for https://*.overyondrdev.com, plus
//         http://localhost / 127.0.0.1 on any port while running locally (DEV_EMAIL set).
//   CSRF  every state-changing request (anything but GET/HEAD/OPTIONS) must carry X-Yondr-Feedback: 1, a custom
//         header that forces a CORS preflight, AND an allowed Origin header.

export const ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*overyondrdev\.com$/;
export const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
export const CSRF_HEADER = 'x-yondr-feedback';
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isAllowedOrigin(origin, env = {}) {
  if (!origin || typeof origin !== 'string') return false;
  if (ORIGIN_RE.test(origin)) return true;
  return !!env.DEV_EMAIL && LOCAL_ORIGIN_RE.test(origin);
}

/** Headers that let an allowed origin read the response. Always varies on Origin. */
export function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const h = { vary: 'Origin' };
  if (isAllowedOrigin(origin, env)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-credentials'] = 'true';
  }
  return h;
}

export function preflight(request, env) {
  const origin = request.headers.get('origin');
  if (!isAllowedOrigin(origin, env)) {
    return new Response(null, { status: 403, headers: { vary: 'Origin', 'cache-control': 'no-store' } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request, env),
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
      'access-control-allow-headers': 'Content-Type, X-Yondr-Feedback',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
    },
  });
}

/** null if the request may change state, otherwise the reason it may not. */
export function csrfProblem(request, env) {
  if (SAFE_METHODS.has(request.method)) return null;
  if (request.headers.get(CSRF_HEADER) !== '1') return 'Missing X-Yondr-Feedback header.';
  if (!isAllowedOrigin(request.headers.get('origin'), env)) return 'Origin not allowed.';
  return null;
}

/** Copy a response, adding headers. */
export function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}
