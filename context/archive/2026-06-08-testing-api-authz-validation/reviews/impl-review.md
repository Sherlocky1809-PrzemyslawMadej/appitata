<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: API Authorization + Input-Validation Contract Tests

- **Plan**: context/changes/testing-api-authz-validation/plan.md
- **Scope**: Full plan (Phases 1–4 of 4)
- **Date**: 2026-06-09
- **Verdict**: NEEDS ATTENTION (all findings triaged + fixed)
- **Findings**: 0 critical, 2 warnings, 1 observation

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | PASS    |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | PASS    |

## Findings

### F1 — Server teardown is fire-and-forget + reuse-escape-hatch = silent stale-build trap

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (Reliability)
- **Location**: tests/setup/server.ts:65-85
- **Detail**: `teardown()` killed the preview without awaiting and swallowed failures. If a kill failed, the next run's reuse-if-reachable hatch would bind to the stale server and run the new suite against an old build — the one finding that could mask a real regression.
- **Fix**: Made `teardown` async; after `killTree` it polls `READY_URL` until the port stops responding (bounded `SHUTDOWN_TIMEOUT_MS = 10s`) and throws loudly if it doesn't. Both call sites now `await` it; `globalSetup` return type widened to `Promise<() => Promise<void>>`, reuse-hatch teardown made async.
- **Decision**: FIXED

### F2 — Implicit intra-file it-ordering dependency in invitations/respond block

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Reliability)
- **Location**: tests/integration/api/authz.test.ts:152-195
- **Detail**: The non-invitee deny cases (Carol/Dave → 404) rely on the shared invitation still being `pending`; Bob's accept permanently flips it, and the one-shot 404 depends on that flip. Correct today (in-file declaration order + `fileParallelism:false`), but a reorder / `.only` / `concurrent` would silently collapse the deny cases into the same 404 they assert.
- **Fix**: Added an explicit `ORDER-DEPENDENT BLOCK` comment above the describe documenting the shared-invitation dependency and the do-not-reorder/`.only`/`concurrent` constraint, with the "seed a dedicated invitation per case" escape route.
- **Decision**: FIXED

### F3 — Service-role key could surface in inherited preview stderr

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Security)
- **Location**: tests/setup/server.ts (~stdio inherit)
- **Detail**: The preview subprocess inherits stderr to surface startup failures; workerd reads `.dev.vars` incl. `SUPABASE_SERVICE_ROLE_KEY`. On a startup error that console output could contain bound secrets. MEMORY records the key as exposed & unrotated. Local-only; not a leak today.
- **Fix**: Added a one-line caution to test-plan §6.6 (Phase 2 note): never paste a raw `npm test` log into a shared issue / CI artifact without scrubbing.
- **Decision**: FIXED

## Notes

- No drift, no scope violations: zero `src/` changes (the `23503`→raw-500 leak documented-not-fixed as planned), no Supabase mocking, no friends/search IDOR matrix, no out-of-scope conflict/expiry/auth-scaffold/Playwright tests.
- HTTP silent-pass guard verified genuine: every 404 deny paired with an authenticated owner-success control against a real fixture row; `signInOverHttp` asserts `302→/` and fails loudly on bad login.
- Subprocess/no-`astro:`-import invariant holds; teardown filters by captured id with assert-zero (stronger than the sibling `meetings-isolation.test.ts`).
- Success criteria spot-checked at review time: `npm run typecheck` 0 errors, `npx eslint` clean on all touched files, prettier clean on docs. Full `npm test` integration suite was green at each phase's commit (c970f02 / 4a6e5bc / db4c030) and needs the live Docker Supabase stack to re-run.
