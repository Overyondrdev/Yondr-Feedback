import { yondrUser } from './yondr-session.js';

// Identity: the Yondr Google sign-in session (yondr_session cookie on .overyondrdev.com, issued by
// auth.overyondrdev.com and verified by ./yondr-session.js). There is no Cloudflare Access fallback.
//
// Local development only: DEV_EMAIL in .dev.vars (git-ignored) signs every request in as that person, and an
// X-Dev-Email header acts as someone else (to test roles). DEV_EMAIL must never be set on the deployed Worker;
// scripts/check.mjs fails if it appears in wrangler.jsonc.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/;

export async function currentUser(request, env) {
  // DEV_EMAIL is honoured only on localhost, so setting it on the deployed Worker by mistake can't skip sign-in.
  if (env.DEV_EMAIL && LOCAL_HOST.test(new URL(request.url).hostname)) {
    const as = request.headers.get('x-dev-email');
    return { email: String(as || env.DEV_EMAIL).trim().toLowerCase(), name: null };
  }
  return yondrUser(request, env);
}

export async function roleOf(db, email) {
  const row = await db.prepare('SELECT role FROM admins WHERE email = ?').bind(email).first();
  return row ? row.role : null;
}
