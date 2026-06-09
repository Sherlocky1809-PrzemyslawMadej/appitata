---
date: 2026-06-08T16:10:37+0200
researcher: Przemek
git_commit: 82007cc169b4130acffda8131f1b48957fcfb611
branch: master
repository: 10x-lesson-project
topic: "API authorization + input-validation contract (test-plan Phase 2, Risks #2 & #4)"
tags: [research, codebase, api, authz, idor, validation, error-mapping, rls, rpc, testing]
status: complete
last_updated: 2026-06-08
last_updated_by: Przemek
---

# Research: API authorization + input-validation contract (Phase 2)

**Date**: 2026-06-08T16:10:37+0200
**Researcher**: Przemek
**Git Commit**: 82007cc169b4130acffda8131f1b48957fcfb611 (local, 15 ahead of origin/master — not pushed; local refs, no permalinks)
**Branch**: master
**Repository**: 10x-lesson-project

## Research Question

Phase 2 of the frozen test rollout ([test-plan.md §3](../../foundation/test-plan.md)): **"API authorization + input-validation contract — prove endpoints reject non-owners, non-connected invites, and malformed payloads with the correct status."** Covers **Risk #2** (a parent mutates an invitation/meeting that isn't theirs, or invites a non-connected parent — authorization/IDOR) and **Risk #4** (a route trusts the client or maps an RLS/RPC error to the wrong HTTP status — leaking a raw DB message or admitting an invalid write). Test type: **integration**. The research must ground (a) where each endpoint's authz precondition actually lives, (b) the exact validation + error-mapping contract per route, and (c) **how an integration test can exercise an Astro API route at all** — the existing suite only hits Supabase directly.

## Summary

Seven API routes are in scope (`src/pages/api/` minus `auth/*`, which §7 excludes as starter scaffold). The dominant architectural fact: **every route delegates its authorization decision to the database** (RLS `USING` clauses + SECURITY DEFINER RPCs). No route enforces ownership/connection inline in JavaScript except `friends/request.ts` (a self-check and an `is_connected` pre-probe). This shapes the entire test strategy:

- **Risk #2 (authz/IDOR):** all four "mutate-by-id" routes (`friends/requests/[id]` DELETE, `friends/respond`, `meetings/[id]` DELETE, `meetings/invitations/respond`) reject a non-owner by **RLS filtering the row to null → the route returns 404**. 404 is intentionally overloaded for "doesn't exist / not yours / not in a mutable state" — there is no existence oracle. A non-owner test therefore must _set up a real row owned by another user_ and assert the non-owner still gets 404 (a bare 404 against a random UUID proves nothing). The `meetings` create route rejects a non-connected invitee via the RPC raising `42501` → **403**.
- **Risk #4 (validation + error mapping):** zod guards every body/param; failures return **400**. The error-mapping surface is **inconsistent across routes** and that inconsistency is the test target — `meetings/index.ts` matches on four fragile RPC **message strings** before falling back to SQLSTATE codes (the canonical fragility flagged in the archived `meeting-creation-and-invite` impl-review F1), while four routes do **no** errcode mapping and treat _any_ DB error as a raw-500 with `error.message` leaked. Every route has at least one raw-DB-text leak path.
- **Harness blocker (the load-bearing finding):** the routes derive identity from the **cookie-bound SSR client** (`src/lib/supabase.ts`, which imports the virtual module `astro:env/server`), not from a bearer token. The current `vitest.config.ts` _deliberately_ excludes Astro/Vite plugins, so importing a route handler in a node test throws `Cannot find module 'astro:env/server'`. **Recommended approach: run the app and drive routes over HTTP with an authenticated cookie** (`POST /api/auth/signin` → capture `Set-Cookie` → replay) — a pattern that already exists, working, in `.verify-evidence/`. Assert DB side-effects out-of-band via the existing `serviceClient()` helper.

## Detailed Findings

### Scope: the seven routes (auth/\* excluded)

| Route                             | Method | Mutates                                 | Authz lives in                                              | Error mapping                                       |
| --------------------------------- | ------ | --------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `friends/request.ts`              | POST   | INSERT FC                               | inline self-check + `is_connected` probe + RLS insert-check | errcode (23505/23514/23503) + raw-500               |
| `friends/requests/[id].ts`        | DELETE | DELETE FC                               | RLS `friend_connections_delete` USING                       | none → raw-500 only                                 |
| `friends/respond.ts`              | POST   | UPDATE FC.status                        | RLS `friend_connections_update` USING/CHECK                 | none → raw-500 only                                 |
| `friends/search.ts`               | POST   | (read-only RPC)                         | RPC self-exclusion                                          | none → raw-500 only                                 |
| `meetings/index.ts`               | POST   | RPC: meeting + N invitations            | RPC `create_meeting_with_invitations`                       | **4 message-strings + SQLSTATE fallback** + raw-500 |
| `meetings/[id].ts`                | DELETE | DELETE meeting (cascade)                | RLS `meetings_delete` USING                                 | none → raw-500 only                                 |
| `meetings/invitations/respond.ts` | POST   | UPDATE invitation.{status,responded_at} | RLS `meeting_invitations_update` USING/CHECK                | none → raw-500 only                                 |

### Risk #2 — Authorization / IDOR (where rejection happens, and the status it yields)

**The 404-conflation pattern (4 routes).** `friends/requests/[id].ts`, `friends/respond.ts`, `meetings/[id].ts`, `meetings/invitations/respond.ts` all use `.update(...)/.delete()...eq("id", …).maybeSingle()`. RLS `USING` silently filters the row for any non-owner, so `data === null` → the route returns **404 "not found"** ([friends/requests/[id].ts:41-45](../../../src/pages/api/friends/requests/[id].ts#L41-L45); [friends/respond.ts:53-57](../../../src/pages/api/friends/respond.ts#L53-L57); [meetings/[id].ts:36-40](../../../src/pages/api/meetings/[id].ts#L36-L40); [meetings/invitations/respond.ts:56-60](../../../src/pages/api/meetings/invitations/respond.ts#L56-L60)). The 404 is **indistinguishable** between "row doesn't exist", "row exists but isn't yours", and "row exists, is yours, but isn't in a mutable state (already responded / >24h stale)". This is by design (no existence oracle), and it is the single most important fact for an authz test: **you must build a real row owned by user A, act as user B, and assert B still gets 404** — otherwise the test passes vacuously.

**The non-connected-invitee path (meetings create).** `POST /api/meetings` pushes the connection check into `create_meeting_with_invitations`, which loops every invitee through `is_connected(auth.uid(), invitee)` and `raise … errcode 42501` ('invitee not connected') on the first miss ([meetings_foundation.sql:184-188](../../../supabase/migrations/20260528105428_meetings_foundation.sql#L184-L188)). The route maps that to **403** ([meetings/index.ts:71-72](../../../src/pages/api/meetings/index.ts#L71-L72)). The creator is forced to `auth.uid()` inside the RPC — cannot be spoofed.

**The only inline-JS authz route.** `friends/request.ts` is the exception: a self-check `addressee_id === user.id` → **422** ([request.ts:40-42](../../../src/pages/api/friends/request.ts#L40-L42)) and an `is_connected` pre-probe → **409** "already connected" ([request.ts:58-68](../../../src/pages/api/friends/request.ts#L58-L68)), in addition to the RLS insert-check and the DB CHECK/UNIQUE constraints. The self-check is duplicated by the DB CHECK (`23514` → 422), giving two paths to the same status.

**Unauthenticated path (all routes).** Every route gates on `context.locals.user` (set by [middleware.ts:6-16](../../../src/middleware.ts#L6-L16)) and returns **401** if absent (e.g. [request.ts:22-23](../../../src/pages/api/friends/request.ts#L22-L23)). `meetings/index.ts` adds defense-in-depth: the RPC also raises `42501` 'authentication required' if `auth.uid()` is null ([meetings/index.ts:74-76](../../../src/pages/api/meetings/index.ts#L74-L76)).

### Risk #4 — Input validation + error mapping (the inconsistency is the target)

**zod on every payload.** Each route `safeParse`s its body/param and returns **400** on failure. Two divergences a test must branch on:

1. **Error-body wording diverges.** Body-schema routes return the raw zod message (`parsed.error.issues[0]?.message`, e.g. `"invalid UUID"`): [request.ts:35](../../../src/pages/api/friends/request.ts#L35), [friends/respond.ts:33](../../../src/pages/api/friends/respond.ts#L33), [search.ts:29](../../../src/pages/api/friends/search.ts#L29), [meetings/index.ts:45](../../../src/pages/api/meetings/index.ts#L45), [invitations/respond.ts:33](../../../src/pages/api/meetings/invitations/respond.ts#L33). The two `[id]` routes instead return a hardcoded `"invalid id"`: [friends/requests/[id].ts:23](../../../src/pages/api/friends/requests/[id].ts#L23), [meetings/[id].ts:23](../../../src/pages/api/meetings/[id].ts#L23).
2. **UUID regex is shape-only everywhere** (`UUID_SHAPE`, identical across the six routes that use it) — it deliberately accepts non-RFC-4122-version UUIDs ([request.ts:5-7](../../../src/pages/api/friends/request.ts#L5-L7)). Tests must NOT assume version validation; the real boundary is the DB FK/RLS.

**The error-mapping fragility (Risk #4's core).** `meetings/index.ts` is the worst offender and the canonical evidence: it matches **four RPC message strings** (`"invitee not connected"`→403, `"authentication required"`→401, `"at least one invitee required"`→400, `"too many invitees (max 50)"`→400) _before_ the SQLSTATE fallback ([meetings/index.ts:71-86](../../../src/pages/api/meetings/index.ts#L71-L86)). The archived impl-review F1 (see Historical Context) is exactly this: reword any RPC `raise` text and the precise status silently degrades to the SQLSTATE fallback. The fix already landed as defensive fallbacks `42501`→403 and `22023`→400 ([meetings/index.ts:85-86](../../../src/pages/api/meetings/index.ts#L85-L86)), so a renamed message degrades to the right _class_ but a different _body_. **A Phase-2 test should pin both the message path AND the code-fallback path** — that is what makes the regression visible.

**Every route has a raw-DB-text leak path.** Each returns `error.message` directly in a 500 body for any unmapped error: [request.ts:64,80](../../../src/pages/api/friends/request.ts#L80), [requests/[id].ts:39](../../../src/pages/api/friends/requests/[id].ts#L39), [friends/respond.ts:51](../../../src/pages/api/friends/respond.ts#L51), [search.ts:47](../../../src/pages/api/friends/search.ts#L47), [meetings/index.ts:87](../../../src/pages/api/meetings/index.ts#L87), [meetings/[id].ts:34](../../../src/pages/api/meetings/[id].ts#L34), [invitations/respond.ts:54](../../../src/pages/api/meetings/invitations/respond.ts#L54). Tests should assert the _mapped_ paths never reach a raw 500, and may document the known unmapped leaks (below) as latent findings.

**Unmapped errcodes → latent raw-500 leaks (candidate findings, not necessarily live):**

- **`23503` FK violation in `POST /api/meetings`** is NOT handled (route maps 23505/23514/42501/22023 only) → falls to the raw-500 leak at [meetings/index.ts:87](../../../src/pages/api/meetings/index.ts#L87). The sibling `friends/request.ts` _does_ map `23503`→404. Reachable only on a parent-deleted-mid-transaction race — latent, not easily triggerable.
- **`42501` permission-denied / WITH-CHECK violations** on the four no-errcode-mapping routes would surface as raw 500. Today's routes never write a disallowed column/status, so these are latent.

### The DB-side test oracle (errcodes are the stable contract; message strings are not)

Derived from `supabase/migrations/`. Use errcodes — not message text — as the oracle wherever possible:

| DB object                               | Trigger                                   | errcode / outcome                       | Route                        | Expected HTTP                   |
| --------------------------------------- | ----------------------------------------- | --------------------------------------- | ---------------------------- | ------------------------------- |
| create RPC `:168`                       | `auth.uid()` null                         | `42501` "authentication required"       | POST /api/meetings           | 401 (msg) / 403 (code fallback) |
| create RPC `:172`                       | empty invitee array                       | `22023` "at least one invitee required" | POST /api/meetings           | 400                             |
| create RPC `:180`                       | >50 invitees                              | `22023` "too many invitees (max 50)"    | POST /api/meetings           | 400                             |
| create RPC `:184`                       | invitee not `is_connected`                | `42501` "invitee not connected"         | POST /api/meetings           | 403                             |
| `meetings` CHECK `:19-24`               | field range/length violation              | `23514`                                 | POST /api/meetings           | 400                             |
| `meeting_invitations_unique_pair` `:38` | duplicate invitee UUID in array           | `23505`                                 | POST /api/meetings           | 422                             |
| FK invitee/creator                      | parent deleted mid-tx (race)              | `23503`                                 | POST /api/meetings           | **500 — UNHANDLED leak**        |
| `meetings_delete` USING                 | non-creator DELETE                        | row filtered → null                     | DELETE /api/meetings/[id]    | 404                             |
| `meeting_invitations_update` USING      | not invitee / status≠pending / >24h stale | row filtered → null                     | POST invitations/respond     | 404                             |
| `meeting_invitations_update` WITH CHECK | target status ∉ (accepted,declined)       | `42501` (only if forced)                | invitations/respond          | 500 if forced                   |
| `friend_connections_no_self` `:24`      | requester == addressee                    | `23514`                                 | POST /api/friends/request    | 422                             |
| `friend_connections_unique_pair` `:25`  | duplicate same-direction pair             | `23505`                                 | POST /api/friends/request    | 409 "already requested"         |
| FK `friend_connections.addressee_id`    | addressee not a real parent               | `23503`                                 | POST /api/friends/request    | 404                             |
| `is_connected` pre-probe                | already accepted-connected                | true                                    | POST /api/friends/request    | 409 "already connected"         |
| `friend_connections_update` USING       | not addressee / status≠pending            | row filtered → null                     | POST /api/friends/respond    | 404                             |
| `friend_connections_delete` USING       | not requester / status≠pending            | row filtered → null                     | DELETE friends/requests/[id] | 404                             |
| `find_parent_by_handle`                 | match / no-match / self                   | rows or empty (no error)                | POST /api/friends/search     | 200 `{found}`                   |

RPC/policy sources: `create_meeting_with_invitations` [meetings_foundation.sql:149-215](../../../supabase/migrations/20260528105428_meetings_foundation.sql#L149-L215); cross-table SECURITY DEFINER helpers `user_is_meeting_invitee`/`user_is_meeting_creator` [:58-94](../../../supabase/migrations/20260528105428_meetings_foundation.sql#L58-L94); friend_connections policies + constraints [friend_connections_foundation.sql:18-78](../../../supabase/migrations/20260527103435_friend_connections_foundation.sql#L18-L78); `is_connected` [:83-101](../../../supabase/migrations/20260527103435_friend_connections_foundation.sql#L83-L101); the invitation update policy was **dropped & recreated** by S-04 to add the `invited_at > now() - 24h` freshness predicate in the **USING** clause [invitation_expiry_sweep.sql:54-59](../../../supabase/migrations/20260601120000_invitation_expiry_sweep.sql#L54-L59) — so a >24h pending invite is invisible to the update path → 404 even before the cron flips it to `expired`.

### The harness question — how to exercise an Astro API route in a test

**The blocker.** Routes get identity two ways the existing node-only suite cannot fake: (1) `context.locals.user` from [middleware.ts:6-16](../../../src/middleware.ts#L6-L16); (2) a Supabase SSR client built **from request cookies** via [src/lib/supabase.ts:11-15](../../../src/lib/supabase.ts#L11-L15), which imports the **virtual module `astro:env/server`** at [src/lib/supabase.ts:3](../../../src/lib/supabase.ts#L3). That module is synthesized only by Astro's Vite plugin; the current [vitest.config.ts:5-7](../../../vitest.config.ts#L5-L7) deliberately omits `getViteConfig`/Astro plugins ("tests never import an Astro module"), and the helpers deliberately avoid the import ([tests/helpers/supabase.ts:7-10](../../../tests/helpers/supabase.ts#L7-L10)). So importing `export const POST` in a node test throws `Cannot find module 'astro:env/server'`.

**Approach A — live server + authenticated `fetch` (recommended).** Stand up the app (`astro preview` or dev on workerd), authenticate via `POST /api/auth/signin` with form `{email, password}` + `Origin` header (`maxRedirects:0`, asserting `302 → /`), capture the `Set-Cookie` SSR auth cookie, and replay it on `fetch` to the target route; assert HTTP status + JSON body, then assert DB side-effects with the existing `serviceClient()`. **This pattern already exists and works** in `.verify-evidence/` (`phase3-verify.mjs:55-69,316-330`, `verify-meetings.mjs:56-66,229-260`, `respond-test.mjs:18-35`). Two distinct authenticated users = two cookie jars. Pros: exercises the _real_ path (middleware → cookie-derived client → RLS/RPC → status mapping), which is precisely what Risks #2/#4 target; sidesteps `astro:env` by construction; matches [test-plan.md §6.4](../../foundation/test-plan.md) intent. Cons: needs a `globalSetup` to spawn + poll a server; workerd first-compile is slow (verify scripts bump timeouts to 90–120s); manual cookie capture/replay plumbing. `fileParallelism:false` is already set, avoiding port/DB races.

**Approach B — in-process handler import via `getViteConfig` (not recommended).** Switch the vitest config to Astro's `getViteConfig` so the virtual module resolves, then call `POST` with a hand-built `APIContext`. Fights the harness's deliberate design, still requires minting a real Supabase session cookie (route reads identity from cookies, not `locals.user`), bypasses the real middleware, and couples tests to Supabase-SSR's internal cookie format. Higher brittleness for little payoff given the routes are thin wrappers over RLS/RPC.

**Bottom line:** Approach A is the fit — the only approach that tests the status-mapping + authz contract end-to-end and the only one with a working reference already in the repo. The plan should decide: (a) `astro preview` vs `npm run dev`; (b) a Vitest `globalSetup` server-spawn + readiness poll; (c) a small cookie-jar helper in `tests/helpers/` (capture `set-cookie` from the signin 302, replay as `Cookie`).

### Existing test infrastructure to reuse (from Phase 1)

- **Runner:** Vitest `^3.2.6`, config [vitest.config.ts](../../../vitest.config.ts), env `node`, `include: tests/**/*.test.ts`, `fileParallelism:false`, env from `.env.test` via `loadEnv(...,"")`. `npm test → vitest run`.
- **Helpers** ([tests/helpers/supabase.ts](../../../tests/helpers/supabase.ts)): `anonClient()`, `serviceClient()` (RLS-bypass, fixture only), `signInAs(email,password) → {client, userId}` (signs in over HTTP, throws on auth error). **Silent-pass guard** (mandatory): before trusting a zero/empty result, assert `userId === <expected uuid>` and add a positive self-visibility control — a query with `auth.uid()=null` returns zero rows indistinguishable from correct isolation. This applies to authz tests too: a non-owner's RLS-filtered 404 looks identical to a no-session 404.
- **Seeded identities** ([supabase/seed.sql:12-15,49-64,77](../../../supabase/seed.sql#L49-L64)), shared password `test1234`: Alice `…a01`, Bob `…b01` (**accepted** FC w/ Alice), Carol `…c01` (**pending** FC w/ Alice), Dave `…d01` (**unconnected**). **No meetings/invitations are seeded** — the meetings suite builds its own fixture at runtime via `create_meeting_with_invitations` and tears down with `serviceClient()` ([meetings-isolation.test.ts:46-78](../../../tests/integration/meetings-isolation.test.ts#L46-L78)). Phase 2 will need a similar runtime fixture (a meeting owned by Alice with a pending invitation to Bob) to drive the IDOR cases as Bob/Carol/Dave.

## Code References

- `src/pages/api/friends/request.ts:5-7,9-11,40-42,58-68,70-81` — UUID_SHAPE regex; zod schema; inline self-check (422); `is_connected` pre-probe (409); INSERT + errcode mapping (23505→409, 23514→422, 23503→404, else 500-leak).
- `src/pages/api/friends/requests/[id].ts:7,21-23,31-45` — `paramSchema` UUID; hardcoded `"invalid id"` 400; DELETE `.maybeSingle()` → RLS-filtered → 404; raw-500 on any error.
- `src/pages/api/friends/respond.ts:7-10,33,43-57` — zod {request_id, action:enum}; UPDATE status → RLS USING/CHECK → 404 on filter-miss; raw-500-only.
- `src/pages/api/friends/search.ts:5-7,29,36,44-54` — handle schema; read-only `find_parent_by_handle` RPC; always 200 `{found}`; raw-500 on RPC error.
- `src/pages/api/meetings/index.ts:7-22,45,55-87` — full create schema (strict ISO `starts_at`, duration 1-1440, address bounds, invitee_ids ≤50); RPC call; the 4-message-string + SQLSTATE-fallback + raw-500 mapper.
- `src/pages/api/meetings/[id].ts:7,21-23,31-40` — `paramSchema` UUID; `"invalid id"` 400; DELETE → RLS `meetings_delete` → 404; FK cascade; raw-500-only.
- `src/pages/api/meetings/invitations/respond.ts:7-10,33,43-60` — zod {invitation_id, action:enum}; UPDATE {status, responded_at} with belt-and-suspenders `.eq("status","pending")`; 404 on filter-miss; raw-500-only.
- `src/middleware.ts:6-16` — `context.locals.user` resolution + protected-route redirect.
- `src/lib/supabase.ts:3,6,11-15` — `astro:env/server` import (the harness blocker); cookie-bound SSR client.
- `vitest.config.ts:5-7,11,19-25` — deliberate no-Astro-plugin design; node env; `.env.test` loading; `fileParallelism:false`.
- `tests/helpers/supabase.ts:7-10,26-40,42-73` — astro-import avoidance; `anonClient`/`serviceClient`/`signInAs`; silent-pass guard doc.
- `supabase/seed.sql:12-15,49-64,70-89` — test identities, relationship graph, GoTrue token-column coalesce-to-`''` (load-bearing for login).
- `.verify-evidence/phase3-verify.mjs`, `verify-meetings.mjs`, `respond-test.mjs` — working reference for signin-302 → cookie-replay over HTTP (untracked scratchpad).

## Architecture Insights

- **Authz is a DB concern, not an app concern.** The routes are thin HTTP adapters; the security boundary is RLS + SECURITY DEFINER RPCs. This means the cheapest _honest_ test must let RLS actually run (real local Supabase, two real authenticated users) — mocking the Supabase client proves nothing (echoes [test-plan.md §2 Risk #2 anti-pattern](../../foundation/test-plan.md)).
- **404, not 403, is the IDOR response** for the four mutate-by-id routes — a deliberate "no existence oracle" choice. Tests assert _behavioral_ equivalence (non-owner gets the same 404 as a missing row) against a _real_ other-owned row, never a tautological 404 against a random id.
- **errcode is the durable oracle; message strings are not.** The only load-bearing message-string matches are the four in `meetings/index.ts`; everything else keys off errcode or off `!data → 404`. Phase 2 tests should prefer asserting status (the contract) over asserting literal error bodies (which legitimately differ route-to-route), per [test-plan.md §2 Risk #4 anti-pattern](../../foundation/test-plan.md) ("asserting the current literal error string instead of the status/contract").
- **Validation mirrors DB constraints for defense-in-depth** (zod `invitee_ids.max(50)` mirrors the RPC's 50-cap; address bounds mirror the `meetings` CHECKs). A test can exploit this to probe whether zod or the DB owns a given rejection.
- **Belt-and-suspenders asymmetry:** `meetings/invitations/respond.ts` adds a JS `.eq("status","pending")` that its friend twin `friends/respond.ts` omits — same RLS guarantee, but the two-layer version would still reject a non-pending row if RLS were loosened. A test removing/keeping that guard documents which layer is load-bearing.

## Historical Context (from prior changes)

- **Phase 1 — `context/archive/2026-06-03-testing-privacy-rls-isolation/`** (the immediately prior phase): stood up the Vitest harness, `signInAs`/`serviceClient` helpers, the seeded 4-parent fixture, and the **silent-pass guard**. Phase 2 reuses all of it. Phase 1 explicitly did NOT test API routes or error-mapping — that was deferred here. Hard-won lessons baked into the seed: **GoTrue token columns must coalesce to `''`** (NULL → `Database error querying schema` on login; [lessons.md:19-23](../../foundation/lessons.md)) and **Docker-VM clock skew** (`PGRST303 "JWT issued at future"` on fresh boot; resync with `hwclock -s` — [test-plan.md §6.6](../../foundation/test-plan.md)).
- **`context/archive/2026-05-28-meeting-creation-and-invite/reviews/impl-review.md` (F1)** — the **canonical Risk #4 evidence**: the POST `/api/meetings` handler dispatched by `error.message` string instead of SQLSTATE; renaming any RPC `raise` text would silently fall through to a generic 500, swapping 403/400 for 500 and leaking the raw RPC message. **Resolution:** added the defensive SQLSTATE fallbacks (`42501`→403, `22023`→400) now at [meetings/index.ts:85-86](../../../src/pages/api/meetings/index.ts#L85-L86). Phase 2 must assert _both_ the message path and the code-fallback path so this regression stays caught.
- **`context/archive/2026-05-27-friend-connection-handshake/plan.md:62-70`** — the **column-level GRANT REVOKE-first** pattern (Supabase pre-grants ALL on `public` tables to `authenticated`, so a bare `grant update (status)` is additive and doesn't restrict — the REVOKE is load-bearing; verified via `\dp`), and the **alias-shadowing** RLS pitfall (a bare `id` inside an EXISTS subquery binds to the inner `fc` alias, not the outer `parents.id`). Both inform what a Phase-2 test could assert if it probes column-write restrictions, but writing new RLS is out of scope here.
- **`context/archive/2026-05-29-meeting-accept-with-conflict-and-list/plan.md:70-73,140-151`** — established the one-shot invitation update policy (`pending → accepted|declined`) and the 404-on-filter-miss + belt-and-suspenders `.eq("status","pending")` API shape that Phase 2 asserts. (Note: conflict-overlap math is **Phase 3 / Risk #3**, out of scope here.)

## Related Research

- `context/archive/2026-06-03-testing-privacy-rls-isolation/research.md` — Phase 1 RLS-isolation research (the read-path sibling of this authz/write-path research; shares harness + fixture).

## Open Questions (for `/10x-plan` to resolve)

1. **Server lifecycle:** `astro preview` (build once, fast, prod-like) vs `npm run dev` (workerd, slow first compile)? Recommendation leans `preview` for determinism; needs a Vitest `globalSetup` spawn + readiness poll and a teardown.
2. **Cookie-jar helper:** add a small `tests/helpers/http.ts` that does `signin → capture Set-Cookie → return a fetch wrapper that replays Cookie`, returning one jar per user. Or reuse Playwright's request context as `.verify-evidence/` does (adds a dep to the test path).
3. **Runtime fixture for IDOR cases:** Phase 2 needs a meeting owned by Alice with a pending invitation to Bob, built in `beforeAll` via `create_meeting_with_invitations` + `serviceClient()` teardown (mirroring `meetings-isolation.test.ts`). Confirm whether to extend the shared seed or keep it runtime-only (Phase 1 lesson: seed is shared state — runtime fixtures avoid perturbing the manual `*-rls.md` proof counts).
4. **Coverage breadth:** do all seven routes get authz + validation tests, or focus the High×High effort on the four mutate-by-id IDOR routes + `meetings` create (the richest error surface), treating `friends/search` (read-only, always-200) and the two delete routes more lightly? The risk map weights #2 and #4 — `search.ts` carries the least of either.
5. **Latent-leak findings:** do we assert the unmapped `23503`→raw-500 in `meetings/index.ts` as a _failing_ test (drives a fix) or document it as a known latent gap? It's hard to trigger (parent-deleted-mid-tx race) — likely a documented finding, not a live test.
6. **Body vs status assertions:** lock the convention that tests assert **HTTP status + DB side-effect**, and assert error _bodies_ only where load-bearing (the 4 `meetings` message strings), to avoid the "asserting the literal error string" anti-pattern.
