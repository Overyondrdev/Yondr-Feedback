# yondr-feedback — instructions for Claude

The Yondr feedback tool: Worker `yondr-feedback` on `feedback.overyondrdev.com`. Any `*.overyondrdev.com` site or tool
adds it with one script tag (`public/widget.js`); the team reviews feedback at `/admin`. README.md has the embed
contract, JS API, data model, security model, deploy and rollback. Platform rules (sign-in, hosts, deploy lessons):
`Overyondrdev/overyondr-website-v1` → `docs/PLATFORM.md` and `docs/OPERATIONS.md`. Read them before changing sign-in,
CORS, hosts or deploys.

## Where things live
| Path | What |
| --- | --- |
| `src/index.js` | Routing, sign-in gate, static files, security headers |
| `src/http.js` | CORS origin rule and CSRF rule (the API's cross-origin contract) |
| `src/api.js` | The API (`/api/*`), incl. the admin-role rules (`adminChangeProblem`) |
| `src/schema.js` | D1 schema, applied automatically; additive changes only (`ADDED_COLUMNS`) |
| `src/ops.js` | Reports new/changed items to Yondr Ops (auto-fix triage, `feedback_critical`); no personal data |
| `src/client-errors.js` | Browser-error reports from embedding pages (`/api/client-errors`): redaction, rate limit, Ops forwarding |
| `src/auth.js` | Who is signed in (Yondr session; `DEV_EMAIL` locally) and their admin role |
| `src/yondr-session.js` | **Unchanged copy** of `overyondr-website-v1/auth/src/session.js` (CI compares) |
| `public/widget.js` | The embeddable widget (Shadow DOM, no dependencies); config parsing between `yfb-config` markers, error capture between `yfb-errors` markers |
| `public/admin.{html,js,css}` | Admin dashboard |
| `public/brand/` | Yondr wordmarks and the brand fonts Fraunces + Inter Tight (OFL) used by widget and admin |
| `scripts/build-static.mjs` | Bundles `public/` into `src/static.generated.js` (git-ignored) |
| `scripts/check.mjs` | Repo rules: syntax, Wrangler safety, no personal emails, no Squarespace hosts, no secrets (`scripts/secret-scan.mjs`) |
| `test/` | `node --test`; `test/helpers.js` stands in for D1 with `node:sqlite` |

## Rules
- **Same data**: D1 `yondr-feedback` and KV `yondr-feedback-screenshots` hold live feedback. Schema changes must be
  additive and idempotent (nullable columns via `ADDED_COLUMNS`, `IF NOT EXISTS`); never drop, rename or rewrite.
  Locally use `--local` only; never run commands against the remote database without the owner's say-so.
- **Sign-in on everything** except `/widget.js`, `/brand/*`, `/robots.txt` and preflights. Pages → 302 to
  `loginUrl(request)`, API → 401 JSON. No Cloudflare Access fallback. `workers_dev` and `preview_urls` stay `false`.
- **Keep `src/yondr-session.js` byte-identical** to `overyondr-website-v1/auth/src/session.js`. When that file
  changes, update this copy in a PR of its own.
- **CORS/CSRF**: credentialed CORS only for `https://*.overyondrdev.com` (localhost only with `DEV_EMAIL`); every
  state-changing request needs `X-Yondr-Feedback: 1` and an allowed `Origin`. Don't loosen these; keep the tests.
- Keep the API backwards compatible: embedded widgets update within 5 minutes (widget cache) but pages may stay open
  longer. Add fields; don't remove or rename them. `site` stays as an alias of `project`.
- Person fields use the shared directory picker (overyondr-website-v1 docs/PLATFORM.md §8); admin dashboard only, not
  the widget.
- Widget: no dependencies, Shadow DOM, keyboard operable, works at 375 px, `prefers-reduced-motion` respected. The
  website toolbar and tour stay behind `data-toolbar="website"`.
- **Never commit secrets or personal email addresses** (this repository is public). Owner lists are data in D1, not
  config. Tests and examples use the fictional people allowed in `scripts/check.mjs`. `DEV_EMAIL` only in `.dev.vars`.
- No new runtime dependencies (ask first). `wrangler` is the only dev dependency.
- Keep the Worker bundle well under 3 MB (`npm run deploy:dry` prints it; `public/` is capped at 1 MB at build).
- **Docs move with code**: a change to the embed contract, JS API, data model or admin updates README.md (it is the
  help for teams embedding the tool) in the same PR.

## How to ship a change
1. Branch from `main` (`feature/<name>` or `fix/<thing>`).
2. `npm ci` (first time), `npm run check`, `npm test`, `npm run deploy:dry`. All must pass.
3. Commit, push, open a PR into `main` using `.github/pull_request_template.md`. Never push or force-push `main`.
4. **Merge when ready, yourself (squash) — don't wait for the owner** (owner's standing instruction, OPERATIONS.md §2):
   ready = the **build** check green, branch up to date with `main`, docs updated, no open review questions. Still ask
   first for: deleting data, DNS or Access changes, and anything the owner asked to approve.
5. Deploy: `npm run deploy` (see README "Deploy"), then check https://feedback.overyondrdev.com/admin and one embedding
   site, and say what you checked. Delete the merged branch.
