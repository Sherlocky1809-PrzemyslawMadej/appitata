# Test-runner bootstrap + privacy-boundary RLS isolation — Plan Brief

> Full plan: `context/changes/testing-privacy-rls-isolation/plan.md`
> Research: `context/changes/testing-privacy-rls-isolation/research.md`

## What & Why

This is **§3 Phase 1** of the project's test plan: stand up the **first automated test runner** (Vitest) and use it to prove the **privacy boundary** holds at the database — that a parent cannot read another circle's meetings, friends, or child details (Risk #1), and that cross-table meeting/invitation visibility is correctly scoped (read path of Risk #2). The boundary is a DB invariant enforced by RLS, so the suite must hit real local Supabase with RLS on, as two distinct authenticated parents — not mock the client.

## Starting Point

No test runner, config, or test deps exist. The boundary lives in four RLS SELECT policies on `authenticated`; isolation is proven today only by hand-run SQL blocks in `supabase/tests/*-rls.md`. The seed fixture has two accepted-connected parents with **empty passwords** (blocking HTTP login) and **no unconnected parent or pending FC** — exactly the rows the isolation matrix needs.

## Desired End State

`npm test` runs a green Vitest integration suite that signs in as two parents over HTTP and proves: connected parents are visible, unconnected parents return zero rows, and a pending-FC parent is visible via `parents` but not via `list_my_friends()` — every zero-row assertion guarded against the silent `auth.uid()=null` pass. The cookbook (§6.2/§6.5) documents how to add the next RLS test.

## Key Decisions Made

| Decision              | Choice                                                                     | Why                                                                            | Source   |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------- |
| Identity technique    | HTTP `signInWithPassword` (two anon clients)                               | Exercises the full app path (PostgREST + RLS + auth), matches Risk #2 intent   | Plan     |
| Seed-password fix     | Owned by this change (pre-specified `crypt()` line)                        | Required for HTTP login; empty seed passwords block it today                   | Research |
| Fixture provisioning  | Persist Carol + a pending FC in `seed.sql`                                 | Matches how every manual proof is written; one shared fixture from `db:reset`  | Plan     |
| Test env source       | New `.env.test` (gitignored)                                               | Explicit test-only source that won't drift with the Cloudflare-dev `.dev.vars` | Plan     |
| CI scope              | `npm test` + local run only; CI job → Phase 4                              | Keeps Phase 1 bounded; Actions-side Supabase boot is its own non-trivial chunk | Plan     |
| Coverage              | parents matrix + meetings/invitations 1/1/0 + pending-vs-`list_my_friends` | The Risk #1 core + Risk #2 read path + the subtlest trap                       | Plan     |
| Silent-pass guard     | Per-assertion identity check + no-identity negative control                | Neutralises the #1 trap: an unauthenticated query returns zero and looks green | Plan     |
| Vitest config surface | Minimal `process.env`-based (no `getViteConfig`)                           | Suite is HTTP-only and never imports an Astro module                           | Research |

## Scope

**In scope:** Vitest bootstrap (config, `.env.test`, `npm test`); plain supabase-js client helpers (no `astro:env`); seed-password fix + Carol/Dave + pending FC; reconciling the three `*-rls.md` proof docs; parents isolation matrix; meetings+invitations cross-table isolation; pending-vs-`list_my_friends` distinction; silent-pass guard + negative control; cookbook §6.2/§6.5.

**Out of scope:** Write-path/mutation authorization (Phase 2); conflict-overlap & expiry (Phase 3); e2e, secret-isolation static check, CI Supabase-boot job (Phase 4); any RLS migration change.

## Architecture / Approach

Tests under `tests/integration/` with shared helpers in `tests/helpers/`; Vitest config at repo root. All Supabase clients are built plain from `process.env` (mirroring `src/lib/supabase-admin.ts`), sidestepping the `astro:env/server` virtual-module trap. Two anon clients sign in as distinct parents; a service_role client does fixture setup. Expectations are drawn from the _scenario_, never copied from the policy SQL (the oracle problem).

## Phases at a Glance

| Phase                                 | What it delivers                                               | Key risk                                                                    |
| ------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1. Test-runner & harness bootstrap    | Vitest, config, `.env.test`, `npm test`, client helper + smoke | Vite-7 pin forces Vitest ≥3; `astro:env` import must be avoided             |
| 2. Fixture extension & auth enable    | Seed passwords + Carol/Dave/pending FC; reconcile `*-rls.md`   | Seeding mutates shared fixture — existing proof counts shift (esp. Block 2) |
| 3. Privacy-isolation suite & cookbook | Isolation tests + silent-pass guard; fill cookbook; close row  | A zero-row "pass" that's really an unauthenticated query                    |

**Prerequisites:** Docker + local Supabase (`npx supabase start`); keys from `npx supabase status`.
**Estimated effort:** ~2–3 sessions across 3 phases.

## Open Risks & Assumptions

- Seeding Carol + a pending FC breaks specific manual-proof counts (notably `friend-connections-rls.md` Block 2, which uses Carol as the "outsider"); Phase 2 must reconcile them by re-running each block — exact final counts derived by running, not assumed.
- The pending arm and the unconnected arm must be different parents (a pending-FC parent is _visible_ via `parents`, so cannot also be the "invisible" arm).
- Assumes local Supabase `enable_confirmations = false` (confirmed) so seeded users need no email-confirm step.

## Success Criteria (Summary)

- `npm test` green from a clean `npm run db:reset`, with isolation + negative-control tests passing.
- An unconnected parent returns zero rows; a pending parent is visible via `parents` but absent from `list_my_friends()`; removing the identity guard turns a test red.
- All three `*-rls.md` proofs reconcile by hand; test-plan §6.2/§6.5 are actionable and §3 Phase 1 is marked `complete`.
