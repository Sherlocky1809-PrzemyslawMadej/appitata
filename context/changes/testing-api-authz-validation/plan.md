# API Authorization + Input-Validation Contract Tests — Implementation Plan

## Overview

Phase 2 of the frozen test rollout ([test-plan.md §3](../../foundation/test-plan.md)). Add an HTTP-level integration suite that proves every in-scope API route **rejects non-owners** (Risk #2 — authorization / IDOR) and **rejects malformed payloads with the correct status and no raw-DB leak** (Risk #4 — input-validation + error-mapping). The routes delegate authorization to the database (RLS + SECURITY DEFINER RPCs), so the only honest test exercises the _real_ path: a running server, two distinct authenticated users over `fetch`, RLS actually on, side-effects verified out-of-band against local Supabase.

## Current State Analysis

- **Existing suite hits Supabase directly, not the routes.** `tests/integration/*.test.ts` sign in via `signInAs` and query the DB client; none drive an Astro API route. The routes are untested.
- **The harness blocker.** Routes build identity from request cookies via `createClient` ([src/lib/supabase.ts:9](../../../src/lib/supabase.ts#L9)), which imports the virtual module `astro:env/server` ([src/lib/supabase.ts:3](../../../src/lib/supabase.ts#L3)). The current [vitest.config.ts:5-7](../../../vitest.config.ts#L5-L7) _deliberately_ omits Astro/Vite plugins, so a node test cannot import a route handler — it throws `Cannot find module 'astro:env/server'`. The chosen workaround is to run the app and drive routes over HTTP.
- **Reusable infra (Phase 1).** `signInAs(email,password) → {client, userId}`, `serviceClient()` (RLS-bypass), `anonClient()` in [tests/helpers/supabase.ts](../../../tests/helpers/supabase.ts); `.env.test` loading + `fileParallelism:false` + `@`-alias in [vitest.config.ts](../../../vitest.config.ts); the silent-pass guard discipline; the 4-parent seed (Alice `…a01`, Bob `…b01` accepted, Carol `…c01` pending, Dave `…d01` unconnected, password `test1234`).
- **The signin route** ([src/pages/api/auth/signin.ts:13-19](../../../src/pages/api/auth/signin.ts#L13-L19)) returns `302 → /` on success and sets the SSR auth cookie; on failure it `302`s to `/auth/signin?error=…`. A working signin-then-replay reference exists in `.verify-evidence/verify-meetings.mjs:56-66` (Playwright request context, `maxRedirects:0`, asserts `302` + `location:"/"`).
- **The DB-side oracle** (errcodes, not message strings) is fully mapped in [research.md](research.md) §"DB-side test oracle".

## Desired End State

`npm test` builds the app once, starts a preview server, runs the existing DB-isolation suite **plus** a new `tests/integration/api/` suite that authenticates real users over HTTP and asserts the authz + validation contract, then tears the server down. Concretely:

- A non-owner (Bob/Carol/Dave) calling a mutate-by-id route against a row owned by Alice gets **404** — proven against a _real_ Alice-owned row, with an owner-success control proving the route isn't just always-404.
- Inviting a non-connected parent → **403**; malformed payloads → **400**; duplicate invitee → **422**; `friends/request` self → **422** and already-connected → **409**.
- The `meetings` create error-mapper is pinned on **both** the message-string path and the SQLSTATE-fallback path (the F1 regression guard).
- `test-plan.md §6.4` (API-endpoint cookbook) and `§6.6` (Phase 2 note) are filled; the Phase 2 status row reads `complete`; the `23503`→raw-500 latent leak is recorded as a finding.

### Key Discoveries

- **404 is the IDOR response**, not 403, for the 4 mutate-by-id routes — RLS `USING` filters the row to null → route returns 404 ([research.md](research.md) §Risk #2). A non-owner test is vacuous unless it runs against a real other-owned row.
- **errcode is the durable oracle; message strings are not.** Only `meetings/index.ts` ([src/pages/api/meetings/index.ts:66-87](../../../src/pages/api/meetings/index.ts#L66-L87)) has load-bearing message-string matches; assert both it and its SQLSTATE fallback.
- **Cookie identity, not bearer.** Tests must `POST /api/auth/signin` and replay the `Set-Cookie` — there is no token header path.
- **Seed is shared state** — runtime fixtures (not seed edits) avoid perturbing the manual `supabase/tests/*-rls.md` proof counts (Phase 1 lesson, [test-plan.md §6.6](../../foundation/test-plan.md)).
- **Login gotchas** are already handled in the seed (GoTrue token-column coalesce-to-`''`, [lessons.md](../../foundation/lessons.md)); Docker clock-skew (`PGRST303`) is environmental — resync, don't debug as a test bug.

## What We're NOT Doing

- **No production code changes.** The `23503`→raw-500 leak in `meetings/index.ts` is _documented as a finding_, not fixed (the parent-deleted-mid-tx race is impractical to trigger deterministically; a fix is its own change).
- **No conflict-overlap or 24h-expiry logic tests** — that is Phase 3 (Risk #3/#5).
- **No auth-scaffold tests** (`api/auth/*`, signin/up/out) — §7 excludes starter code.
- **No `friends/search` IDOR matrix** — it is read-only and always-200; it gets validation-smoke only.
- **No new RLS policies, migrations, or SECURITY DEFINER helpers** — Phase 2 _exercises_ the existing contract, it does not change it.
- **No Playwright / browser / e2e** — that is Phase 4. The harness is plain `fetch`.
- **No mocking of the Supabase client** — mocks prove nothing about RLS (test-plan §2 anti-pattern).

## Implementation Approach

Build the harness first and prove it with a single authenticated round-trip before writing any contract assertions — the server-spawn + cookie-jar plumbing is the only real unknown, so it gets its own phase and its own go/no-go gate. Then layer the two risk suites (authz, then validation/error-mapping) on top of the proven harness, each as its own test file under `tests/integration/api/`. Reuse `serviceClient()` for fixture build/teardown and for side-effect assertions; reuse the seeded identities for the cross-user matrix. Close out by filling the cookbook so the next contributor can add an API test by recipe.

## Critical Implementation Details

- **Timing & lifecycle.** `globalSetup` must `astro build` _before_ spawning `astro preview` (preview serves the last build; a stale or missing build silently serves old routes). Poll an actual route (e.g. `GET /auth/signin` → 200) for readiness, not just TCP connect — workerd/preview accepts the socket before routes compile. Tear the child process down in the returned teardown function even if a test throws.
- **Cookie capture is the load-bearing contract.** The signin route returns `302` with `Set-Cookie`; the helper must POST with `maxRedirects` disabled (a followed redirect to `/` drops the relevant header context) and capture **all** `set-cookie` values (Supabase-SSR may chunk a large session across `sb-…-auth-token.0/.1`). Replay every captured cookie on subsequent requests. Assert the signin actually returned `302 → /` (a `302 → /auth/signin?error=…` means bad credentials → fail loudly, never proceed with an anonymous jar — this is the silent-pass trap in HTTP form).
- **Silent-pass guard, HTTP edition.** A non-owner 404 and a no-session 404 are indistinguishable. Every authz test must (1) prove the actor's jar is authenticated (an owner-success control on the same route, or a `GET` that returns the actor's own data), and (2) run the deny case against a _real_ fixture row, never a random UUID.

## Phase 1: Harness — server lifecycle + cookie jar

### Overview

Stand up the HTTP test harness: a Vitest `globalSetup` that builds + serves the app and a plain-`fetch` cookie-jar helper, proven by one authenticated round-trip. No contract assertions yet.

### Changes Required:

#### 1. Vitest global setup (server lifecycle)

**File**: `tests/setup/server.ts` (new) + `vitest.config.ts`

**Intent**: Build the app once and run a preview server for the duration of the test run, so HTTP tests have a real SSR server to fetch against; tear it down after. Wire it into Vitest via `test.globalSetup` and expose the base URL to tests.

**Contract**: `globalSetup` default-exports an async function that (a) runs `astro build`, (b) spawns `astro preview` as a child process on a known port, (c) polls a real route until ready with a bounded timeout, (d) returns a teardown function that kills the child. The base URL is published to tests via an env var (e.g. `TEST_BASE_URL`, defaulting to `http://localhost:4321`) read in the helper. `vitest.config.ts` gains `globalSetup: "./tests/setup/server.ts"` and a `testTimeout`/`hookTimeout` raised enough to absorb first-request compile (~90s, per the verify-script precedent). Keep `fileParallelism:false`. Preserve the existing "never import an Astro module" comment — globalSetup spawns the server as a _subprocess_, it does not import Astro into the test process.

#### 2. HTTP cookie-jar helper

**File**: `tests/helpers/http.ts` (new)

**Intent**: Let a test act as a real authenticated user over HTTP by signing in through the real route and replaying the session cookie, with one independent jar per user so two users can be exercised in the same test.

**Contract**: Exposes `signInOverHttp(email, password) → Promise<Jar>` where `Jar` carries the captured cookies and a `fetch`-like method (`jar.fetch(path, init)`) that injects the `Cookie` header and resolves paths against `TEST_BASE_URL`. `signInOverHttp` POSTs form-encoded `{email,password}` to `/api/auth/signin` with `Origin` set and redirects NOT followed, asserts `status === 302 && location === "/"` (throws with the response body otherwise — the HTTP silent-pass guard), and captures every `set-cookie`. A convenience `jar.json(path, init)` returning `{status, body}` keeps assertions terse. No external deps — node `fetch` + manual `Set-Cookie`→`Cookie` handling only.

#### 3. Harness smoke test

**File**: `tests/integration/api/harness.smoke.test.ts` (new)

**Intent**: Prove the harness end-to-end before any contract work — a green here means server-spawn, signin, and cookie-replay all work.

**Contract**: Signs in as Alice via `signInOverHttp`, then makes one authenticated request that only an authenticated user could succeed at (e.g. `POST /api/friends/search` for Bob's handle → 200 `{found:true}`, or any route that returns non-401 only when the cookie is valid). Asserts the response is **not** 401 and the jar is usable. Also asserts an _unauthenticated_ `fetch` to the same route returns **401** (the negative control proving the cookie is what authenticates).

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes on touched files: `npx eslint tests/setup/server.ts tests/helpers/http.ts tests/integration/api/harness.smoke.test.ts`
- [ ] `npm test` builds, starts the server, runs the smoke test green, and tears the server down (no orphaned `astro preview` process)
- [ ] The existing Phase 1 suite (`parents-isolation`, `meetings-isolation`, `auth`, `smoke`) still passes under the new globalSetup

#### Manual Verification:

- [ ] On a cold `npm test` (server not pre-running), the run is self-contained — no manual server start needed
- [ ] A deliberately wrong password in `signInOverHttp` fails loudly (clear error, not a silent anonymous jar)
- [ ] Readiness poll tolerates workerd first-compile latency without flaking (run `npm test` 2–3× consecutively)

**Implementation Note**: After Phase 1 automated verification passes, pause for human confirmation that the harness is stable (especially server teardown on Windows) before building assertions on top of it.

---

## Phase 2: Authorization / IDOR tests (Risk #2)

### Overview

Prove the routes reject non-owners. Build a real Alice-owned fixture (meeting + pending invitation to Bob) at runtime, then drive the mutate-by-id routes as Bob/Carol/Dave and assert 404, with owner-success controls and the non-connected-invitee 403 on create.

### Changes Required:

#### 1. Runtime IDOR fixture

**File**: `tests/integration/api/authz.test.ts` (new) — `beforeAll`/`afterAll`

**Intent**: Create a real meeting owned by Alice with a pending invitation to Bob, so non-owner denials run against an existing row (not a random UUID), and tear it down cleanly so the shared DB is left untouched.

**Contract**: In `beforeAll`, build the fixture via Alice's authenticated DB client calling `create_meeting_with_invitations` (creator forced to `auth.uid()`), or via `serviceClient()` inserts; capture the created `meeting_id` and `invitation_id`. In `afterAll`, delete via `serviceClient()` filtered by the captured ids (FK cascade clears invitations). Mirrors [meetings-isolation.test.ts:46-78](../../../tests/integration/meetings-isolation.test.ts#L46-L78). Also create one pending **friend_connection** owned by an appropriate identity to exercise the friend mutate-by-id routes (or reuse the seeded Alice→Carol pending FC for the deny case — Carol is the addressee, so Dave/Bob acting on it is the non-owner).

#### 2. Mutate-by-id IDOR matrix

**File**: `tests/integration/api/authz.test.ts`

**Intent**: For each of the four mutate-by-id routes, assert a non-owner gets 404 against the real fixture row, and the legitimate owner succeeds (the control that proves the route isn't trivially always-404).

**Contract**: Cover, each as `{deny: 404, allow: success}` pairs using per-user jars from `tests/helpers/http.ts`:

- `DELETE /api/meetings/[id]` — Bob (invitee, non-creator) → 404; Alice (creator) → 204 (run the allow case last or on a throwaway fixture, since delete is destructive — build a second disposable meeting for the allow path).
- `POST /api/meetings/invitations/respond` — Carol/Dave (non-invitee) → 404; Bob (invitee) `accept` → 200 `{status:"accepted",responded_at}`; second Bob `accept` of the same invitation → 404 (one-shot). Verify the side-effect via `serviceClient()` (status flipped, `responded_at` stamped).
- `POST /api/friends/respond` — a non-addressee → 404; the real addressee → 200 `{status}`.
- `DELETE /api/friends/requests/[id]` — a non-requester → 404; the requester → 204.

#### 3. Non-connected-invitee + unauth controls

**File**: `tests/integration/api/authz.test.ts`

**Intent**: Pin the create-route authorization (connection precondition) and the universal unauthenticated rejection.

**Contract**: `POST /api/meetings` as Alice inviting Dave (unconnected) → **403**; as Alice inviting Bob (connected) → **201** `{meeting_id}` (control; tear down the created meeting). Inviting Carol (pending FC, not accepted) → **403** (pins "pending ≠ connected"). One representative unauthenticated call per HTTP method (no cookie) → **401**.

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes on touched files: `npx eslint tests/integration/api/authz.test.ts`
- [ ] `npm test` runs the authz suite green
- [ ] Each deny case has a paired allow/owner-success control in the same file (grep self-check: no lone 404 assertion without an authenticated control)
- [ ] Fixture teardown leaves zero residual rows (a `serviceClient()` count of the fixture ids after the run is 0)

#### Manual Verification:

- [ ] The non-connected-invitee 403 and the non-owner 404 are distinguishable in the test output (clear test names) so a future failure points at the right contract
- [ ] Running the suite twice in a row is idempotent (no "already exists"/leftover-fixture failures)

**Implementation Note**: After Phase 2 automated verification passes, pause for human confirmation that the IDOR matrix genuinely exercises non-owner paths (spot-check one deny case against a real row) before proceeding.

---

## Phase 3: Validation + error-mapping tests (Risk #4)

### Overview

Prove malformed payloads are rejected with the correct status and no raw-DB leak, and pin the `meetings` create error-mapper on both its message-string and SQLSTATE-fallback paths (the F1 regression guard).

### Changes Required:

#### 1. Zod-rejection matrix (the 5 mutators)

**File**: `tests/integration/api/validation.test.ts` (new)

**Intent**: Assert each mutating route returns 400 for representative malformed payloads, using an authenticated jar so the request reaches validation (not 401).

**Contract**: As an authenticated user, send malformed bodies/params and assert **400**:

- `POST /api/friends/request` — missing/garbage `addressee_id`.
- `POST /api/friends/respond` — bad `request_id`, and `action` outside `{accept,decline}`.
- `POST /api/meetings` — non-ISO `starts_at`, `duration_minutes` out of `[1,1440]`, empty `invitee_ids`, over-long address field.
- `POST /api/meetings/invitations/respond` — bad `invitation_id`, bad `action`.
- `DELETE /api/meetings/[id]` and `DELETE /api/friends/requests/[id]` — non-UUID `[id]` → 400.
  Assert **status only** for these (per the locked convention) — do not pin the divergent error bodies (`zod message` vs hardcoded `"invalid id"`).

#### 2. meetings create error-mapper (F1 guard)

**File**: `tests/integration/api/validation.test.ts`

**Intent**: Pin the load-bearing error mapping in `meetings/index.ts` on both the message-string branch and the SQLSTATE fallback, so a renamed RPC `raise` text still gets caught.

**Contract**: Drive real RPC failures through the route and assert status **and** body where the body owns the branch:

- empty `invitee_ids` → **400** (zod first; documents the defense-in-depth — note in the test that the RPC's `22023` is the deeper guard).
- duplicate invitee UUID in `invitee_ids` → **422** (`23505`, "duplicate invitee in request").
- non-connected invitee → **403** ("one or more invitees are not connected friends") — this is the message-string path.
- Assert that for the mapped failures the response body is the _safe_ mapped string, never a raw Postgres message (no `error.code`/SQLSTATE text, no `relation`/`constraint` leakage) — the anti-leak assertion.

#### 3. friends/request authz-validation edges + search smoke

**File**: `tests/integration/api/validation.test.ts`

**Intent**: Cover `friends/request`'s inline-JS branches (the one route with app-level authz logic) and give `friends/search` its validation-only smoke.

**Contract**:

- `POST /api/friends/request` self-request (`addressee_id == own id`) → **422**; requesting an already-accepted-connected parent (Alice→Bob) → **409** "already connected"; a duplicate same-direction pending request → **409** "already requested" (`23505`). Build/clean any fixture FC via `serviceClient()`.
- `POST /api/friends/search` — empty/over-long `handle` → 400; exact match for a seeded handle → 200 `{found:true,id,display_name}`; no match → 200 `{found:false}`; searching own handle → 200 `{found:false}` (self-exclusion). Status-focused; assert the `{found}` shape since that _is_ the contract.

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes on touched files: `npx eslint tests/integration/api/validation.test.ts`
- [ ] `npm test` runs the validation suite green
- [ ] The meetings error-mapper test asserts both the message-path body and that no raw DB text appears in any mapped error body
- [ ] No test pins a per-route divergent zod error string (convention self-check — bodies asserted only for the meetings message-strings and the search `{found}` shape)

#### Manual Verification:

- [ ] Temporarily reword one RPC `raise` message locally and confirm the F1-guard test still passes via the SQLSTATE fallback (status preserved) — then revert. Documents that the guard does its job.
- [ ] Error bodies in the test output contain no SQLSTATE codes, constraint names, or `relation` text for any mapped path

**Implementation Note**: After Phase 3 automated verification passes, pause for human confirmation (especially the manual reword-the-message F1 check) before close-out.

---

## Phase 4: Cookbook + close-out

### Overview

Capture the reusable recipe and finalize the phase's documentation so the next contributor adds an API test by pattern, and the test-plan reflects reality.

### Changes Required:

#### 1. Fill cookbook §6.4

**File**: `context/foundation/test-plan.md` (§6.4)

**Intent**: Replace the "TBD — see Phase 2" placeholder with the concrete recipe for testing a new API endpoint, derived from what this phase built.

**Contract**: §6.4 documents: location (`tests/integration/api/*.test.ts`), the harness (`globalSetup` preview server + `tests/helpers/http.ts` cookie jars, one per user), the authz pattern (deny against a _real_ fixture row + a paired owner-success control; 404-not-403 for mutate-by-id), the assertion convention (status + DB side-effect via `serviceClient()`; bodies only where load-bearing), and the errcode-over-message-string oracle. Cross-references §6.2's fixture/teardown rules.

#### 2. Phase note §6.6 + latent-leak finding + status flip

**File**: `context/foundation/test-plan.md` (§6.6, §3 status) and `context/foundation/lessons.md` (optional)

**Intent**: Record the 2–3 surprising things this phase taught, register the documented `23503` latent leak, and flip the Phase 2 rollout status to `complete`.

**Contract**: §6.6 gains a Phase 2 bullet (the cookie-replay/`maxRedirects:0` gotcha; the HTTP silent-pass guard; the preview-build-before-serve ordering). The `23503`→raw-500 leak in `meetings/index.ts` is recorded as a known finding (here and, if it generalizes, via `/10x-lesson`). The §3 Phase 2 status cell moves from `change opened` to `complete`. (Per CLAUDE.md, do not alter risk definitions or quality-gate rows — Phase 2 only updates its own status + cookbook.)

### Success Criteria:

#### Automated Verification:

- [ ] `test-plan.md §6.4` no longer contains "TBD — see §3 Phase 2"
- [ ] `test-plan.md §3` Phase 2 status cell reads `complete`
- [ ] Markdown lint/format clean on touched docs: `npx prettier --check context/foundation/test-plan.md` (or `--write`)

#### Manual Verification:

- [ ] A reader unfamiliar with the harness could add a new API-endpoint test from §6.4 alone
- [ ] The latent-leak finding is recorded where a future maintainer will see it

**Implementation Note**: This phase is documentation-only; no server run required. Confirm the test-plan reads coherently end-to-end after the edits.

---

## Testing Strategy

### Integration Tests (the deliverable itself):

- **Authz / IDOR** (`authz.test.ts`): non-owner → 404 on the 4 mutate-by-id routes against real fixture rows; owner-success controls; one-shot transition (second respond → 404); non-connected-invitee → 403; pending-FC ≠ connected → 403; unauthenticated → 401.
- **Validation / error-mapping** (`validation.test.ts`): zod malformed → 400 across the 5 mutators + 2 `[id]` params; meetings duplicate-invitee → 422; meetings non-connected → 403 (message-path) with no raw-DB leak; `friends/request` self → 422, already-connected → 409, duplicate → 409; `friends/search` validation + `{found}` smoke.

### Key edge cases explicitly covered:

- A non-owner 404 vs a no-session 404 (disambiguated by an authenticated owner-success control — the HTTP silent-pass guard).
- The F1 fragility: message-string path **and** SQLSTATE-fallback path both asserted.
- pending-FC vs accepted-FC for the invite-connection check.

### Manual Testing Steps:

1. `npm test` cold (no pre-running server) → self-contained green run, server torn down.
2. Reword one RPC `raise` message → F1-guard test still green via SQLSTATE fallback → revert.
3. Inspect mapped-error bodies → no SQLSTATE / constraint / relation text.

## Performance Considerations

- `astro build` adds ~30–60s once per `npm test`; preview avoids per-request compile. `hookTimeout`/`testTimeout` raised to ~90s to absorb first-request latency on workerd. `fileParallelism:false` keeps DB-mutating fixtures from racing. Acceptable for an integration suite run locally + in CI; not a per-edit hook (that layering is Module 3 Lesson 3, out of scope here).

## Migration Notes

- No schema or data migration. Fixtures are runtime-only and torn down; the shared seed and the manual `supabase/tests/*-rls.md` proof counts are left untouched (deliberate — Phase 1 shared-state lesson).
- Local prerequisite: `npx supabase start` + `npm run db:reset`, and `.env.test` populated from `npx supabase status` (`SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).

## References

- Research: [research.md](research.md)
- Test plan (frozen strategy): [test-plan.md](../../foundation/test-plan.md) §2 (Risks #2/#4), §3 (Phase 2 row), §6.2/§6.4 (cookbook)
- Lessons: [lessons.md](../../foundation/lessons.md) (GoTrue token columns)
- Harness reference: `.verify-evidence/verify-meetings.mjs:56-66` (signin-302 → cookie replay)
- Fixture reference: [meetings-isolation.test.ts:46-78](../../../tests/integration/meetings-isolation.test.ts#L46-L78)
- Error-mapper under test: [meetings/index.ts:66-87](../../../src/pages/api/meetings/index.ts#L66-L87)
- F1 evidence: `context/archive/2026-05-28-meeting-creation-and-invite/reviews/impl-review.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Harness — server lifecycle + cookie jar

#### Automated

- [x] 1.1 Type checking passes: `npm run typecheck`
- [x] 1.2 Linting passes on touched files (`tests/setup/server.ts`, `tests/helpers/http.ts`, `harness.smoke.test.ts`)
- [x] 1.3 `npm test` builds, starts server, runs smoke test green, tears server down (no orphaned process)
- [x] 1.4 Existing Phase 1 suite still passes under the new globalSetup

#### Manual

- [x] 1.5 Cold `npm test` is self-contained (no manual server start)
- [x] 1.6 Wrong password in `signInOverHttp` fails loudly (no silent anonymous jar)
- [x] 1.7 Readiness poll tolerates workerd first-compile without flaking (2–3 consecutive runs)

### Phase 2: Authorization / IDOR tests (Risk #2)

#### Automated

- [ ] 2.1 Type checking passes: `npm run typecheck`
- [ ] 2.2 Linting passes on `authz.test.ts`
- [ ] 2.3 `npm test` runs the authz suite green
- [ ] 2.4 Each deny case has a paired authenticated allow/owner-success control (no lone 404)
- [ ] 2.5 Fixture teardown leaves zero residual rows (serviceClient count of fixture ids = 0)

#### Manual

- [ ] 2.6 Non-connected-invitee 403 and non-owner 404 are distinguishable in test output
- [ ] 2.7 Suite is idempotent across two consecutive runs

### Phase 3: Validation + error-mapping tests (Risk #4)

#### Automated

- [ ] 3.1 Type checking passes: `npm run typecheck`
- [ ] 3.2 Linting passes on `validation.test.ts`
- [ ] 3.3 `npm test` runs the validation suite green
- [ ] 3.4 meetings error-mapper test asserts the message-path body AND no raw DB text in any mapped error
- [ ] 3.5 No test pins a per-route divergent zod error string (convention self-check)

#### Manual

- [ ] 3.6 Rewording one RPC `raise` message keeps the F1-guard test green via SQLSTATE fallback (then reverted)
- [ ] 3.7 Mapped-error bodies contain no SQLSTATE / constraint / relation text

### Phase 4: Cookbook + close-out

#### Automated

- [ ] 4.1 `test-plan.md §6.4` no longer contains "TBD — see §3 Phase 2"
- [ ] 4.2 `test-plan.md §3` Phase 2 status cell reads `complete`
- [ ] 4.3 Prettier clean on touched docs (`context/foundation/test-plan.md`)

#### Manual

- [ ] 4.4 A reader could add a new API-endpoint test from §6.4 alone
- [ ] 4.5 The `23503` latent-leak finding is recorded where a maintainer will see it
