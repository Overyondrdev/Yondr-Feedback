# Yondr feedback

A universal, pluggable feedback tool for Yondr's sites and internal tools on `*.overyondrdev.com`. Any page adds it
with **one script tag** and gets a "Give feedback" button: Yondr staff leave documented, individual feedback about the
page, or about **one specific asset** on it (an ad, a marketing request, a card design), with screenshots they can
mark up. The team reviews everything at **https://feedback.overyondrdev.com/admin**.

- Worker **`yondr-feedback`** on the custom domain **`feedback.overyondrdev.com`** (Cloudflare account
  `3fac6c19097c5692e17198cffa818085`).
- Data: D1 **`yondr-feedback`**, KV **`yondr-feedback-screenshots`**, Workers AI. The same database and namespace the
  website Worker used before this tool moved out of `overyondr-website-v1`: nothing was copied or migrated.
- Sign-in: the Yondr Google sign-in (`yondr_session` cookie from `auth.overyondrdev.com`), like every overyondrdev.com
  site. See `overyondr-website-v1/docs/PLATFORM.md`.
- No runtime dependencies. Plain JavaScript; `wrangler` is the only dev dependency.

## Add it to a site or tool

```html
<script src="https://feedback.overyondrdev.com/widget.js" data-project="ads" defer></script>
```

Put it anywhere in the page (end of `<body>` is fine). It must be served from a `https://*.overyondrdev.com` page: the
sign-in cookie only reaches the API from those hosts, and the API only answers them (see *Security*).

| Attribute | Default | What it does |
| --- | --- | --- |
| `data-project` | the host's first label (`ads.overyondrdev.com` → `ads`; `overyondrdev.com`/`www` → `portal`) | Which site or tool the feedback is about. Lowercase letters, digits, hyphens; up to 40. |
| `data-asset` | none | A default asset id: all feedback from this page is about that item unless the person removes it. |
| `data-asset-label` | none | The asset's human name, shown to the person and in the admin. |
| `data-toolbar` | off | `website` = the website preview toolbar (All versions, V1/V2 switch, Tour, Give feedback) and the first-visit tour. Only for the website (V1, V2, portal). |
| `data-position` | `right` | Where the launcher tab sits: `right`, `left`, or `none` (no tab; open it from your own button). |

Known projects: `v1`, `v2`, `portal` (website), `ads` (ad library), `requests` (marketing requests), `cards`
(Christmas cards). Any other id works; the admin shows it as is (add a friendly name in `PROJECTS` in
`public/admin.js` and `PROJECT_NAMES` in `public/widget.js`).

### Feedback on one asset, without JavaScript

Any element with `data-yfb-open` opens the panel; `data-yfb-asset` (+ `data-yfb-asset-label`, `data-yfb-type`) makes
that feedback about one item:

```html
<!-- Ad library: a button on each ad card -->
<button type="button" data-yfb-open data-yfb-asset="ad-1842" data-yfb-asset-label="Spring 2027 · LinkedIn 1080×1080">
  Feedback on this ad
</button>
```

### JavaScript API

The script defines `window.YondrFeedback` when it has loaded (and fires a `yondrfeedback:ready` event on `window`).

```js
YondrFeedback.open({ asset: 'req-311', assetLabel: 'Request #311 · Trade show banner', type: 'design' });
YondrFeedback.open();                          // the page itself (or the default asset)
YondrFeedback.close();
YondrFeedback.setAsset('card-7', 'Card design 7'); // from now on, feedback is about this item (null clears it)
YondrFeedback.setProject('requests');          // rarely needed; prefer data-project
YondrFeedback.project();                       // current project id
```

- `open({ asset })` applies while the panel is open; when it closes, the page's default asset (from `data-asset` or
  `setAsset`) is back. `setAsset` changes that default, e.g. when a single-page app shows another item.
- `type` preselects one of `bug`, `design`, `content`, `idea`, `question`, `praise`, `other`.

### React (or any single-page app)

```jsx
// Once, e.g. in index.html: <script src="https://feedback.overyondrdev.com/widget.js" data-project="requests" defer></script>

function RequestPage({ request }) {
  // Feedback from this screen is about the request being shown.
  useEffect(() => {
    const set = () => window.YondrFeedback?.setAsset(String(request.id), `Request #${request.id} · ${request.title}`);
    if (window.YondrFeedback) set(); else window.addEventListener('yondrfeedback:ready', set, { once: true });
    return () => window.YondrFeedback?.setAsset(null);
  }, [request.id, request.title]);

  return (
    <button type="button" onClick={() => window.YondrFeedback?.open({ asset: String(request.id), assetLabel: request.title })}>
      Give feedback on this request
    </button>
  );
}
```

### Vanilla app

```html
<script src="https://feedback.overyondrdev.com/widget.js" data-project="cards" data-position="none" defer></script>
<script>
  document.querySelectorAll('.card-design').forEach((el) => {
    el.querySelector('.feedback').addEventListener('click', () =>
      YondrFeedback.open({ asset: el.dataset.id, assetLabel: el.dataset.name }));
  });
</script>
```

### The website (V1, V2, portal)

```html
<script src="https://feedback.overyondrdev.com/widget.js" data-project="v1" data-toolbar="website" defer></script>
```

`data-project` is `v1`, `v2` or `portal`. On V1/V2 the toolbar pushes the page down 44 px (top-pinned fixed/sticky
elements move below it) and links to the sibling hosts (`v1.`, `v2.`, the apex). The tour is offered on a person's
first 3 visits (visit = back after 30+ min), once per visit; finishing ends it; the 1st skip points at the Tour button
and offers to resume next visit; the 2nd skip is final; part-way tours are still offered after visit 3. State is the
`yfb_tour` cookie on `.overyondrdev.com`. On the portal, the form asks whether feedback is about V1, V2 or both, and any
`[data-yfb-tour]` element replays the tour.

## What people get

A launcher tab (or the toolbar button) opens a panel in a Shadow DOM (no style leaks either way), keyboard operable,
`prefers-reduced-motion` respected, full-width at 375 px:
- **New feedback**: type, details, priority; **Screenshot** (browser screen capture, one "Share this tab" prompt,
  then a mark-up editor: box, arrow, draw, highlight, text, blur, crop, undo), **Point at it** (pick the element),
  **Upload**, or paste/drop images (up to 6). Drafts are kept per page (and per asset) in the page's `localStorage`.
  When the type is **Bug**, a short notice under the message box (linked to it with `aria-describedby`, so screen
  readers read it with the box) says: *"Bug reports may be shared publicly to get them fixed. Please don't include
  personal or confidential details (names, emails, phone numbers, client information)."* (auto-fix may file the bug as
  a public GitHub issue; see "Yondr Ops").
- **My feedback**: the person's items on this page/item or everywhere, status, replies from the team, reply, withdraw
  while new. A dot shows new activity.
- Alt+Shift+F hides/shows the launcher.

## Admin

https://feedback.overyondrdev.com/admin (`/` redirects there). Overview (KPIs, AI summary, pipeline, by project, pages
and assets with most feedback, activity), Inbox (filters: search, status, type, **project**, **asset**, priority,
owner, sort), Board (drag between statuses), Themes & summary (Workers AI), People & access, CSV export.

Roles live in the D1 `admins` table: `owner` or `admin`. Admins see and manage all feedback and add admins; only an
owner can add owners, change an owner's role or remove an owner; nobody can remove themselves. Everyone else who
signs in sees an "Admins only" page (the widget works for every `@overyondr.com` person).

## Yondr Ops: auto-fix and critical alerts

Every new item, and every change of **type** or **priority** (by an admin, or by the author while it is new), is
reported to Yondr Ops (`ops.overyondrdev.com`, repo `Overyondrdev/yondr-ops`) in the background (`src/ops.js`,
`ctx.waitUntil`: nobody waits for it and an ops outage never fails a request):

- `POST https://ops.overyondrdev.com/api/autofix/feedback`: ops **triages** the item for the auto-fix engine. Only
  **bugs** that are **objective** (verifiable: errors, broken links, a form that fails, broken layout at 375 px, text
  differing from its source, sign-in failures, missing images) can be fixed automatically; everything else, including
  subjective issues marked critical, goes to a person. Rules, flow and setup: the ops README, "Auto-fix".
- `POST https://ops.overyondrdev.com/api/events` with type `feedback_critical` when an item is created as, or changed
  to, **critical** (any type), so the people subscribed in Ops are alerted.

Both send the shared secret `OPS_INGEST_TOKEN` (Worker secret, optional: without it nothing is sent) in `X-Ops-Token`.
**No personal data is sent** (the owner accepted public auto-fix issues on that condition): no author, assignee, voter or
commenter; `redact()` in `src/ops.js` removes from the title, message, URL, path, page title and asset: e-mail
addresses; phone numbers (international and local formats, e.g. `+44 20 7946 0958`, `(415) 555-0100`); street
addresses (house number + street word, e.g. `12 High Street`, `5 rue de la Paix`) with the town and postcode/ZIP
after them; UK postcodes anywhere; and secrets: URL parameters whose name contains key/token/secret/password/auth/
session/signature/code, Bearer/Basic credentials and well-known token formats. Dates, times, versions, ids and paths
stay. Ops runs the same `redact()` again before opening an issue (keep the two copies identical). Screenshots are only
referenced by their path here (`/api/attachments/<id>`, which needs a Yondr sign-in), never sent. Sent fields: `feedback_id`, `reason` (`created`/`updated`), `project`, `asset`, `type`, `priority`,
`status`, `title`, `message`, `url`, `path`, `page_title`, `screenshots`, `admin_url`, `created_at`.

Careful: the text of an item that ops sends to the auto-fix engine ends up in a GitHub issue in a **public**
repository. The widget's bug notice tells people not to put personal or confidential information in bug reports.

In the admin, each item's details have an **Auto-fix** row linking to its status in Ops
(`https://ops.overyondrdev.com/#autofix/feedback/<id>`), where admins see the timeline, can mark it objective or
subjective, and can revert a fix.

## Data model (D1 `yondr-feedback`)

| Table | What |
| --- | --- |
| `feedback` | One item: `author_email`, `project`, `asset`, `asset_label`, `url`, `path`, `page_title`, `type`, `priority`, `status`, `title`, `message`, `assignee`, `tags` (JSON), `context` (JSON: viewport, scroll, browser, pinned element), `score`, `comment_count`, `attachment_count`. `site` is the legacy name of `project` (kept equal to it). |
| `attachments` | Screenshot metadata; the image is in KV under `shot/<id>` |
| `comments` | Replies; `internal = 1` = admin-only note |
| `votes` | Agree (+1) / disagree (−1) per admin |
| `activity` | Audit trail (created, updated, commented, admin_added, …) |
| `admins` | `email`, `role` (`owner` / `admin`) |
| `summaries` | AI summaries (JSON) |

`src/schema.js` applies the schema on the first request of each isolate. Changes must be **additive and idempotent**
(new nullable columns via `ADDED_COLUMNS`, `CREATE … IF NOT EXISTS`); `migrations/` documents the same SQL.
The 2026-11 upgrade added `project`, `asset`, `asset_label` and backfilled `project` from `site`.

## API

`https://feedback.overyondrdev.com/api/…`, JSON, signed-in only (401 otherwise).

| Method + path | Who | What |
| --- | --- | --- |
| `GET me` | anyone | `{ email, role, isAdmin }` |
| `GET feedback?scope=mine\|all&project=&asset=&status=&type=&priority=&assignee=&author=&path=&q=&sort=&limit=` | anyone (`all` = admins) | List. `asset=` (empty) = page feedback only; `site=` still works as `project=` |
| `POST feedback` | anyone | `{ project, asset?, assetLabel?, type, priority, message, title?, url, path, pageTitle, context, screenshots: [{ dataUrl, width, height }] }` → `{ id }` |
| `GET/PATCH/DELETE feedback/:id` | author (limited) or admin | Detail / edit / withdraw or delete |
| `POST feedback/:id/comments`, `POST feedback/:id/vote` | author or admin | Reply (`internal` for admins) / vote |
| `GET attachments/:id` | author or admin | Screenshot image |
| `GET stats`, `GET/POST summary`, `GET/POST/DELETE admins`, `GET export.csv` | admins | Dashboard data |

## Security

- **Sign-in**: every request except `/widget.js`, `/brand/*`, `/robots.txt` and CORS preflights needs a valid
  `yondr_session` (verified by `src/yondr-session.js`, an unchanged copy of
  `overyondr-website-v1/auth/src/session.js`; CI compares them). Pages redirect to the sign-in page; the API answers
  401 JSON. There is no Cloudflare Access fallback.
- **CORS**: the API echoes the request's `Origin` with `Access-Control-Allow-Credentials: true` (and `Vary: Origin`)
  only when it matches `^https://([a-z0-9-]+\.)*overyondrdev\.com$`; `http://localhost:*` / `127.0.0.1:*` only while
  running locally with `DEV_EMAIL`. Preflights from other origins get 403. The cookie is `SameSite=Lax` on
  `.overyondrdev.com`, so other sites' requests carry no cookie anyway.
- **CSRF**: every POST/PATCH/DELETE needs `X-Yondr-Feedback: 1` (a custom header, so browsers must preflight) **and**
  an allowed `Origin`. The widget and the admin send both.
- Static files are bundled into the Worker (`public/` → `src/static.generated.js` at build), so nothing is served
  without these checks. The admin page has a strict CSP and can't be framed. Public files: `/widget.js` (5 min cache),
  `/brand/*` (30 days, `Access-Control-Allow-Origin: *` for the fonts).
- Trust boundary: any `*.overyondrdev.com` host can call the API as the signed-in person. Only add hosts we control.

## Develop

```sh
npm ci
echo 'DEV_EMAIL="you@overyondr.com"' > .dev.vars    # local only; signs every request in as you
npm run dev                                          # wrangler dev --local on http://localhost:8787 (admin: /admin)
npx wrangler d1 execute yondr-feedback --local --command \
  "INSERT INTO admins (email, role, added_at) VALUES ('you@overyondr.com', 'owner', datetime('now'))"
```

Locally an `X-Dev-Email` header acts as someone else (to test roles). To try the widget on another origin, serve a
page on `http://localhost:4321` with `<script src="http://localhost:8787/widget.js" data-project="test">`. Workers AI
isn't available in local mode (the AI summary answers an error). Always `--local`; never point dev at the remote
database.

| Command | What |
| --- | --- |
| `npm run build` | Bundle `public/` into `src/static.generated.js` (also run automatically by `wrangler dev/deploy`) |
| `npm run check` | Build + syntax, Wrangler safety rules, no personal email addresses, no Squarespace hosts |
| `npm test` | Build + unit and end-to-end tests (`node --test`; D1 is stood in for by `node:sqlite`) |
| `npm run deploy:dry` | `wrangler deploy --dry-run` (prints the bundle size) |
| `npm run deploy` | check + test + `wrangler deploy` |

## Deploy

`npm run deploy` (needs Cloudflare credentials for the account). It works from Claude cloud sessions too, because the
Worker has no static assets to upload (they're bundled into the script). Bundle: about 340 KiB (160 KiB gzipped); the
free plan allows 3 MB. `wrangler deploy` replaces dashboard plain-text variables with `wrangler.jsonc`'s: keep every
variable there. One optional secret: `OPS_INGEST_TOKEN` (the same value as on `yondr-ops`;
`npx wrangler secret put OPS_INGEST_TOKEN`), which turns on the reports to Yondr Ops above. Never set `DEV_EMAIL` on
the deployed Worker.

First deploy (owner approval needed: new Worker and host):
1. `npm run deploy` creates `yondr-feedback` and the `feedback.overyondrdev.com` custom domain.
2. Add `feedback.overyondrdev.com` to the Access application "Yondr sites (Google sign-in)" (Bypass), and add a line
   for it to `SITES` in `overyondr-website-v1/auth/src/pages.js`.
3. In Incognito: `/admin` sends you to the sign-in page and back; `/api/me` answers 401 when signed out.

## Rollback

- Code: `npx wrangler rollback` (or Workers → yondr-feedback → Deployments → roll back), or revert the commit and
  deploy.
- Data is shared with the old website Worker and the schema change is additive, so the website's own feedback
  routes keep working until they are removed. If the website has already switched to this tool, roll back the
  website's switch-over PR to bring its `/__feedback` routes and admin back.
