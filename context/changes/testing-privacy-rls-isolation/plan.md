# Test-runner bootstrap + privacy-boundary RLS isolation — Implementation Plan

## Overview

This is **§3 Phase 1** of `context/foundation/test-plan.md`. It stands up the project's **first automated test runner** (Vitest) and uses it to prove the **privacy boundary** — Risk #1 (a parent reads another circle's data) and the **read path of Risk #2** (cross-table meeting/invitation visibility) — holds at the database, with RLS actually on, exercised over the full HTTP auth path the app uses.

No test runner exists today. The boundary is enforced entirely by four RLS SELECT policies on `authenticated`; a test that mocks the Supabase client proves nothing. The suite must authenticate as two distinct real parents against local Supabase and assert cross-circle reads return zero — while guarding against the highest-value trap: an unauthenticated query (`auth.uid()` null) silently returns zero rows and looks like a pass.

## Current State Analysis

- **No runner, no test deps.** `package.json` has no `test` script and no `vitest`/`jest`/`@playwright` ([package.json:5-15](package.json#L5-L15)). `overrides.vite: "^7.3.2"` ([package.json:61](package.json#L61)) pins Vite 7, so any Vitest must be **≥3.x**.
- **The `astro:env/server` trap.** `src/lib/supabase.ts` imports `{ SUPABASE_URL, SUPABASE_KEY } from "astro:env/server"` — a virtual module only resolvable inside the Astro/Vite build; a plain Vitest import of it fails. The escape is **not to import it**: build a plain `@supabase/supabase-js` client from a plain env object, exactly as [src/lib/supabase-admin.ts:18-28](src/lib/supabase-admin.ts#L18-L28) already does.
- **The four read-path SELECT policies** (all on `authenticated`):
  - `parents_select` — `is_connected(auth.uid(), id)` **OR a pending FC between viewer and the row in either direction**. The pending branch is the load-bearing trap (`public.parents.id` is qualified to avoid alias shadowing).
  - `friend_connections_select` — `auth.uid() = requester_id or addressee_id`.
  - `meetings_select` — `auth.uid() = creator_id or public.user_is_meeting_invitee(id, auth.uid())`.
  - `meeting_invitations_select` — `auth.uid() = invitee_id or public.user_is_meeting_creator(meeting_id, auth.uid())`.
  - The meetings↔invitations pair routes through two `SECURITY DEFINER` helpers to break Postgres's infinite-recursion guard.
- **"Connected" has two faces.** `public.is_connected` = **accepted-only**; `parents_select` = accepted **OR pending**. The reconciliation point is `public.list_my_friends()` (accepted-only). A pending-FC parent is visible via `parents` but **not** via `list_my_friends()`.
- **Seed fixture is two parents + one accepted FC**, with **empty passwords** ([supabase/seed.sql:15-38](supabase/seed.sql#L15-L38)) — `signInWithPassword` is rejected today. There is **no seeded unconnected parent and no seeded pending FC**; every existing proof inlines Carol/Dave per-block with `on conflict do nothing`.
- **Manual proofs are the behavioural spec.** `supabase/tests/{parents,friend-connections,meetings}-rls.md` encode the expected isolation as row counts (e.g. meetings cross-table = creator 1 / invitee 1 / uninvolved 0). These are the spec to automate — **not** the oracle to copy from the policy SQL.
- **Local env.** `.dev.vars` (gitignored) holds working local URL + publishable (anon) + service_role keys; `.env.example` documents all three. No `.env.test` exists. Local Supabase: API `54321`, `enable_confirmations = false`.

### Key Discoveries

- The `auth.uid()=null` silent-pass is the #1 trap — [supabase/tests/parents-rls.md:13](supabase/tests/parents-rls.md#L13). Every zero-row assertion must first prove the identity is set.
- Seeding Carol + a pending FC **mutates the shared fixture the manual proofs read** — `friend-connections-rls.md` Block 2 uses Carol as the "outsider sees 0 FC" identity; a seeded pending FC for Carol breaks that premise. Reconciliation is mandatory, not optional.
- The seed-password fix is pre-specified: append `update auth.users set encrypted_password = crypt('<const>', gen_salt('bf')) where id in (…);` (pgcrypto pre-enabled locally) — [context/archive/2026-05-29-meeting-accept-with-conflict-and-list/reviews/plan-review.md:39-40](context/archive/2026-05-29-meeting-accept-with-conflict-and-list/reviews/plan-review.md#L39-L40).
- Cross-table fixtures must use the RPC or service_role inserts, not chained supabase-js calls (no multi-statement transactions in supabase-js).

## Desired End State

`npm test` runs a Vitest integration suite against local Supabase that:

1. Authenticates as two+ distinct parents via `signInWithPassword` over HTTP (full PostgREST + RLS path).
2. Proves the parents isolation matrix (accepted-connected sees / unconnected sees zero), the meetings+invitations cross-table isolation (1 / 1 / 0), and the `parents`-vs-`list_my_friends()` pending distinction.
3. Guards every zero-row assertion with an explicit identity check, plus a no-identity negative control.

Verify by: `npm test` green from a clean `npm run db:reset`; the three `supabase/tests/*-rls.md` proof docs still pass by hand with their updated counts; test-plan §3 Phase 1 row marked `complete` and cookbook §6.2 / §6.5 filled.

## What We're NOT Doing

- **No write-path / mutation tests** — accept/decline/delete authorization, invite-non-connected rejection, one-shot transitions are **Risk #2 write path = Phase 2**.
- **No conflict-overlap or expiry logic** — Phase 3. **No e2e, no secret-isolation static check, no CI Supabase-boot job** — Phase 4.
- **No `friend_connections` "outsider sees 0" coverage as a new test** — deferred (not selected for Phase 1 scope); we only _reconcile_ the existing manual proof block, we don't automate it.
- **No CI wiring** — Phase 1 delivers `npm test` + a green local run only. The GitHub Actions integration job (boot local Supabase in Actions + key sourcing) is a documented Phase 4 task. The §5 "required after Phase 1" gate is satisfied locally; CI enforcement lands in Phase 4.
- **No `getViteConfig` / Astro-coupled config** — the suite is HTTP-only and never imports an Astro module, so a minimal `process.env`-based config suffices.
- **No new RLS migrations** — the policies are correct; we test them, we don't change them.

## Implementation Approach

Three dependency-ordered phases. Phase 1 stands up the harness and is green standalone (service_role connectivity only — no seed change needed). Phase 2 makes HTTP login possible (passwords) and persists the multi-parent topology, reconciling the manual proofs it disturbs. Phase 3 writes the isolation suite on top of both and fills the cookbook.

Tests live under `tests/integration/` with shared helpers in `tests/helpers/`; Vitest config at repo root. All Supabase clients are built plain (URL + key from `process.env`, sourced from `.env.test`) — never via `astro:env`.

## Critical Implementation Details

- **Silent-pass guard is non-negotiable.** A query run without a real authenticated identity makes every policy branch false and returns zero rows — indistinguishable from a correct isolation result. Every isolation assertion must first confirm the client's session resolves to the expected user id (e.g. assert `getUser()` returns the impersonated id, or select a self-visible row and assert it is present) before trusting any zero-row count. A dedicated negative-control test asserts that a no-session client returns zero — documenting the failure mode rather than hiding it.
- **The oracle problem.** Expected counts come from the _scenario_ ("an unconnected parent sees zero"), not from re-deriving the USING clause. The `*-rls.md` row counts (1/1/0, etc.) are the behavioural spec; do not lift expectations from the policy SQL.
- **Seeding mutates shared state.** Adding Carol + a pending FC changes counts the existing manual proofs assert. The pending arm and the unconnected arm must be **different parents** (a parent in a pending FC with the viewer is _visible_ via `parents`, so it cannot also serve as the "unconnected, invisible" arm).

## Phase 1: Test-runner & harness bootstrap

### Overview

Install Vitest, add a minimal config and the `npm test` script, establish the `.env.test` convention, and write a shared client helper plus a connectivity smoke test that proves the harness reaches local Supabase. Green without any seed change (uses the service_role client, which needs no password).

### Changes Required

#### 1. Test dependencies

**File**: `package.json`

**Intent**: Add Vitest (≥3, Vite-7-compatible) as a devDependency and a `test` script. Keep it minimal — no `@testing-library`, no Playwright (Phase 4).

**Contract**: New devDep `vitest` (^3.x). New script `"test": "vitest run"` (and optionally `"test:watch": "vitest"`). The `test` script is what test-plan §5 references as the "unit + integration" gate.

#### 2. Vitest config

**File**: `vitest.config.ts` (new, repo root)

**Intent**: Configure a plain Node test environment that loads `.env.test` and never touches Astro virtual modules.

**Contract**: Minimal config — `test.environment: 'node'`, includes `tests/**/*.test.ts`. Loads `.env.test` into `process.env` before tests run (e.g. a `setupFiles`/`globalSetup` entry, or run via Node 22 `--env-file=.env.test`; implementer picks the mechanism). Does **not** wrap `getViteConfig`. No `astro:env` resolution.

#### 3. Test env convention

**Files**: `.env.test` (new, gitignored), `.env.example`, `.gitignore`

**Intent**: Establish the canonical test env source distinct from `.dev.vars`.

**Contract**: `.env.test` holds `SUPABASE_URL`, `SUPABASE_KEY` (anon/publishable), `SUPABASE_SERVICE_ROLE_KEY` for local (values from `npx supabase status`). Add `.env.test` to `.gitignore`. Document the three keys + "populate from `npx supabase status`" in `.env.example`.

#### 4. Shared client helper

**File**: `tests/helpers/supabase.ts` (new)

**Intent**: Build plain supabase-js clients for tests — an anon client factory (for per-identity sign-in in later phases) and a service_role client (for fixture reads/setup). Mirror the `supabase-admin.ts` pattern; read keys from `process.env`.

**Contract**: Exports e.g. `anonClient()` → `SupabaseClient` (anon key, `persistSession: false`) and `serviceClient()` → `SupabaseClient` (service_role key). Both via `createClient` from `@supabase/supabase-js`, URL + keys from `process.env`. **No import of `astro:env` or `src/lib/supabase.ts`.**

#### 5. Connectivity smoke test

**File**: `tests/integration/smoke.test.ts` (new)

**Intent**: Prove the harness reaches local Supabase and env wiring is correct — independent of the seed-password fix.

**Contract**: Using the service_role client, perform a trivial read (e.g. count seeded parents ≥ 2) and assert env vars are present. Fails loudly (not skips) if `SUPABASE_URL`/keys are unset, so a misconfigured env can't masquerade as a pass.

### Success Criteria

#### Automated Verification

- `npm test` exits 0 with the smoke test passing: `npm test`
- Lint passes on touched files: `npx eslint vitest.config.ts tests/`
- The suite imports no `astro:env` module (smoke run does not error on virtual-module resolution)

#### Manual Verification

- `npm run db:reset` then `npm test` is green from a clean local stack
- `.env.test` is gitignored (not shown in `git status`) and `.env.example` documents the three keys

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Fixture extension & auth enablement

### Overview

Make HTTP login possible (stamp passwords) and persist the multi-parent topology the isolation matrix needs, then reconcile every manual-proof row count the change disturbs. Extend the harness with a two-identity sign-in helper and prove both log in.

### Changes Required

#### 1. Seed passwords + multi-parent topology

**File**: `supabase/seed.sql`

**Intent**: Enable `signInWithPassword` for the test identities and persist the connected / pending / unconnected matrix as a durable fixture instead of per-block inline inserts.

**Contract**: After the existing inserts, (a) stamp a constant bcrypt password on the loginable test users via `update auth.users set encrypted_password = crypt('<const>', gen_salt('bf')) where id in (…)`; (b) add **Carol** (`…c01`) and **Dave** (`…d01`) as seeded parents (via the same `auth.users` insert pattern that fires the `on_auth_user_created` trigger); (c) add **one pending FC** between the viewer and Carol. Final topology relative to viewer Alice: **Bob = accepted** (connected arm), **Carol = pending** (pending arm), **Dave = no FC** (unconnected arm). Keep all inserts idempotent (`on conflict do nothing`). Use the same constant password referenced by `.verify-evidence` scripts (`test1234`) for continuity, or document the chosen constant.

#### 2. Reconcile the manual proof docs

**Files**: `supabase/tests/parents-rls.md`, `supabase/tests/friend-connections-rls.md`, `supabase/tests/meetings-rls.md`

**Intent**: The seed now provides Carol/Dave + a pending FC, so blocks that previously inlined them or assumed them absent must be re-verified and their expected counts updated. This is the cost of persisting the fixture (accepted decision).

**Contract**: Re-run every block from a clean `db:reset` and update each expected count that shifts. Known-affected (verify, don't assume the exact final numbers — derive them by running):

- `parents-rls.md` Block 1 (Alice's view) — pending Alice↔Carol widens `parents_select`, so Alice now also sees Carol (was 2).
- `friend-connections-rls.md` Block 1 (Alice's FC count) — Alice now has accepted-Bob + pending-Carol (was 1).
- `friend-connections-rls.md` Block 2 ("outsider sees 0 FC") — Carol is no longer an outsider; **switch the impersonated identity to Dave** (`…d01`, truly uninvolved) to preserve the block's intent (0 rows).
- Update the fixture-description header in each doc to reflect that Carol + Dave + the pending FC are now seeded (no longer "no fixture row").
- Confirm `meetings-rls.md` blocks (Alice/Bob/Dave) are unaffected — Dave as a seeded parent holds no meetings/invitations, so cross-table counts stay 1/1/0.

#### 3. Two-identity sign-in helper

**File**: `tests/helpers/supabase.ts`

**Intent**: Add a helper that returns an authenticated client for a given seeded email/password, so isolation tests can act as two distinct parents.

**Contract**: e.g. `signInAs(email, password)` → builds an anon client, calls `signInWithPassword`, asserts no error and that `getUser()` resolves to a non-null id, returns the authenticated client. The identity assertion here is the first line of defence against the silent-pass trap.

#### 4. Auth-enablement test

**File**: `tests/integration/auth.test.ts` (new)

**Intent**: Prove the seed-password fix works and two identities get distinct sessions.

**Contract**: Sign in as Alice and as Bob; assert each session's user id matches the expected UUID and the two differ.

### Success Criteria

#### Automated Verification

- `npm test` green including the auth test: `npm test`
- Both identities authenticate and resolve to distinct expected UUIDs
- Lint passes on touched files: `npx eslint tests/`

#### Manual Verification

- From a clean `npm run db:reset`, every block in all three `supabase/tests/*-rls.md` docs produces its (updated) expected result when pasted into Studio
- `friend-connections-rls.md` Block 2 now impersonates Dave and still returns 0 rows
- Seed remains idempotent across repeated `db:reset`

**Implementation Note**: Pause for manual confirmation that all three proof docs reconcile before proceeding to Phase 3.

---

## Phase 3: Privacy-isolation suite & cookbook

### Overview

Write the isolation suite over the three covered surfaces, each with the silent-pass guard and a no-identity negative control. Fill the cookbook and close the rollout row.

### Changes Required

#### 1. Parents isolation matrix

**File**: `tests/integration/parents-isolation.test.ts` (new)

**Intent**: Prove the connected/pending/unconnected matrix at the `parents` surface.

**Contract**: As Alice (authenticated): Bob (accepted) is visible; Dave (`…d01`, unconnected) is **not** visible (zero rows when selecting Dave's id); Carol (pending) **is** visible via `parents`. Each assertion preceded by an identity check. Expectations stated from the scenario, not the policy SQL.

#### 2. Pending-vs-`list_my_friends()` distinction

**File**: `tests/integration/parents-isolation.test.ts` (same file or a sibling)

**Intent**: Encode the subtle two-faces-of-connected behaviour as a first-class assertion.

**Contract**: As Alice: Carol (pending) appears in `SELECT … FROM parents WHERE id = Carol`, but `list_my_friends()` does **not** include Carol (it includes Bob). This is the behavioural difference research flagged as highest-value.

#### 3. Meetings + invitations cross-table isolation

**File**: `tests/integration/meetings-isolation.test.ts` (new)

**Intent**: Prove cross-table visibility (1 / 1 / 0) through the SECURITY DEFINER recursion-breakers, and that the SELECTs succeed (don't 500 from a recursion regression).

**Contract**: Create a meeting (Alice creator) + invite Bob — via the `create_meeting_with_invitations` RPC as Alice, or service_role inserts (not chained client calls). Assert: Alice (creator) sees the meeting and the invitation; Bob (invitee) sees both; Dave (uninvolved) sees zero of both. Each preceded by an identity check. Fixture created in test setup and cleaned up (or per-test, isolated from the seed topology).

#### 4. Silent-pass negative control

**File**: `tests/integration/parents-isolation.test.ts` (or a dedicated `guards.test.ts`)

**Intent**: Document and lock the `auth.uid()=null` failure mode.

**Contract**: A no-session anon client selecting parents returns zero rows — asserted **as the documented unauthenticated behaviour**, with a comment that a zero result from an authenticated isolation assertion must never be trusted without the identity guard.

#### 5. Cookbook + rollout status

**Files**: `context/foundation/test-plan.md`

**Intent**: Fill the cookbook entries this phase backs and advance the orchestrator state.

**Contract**: Replace §6.2 ("Adding an integration test (RLS / Supabase)") and §6.5 ("Adding a test for a new RLS policy / SECURITY DEFINER helper") placeholders with concrete guidance: test location (`tests/integration/`), the `signInAs` helper + identity-guard pattern, the multi-parent seed fixture, the "expectations from scenario not SQL" rule, and the run command (`npm test`). Optionally append a §6.6 note on the seed-reconciliation gotcha. Mark the §3 Phase 1 row `complete`.

### Success Criteria

#### Automated Verification

- `npm test` green with all isolation + negative-control tests passing: `npm test`
- Cross-table meeting/invitation SELECTs return without error for creator and invitee (no recursion regression)
- Lint passes on touched files: `npx eslint tests/`

#### Manual Verification

- The unconnected (Dave) assertion fails correctly if the identity guard is removed (spot-check: temporarily breaking the session surfaces a real failure, not a silent green)
- `test-plan.md` §6.2 / §6.5 read as actionable recipes and §3 Phase 1 is marked `complete`
- A reviewer can follow §6.2 to add a new RLS integration test without re-reading this plan

**Implementation Note**: Pause for manual confirmation before archiving the change.

---

## Testing Strategy

This change _is_ the testing infrastructure. Its own verification is meta:

### Integration Tests (the deliverable)

- Parents isolation matrix (connected / pending / unconnected)
- `parents` vs `list_my_friends()` pending distinction
- Meetings + invitations cross-table isolation (1 / 1 / 0)
- Silent-pass negative control

### Manual Testing Steps

1. `npm run db:reset && npm test` from a clean stack → all green.
2. Paste each `supabase/tests/*-rls.md` block into Studio → matches updated expected counts.
3. Temporarily strip the identity guard from one isolation test → it should turn red (proving the guard is load-bearing, not decorative).

## Performance Considerations

Negligible — a handful of integration tests against a local stack. Keep fixtures minimal; prefer the RPC/service_role for setup over many round-trips.

## Migration Notes

`supabase/seed.sql` changes are local-fixture only (no production migration). Re-applied on every `db:reset`. The password constant is a local test convenience and never ships to a deployed environment.

## References

- Research: `context/changes/testing-privacy-rls-isolation/research.md`
- Quality contract: `context/foundation/test-plan.md` §2 (Risk #1/#2), §3 Phase 1, §4 Stack, §5 Gates, §6.2/§6.5 cookbook
- Behavioural spec: `supabase/tests/{parents,friend-connections,meetings}-rls.md`
- Plain-client pattern: [src/lib/supabase-admin.ts:18-28](src/lib/supabase-admin.ts#L18-L28)
- Seed-password fix origin: `context/archive/2026-05-29-meeting-accept-with-conflict-and-list/reviews/plan-review.md:39-40`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Test-runner & harness bootstrap

#### Automated

- [x] 1.1 `npm test` exits 0 with the smoke test passing — 6297052
- [x] 1.2 Lint passes on touched files (`npx eslint vitest.config.ts tests/`) — 6297052
- [x] 1.3 Suite imports no `astro:env` module (no virtual-module resolution error) — 6297052

#### Manual

- [x] 1.4 `npm run db:reset` then `npm test` green from a clean local stack — 6297052
- [x] 1.5 `.env.test` is gitignored and `.env.example` documents the three keys — 6297052

### Phase 2: Fixture extension & auth enablement

#### Automated

- [x] 2.1 `npm test` green including the auth test — 5162e9c
- [x] 2.2 Both identities authenticate and resolve to distinct expected UUIDs — 5162e9c
- [x] 2.3 Lint passes on touched files (`npx eslint tests/`) — 5162e9c

#### Manual

- [x] 2.4 Every block in all three `*-rls.md` docs produces its updated expected result from a clean `db:reset` — 5162e9c
- [x] 2.5 `friend-connections-rls.md` Block 2 impersonates Dave and still returns 0 rows — 5162e9c
- [x] 2.6 Seed remains idempotent across repeated `db:reset` — 5162e9c

### Phase 3: Privacy-isolation suite & cookbook

#### Automated

- [x] 3.1 `npm test` green with all isolation + negative-control tests passing
- [x] 3.2 Cross-table meeting/invitation SELECTs return without error for creator and invitee
- [x] 3.3 Lint passes on touched files (`npx eslint tests/`)

#### Manual

- [x] 3.4 The unconnected (Dave) assertion turns red if the identity guard is removed
- [x] 3.5 `test-plan.md` §6.2 / §6.5 are actionable recipes and §3 Phase 1 is marked `complete`
- [x] 3.6 A reviewer can follow §6.2 to add a new RLS integration test without re-reading this plan
