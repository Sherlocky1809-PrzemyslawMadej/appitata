# API Authorization + Input-Validation Contract Tests — Plan Brief

> Full plan: `context/changes/testing-api-authz-validation/plan.md`
> Research: `context/changes/testing-api-authz-validation/research.md`

## What & Why

Phase 2 of the frozen test rollout: prove the API routes **reject non-owners** (Risk #2 — authorization / IDOR) and **reject malformed payloads with the correct HTTP status and no raw-DB leak** (Risk #4 — input-validation + error-mapping). These are the two High×High risks the routes carry, and they are currently untested — the existing suite only hits Supabase directly, never the routes.

## Starting Point

A Phase-1 Vitest harness exists (`signInAs`/`serviceClient` helpers, `.env.test` loading, a 4-parent seed, `fileParallelism:false`, the silent-pass guard), but it talks to Supabase directly. The routes derive identity from **cookies** (`src/lib/supabase.ts` imports the virtual `astro:env/server`), so a node test cannot import a handler — the only honest path is to run the app and drive routes over authenticated HTTP, a pattern already proven in `.verify-evidence/`.

## Desired End State

`npm test` builds the app once, runs a preview server, executes the existing isolation suite **plus** a new `tests/integration/api/` suite that signs in real users over HTTP and asserts the authz + validation contract, then tears the server down. A non-owner hitting a mutate-by-id route against a real Alice-owned row gets 404 (with an owner-success control); non-connected invites get 403; malformed payloads get 400; the `meetings` error-mapper is pinned on both its message-string and SQLSTATE-fallback paths. The §6.4 cookbook is filled so the next API test is written by recipe.

## Key Decisions Made

| Decision             | Choice                                                    | Why (1 sentence)                                                                     | Source   |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------- |
| Test execution       | Run real routes over HTTP (not import handlers)           | Routes read identity from cookies via `astro:env/server`; node import is blocked.    | Research |
| Server lifecycle     | `astro build` once → `astro preview` via `globalSetup`    | Prod-like SSR, deterministic, no per-request compile stall.                          | Plan     |
| Auth/cookie carry    | Plain-`fetch` cookie-jar helper (`tests/helpers/http.ts`) | Zero new deps; one jar per user = two users trivially; keeps Playwright to Phase 4.  | Plan     |
| IDOR fixtures        | Runtime `beforeAll` (not seed edits)                      | Avoids perturbing the shared seed + manual `*-rls.md` proof counts (Phase 1 lesson). | Plan     |
| Coverage breadth     | Full authz+validation on the 5 mutators; smoke on search  | Effort follows the risk map; `friends/search` is read-only, always-200.              | Plan     |
| `23503` raw-500 leak | Document as a finding, no live test                       | The parent-deleted-mid-tx race is impractical to trigger deterministically.          | Plan     |
| Assertion target     | Status + DB side-effect; body only where load-bearing     | Avoids the "assert literal error string" anti-pattern (test-plan §2).                | Research |

## Scope

**In scope:**

- HTTP harness: `globalSetup` preview server + `tests/helpers/http.ts` cookie jars.
- Authz/IDOR tests for the 4 mutate-by-id routes + `meetings` create (non-connected → 403).
- Validation + error-mapping tests for the 5 mutators (+ 2 `[id]` params); `friends/search` validation smoke.
- The F1 regression guard (message-string **and** SQLSTATE-fallback paths) + anti-leak assertion.
- Cookbook §6.4, §6.6 note, Phase 2 status flip, latent-leak finding.

**Out of scope:**

- Any production code change (the `23503` leak is documented, not fixed).
- Conflict-overlap / 24h-expiry tests (Phase 3); auth-scaffold tests (§7-excluded); Playwright/e2e (Phase 4).
- New RLS / migrations / SECURITY DEFINER helpers; mocking the Supabase client.

## Architecture / Approach

`globalSetup` builds + spawns a preview server and polls a real route for readiness; tests import `signInOverHttp(email,password)` which POSTs to `/api/auth/signin` (`maxRedirects:0`, asserts `302 → /`), captures `Set-Cookie`, and returns a per-user `fetch` wrapper that replays the `Cookie`. Each test file builds its own runtime fixture (Alice's meeting + pending invite to Bob) via `create_meeting_with_invitations` / `serviceClient()` and tears it down. Assertions check HTTP status, then DB side-effects via `serviceClient()`; error bodies are asserted only for the load-bearing `meetings` message-strings and the search `{found}` shape.

## Phases at a Glance

| Phase                              | What it delivers                                      | Key risk                                                 |
| ---------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| 1. Harness — server + cookie jar   | `globalSetup` server + `http.ts` + a green smoke test | Server spawn/teardown + cookie capture (Windows/workerd) |
| 2. Authz / IDOR (Risk #2)          | Non-owner → 404 matrix + 403 + owner controls         | Vacuous 404s if a deny case lacks a real-row + control   |
| 3. Validation + error-mapping (#4) | 400 matrix + F1 guard + anti-leak assertions          | Pinning divergent error bodies (anti-pattern) by mistake |
| 4. Cookbook + close-out            | §6.4 recipe, §6.6 note, status flip, leak finding     | Doc drifts from what the suite actually does             |

**Prerequisites:** local Supabase up (`npx supabase start` + `npm run db:reset`); `.env.test` populated from `npx supabase status` (URL, anon key, service-role key); Docker clock sane (no `PGRST303`).
**Estimated effort:** ~2–3 sessions across 4 phases (Phase 1 is the unknown; 2–3 are mechanical once the harness is green; 4 is docs).

## Open Risks & Assumptions

- **Harness stability on Windows/workerd** is the main unknown — server teardown and first-compile latency are why Phase 1 has its own go/no-go gate.
- **Cookie chunking**: a large Supabase session may split across `sb-…-auth-token.0/.1`; the jar must capture _all_ `set-cookie` values.
- **Build cost** (~30–60s) is paid once per `npm test`; acceptable for an integration suite, not for a per-edit hook.
- Assumes the seeded relationship graph (Alice↔Bob accepted, Alice↔Carol pending, Dave unconnected) is stable; runtime fixtures avoid touching it.

## Success Criteria (Summary)

- A non-owner is provably rejected (404/403) against a real other-owned row, with an owner-success control that rules out a vacuous always-reject.
- Malformed payloads return 400, and no mapped error path leaks raw Postgres text; the `meetings` F1 mapper survives a message reword via its SQLSTATE fallback.
- `npm test` is self-contained (builds, serves, tests, tears down) and the §6.4 cookbook lets the next contributor add an API test by recipe.
