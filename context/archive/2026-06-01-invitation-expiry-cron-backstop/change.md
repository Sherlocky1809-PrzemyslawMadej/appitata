---
change_id: invitation-expiry-cron-backstop
title: 24h invitation expiry cron backstop
status: archived
created: 2026-06-01
updated: 2026-06-02
archived_at: 2026-06-02T06:58:20Z
---

## Notes

### Phase 2 — local scheduled-trigger verification gap (2026-06-01)

`@astrojs/cloudflare` v13.5 runs its dev server on `@cloudflare/vite-plugin`, which does **not** expose a working local scheduled-trigger endpoint: both `curl /cdn-cgi/handler/scheduled` (500, handler never invoked) and `wrangler dev --test-scheduled` → `/__scheduled` (404) fail. The plan's literal step 2.6 therefore can't be run as written.

How 2.6 was verified instead:

- **Sweep body on workerd** — a throwaway `/__sweep-probe` fetch route (since removed) called `expire_stale_invitations()` via the service-role client: first call `{data:1}` flipped the seeded 25h row to `expired`; second call `{data:0}` (idempotent). Proves `createAdminClient` + the RPC work on the real runtime.
- **Wiring in the production bundle** — the built `dist/server/entry.mjs` + `wrangler.json` preserve the user-set `main: ./src/worker.ts` (the adapter wraps, not replaces, it via the vite-plugin virtual entry) and carry both the `scheduled` handler and `triggers.crons: ["0 3 * * *"]`.

Residual: the literal Cron-Trigger → `scheduled()` invocation can only be exercised on a real deploy — that is plan step **2.7** (`wrangler deploy`, human-only), left intentionally pending.
