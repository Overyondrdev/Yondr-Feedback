## What changed

## Who is affected
<!-- Sites/tools that embed the widget (v1, v2, portal, ads, requests, cards, …), admins, or nobody yet. -->
Affects:

## Checks
- [ ] `npm run check`, `npm test` and `npm run deploy:dry` pass
- [ ] API stays backwards compatible (no removed or renamed fields; `site` still works)
- [ ] Schema changes are additive and idempotent (`ADDED_COLUMNS` / `IF NOT EXISTS`)
- [ ] Sign-in, CORS and CSRF rules unchanged, or the change is explained here
- [ ] Widget checked on a page at desktop width and 375 px, keyboard only
- [ ] README updated (embed contract, JS API, data model or admin)
- [ ] No secrets or personal email addresses
