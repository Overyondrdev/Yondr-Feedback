// Repository checks (run in CI and before deploy): syntax, Wrangler safety rules, no personal email addresses, no secrets,
// nothing loaded from Squarespace. Exits non-zero with a list of problems.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepo } from './secret-scan.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const problems = [];
const SKIP = new Set(['node_modules', '.git', '.wrangler']);
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(ROOT).map((p) => relative(ROOT, p)).filter((p) => p !== 'src/static.generated.js' && p !== 'package-lock.json');

// 1. Syntax
for (const f of files.filter((f) => /\.(m?js)$/.test(f))) {
  try { execFileSync(process.execPath, ['--check', join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { problems.push(`${f}: syntax error\n${e.stderr}`); }
}

// 2. Wrangler config
const wr = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
if (!/"workers_dev":\s*false/.test(wr)) problems.push('wrangler.jsonc: workers_dev must be false');
if (!/"preview_urls":\s*false/.test(wr)) problems.push('wrangler.jsonc: preview_urls must be false');
if (/DEV_EMAIL/.test(wr)) problems.push('wrangler.jsonc: DEV_EMAIL must never be configured (local .dev.vars only)');
if (/overyondr\.com"/.test(wr.replace(/ALLOWED_EMAIL_DOMAINS": "overyondr\.com"/, ''))) problems.push('wrangler.jsonc: no overyondr.com routes before cutover');

// 3. Session verifier copy (CI also compares it byte-for-byte with the auth Worker's source of truth)
if (!readFileSync(join(ROOT, 'src/yondr-session.js'), 'utf8').includes('Source of truth: overyondr-website-v1/auth/src/session.js'))
  problems.push('src/yondr-session.js: must be an unchanged copy of overyondr-website-v1/auth/src/session.js');

// 4. Text-file content rules. This repository is public: no personal email addresses (tests use fictional people).
const FICTIONAL = new Set(['you@overyondr.com', 'name@overyondr.com', 'ada.owner@overyondr.com', 'ben.admin@overyondr.com',
  'cy.staff@overyondr.com', 'dee.new@overyondr.com']);
const SQUARESPACE = /(squarespace-cdn\.com|static1\.squarespace\.com|assets\.squarespace\.com|sqspcdn\.com)/;
for (const f of files.filter((f) => /\.(m?js|json|jsonc|md|html|css|sql|yml|yaml|txt|toml)$|^CODEOWNERS$|\/CODEOWNERS$/.test(f))) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const e = m[0].toLowerCase();
    if (e.endsWith('@overyondr.com') && !FICTIONAL.has(e)) problems.push(`${f}: personal email address? ${e} (use a fictional one from scripts/check.mjs)`);
  }
  if (SQUARESPACE.test(text) && f !== 'scripts/check.mjs') problems.push(`${f}: references a Squarespace host`);
}

// 5. Secrets in tracked files (API keys, tokens, webhook URLs, private keys): scripts/secret-scan.mjs, also run alone.
problems.push(...scanRepo(ROOT).problems);

if (problems.length) {
  console.error(problems.map((p) => '✗ ' + p).join('\n'));
  process.exit(1);
}
console.log(`check: ${files.length} files OK`);
