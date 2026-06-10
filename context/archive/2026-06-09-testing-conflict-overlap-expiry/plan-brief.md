# Conflict-Overlap & 24h Invitation-Expiry Tests — Plan Brief

> Full plan: `context/changes/testing-conflict-overlap-expiry/plan.md`
> Research: `context/changes/testing-conflict-overlap-expiry/research.md`

## What & Why

Test-plan **Phase 3**: prove the two guardrails the happy path hides — **Risk #3** (a time clash is surfaced before a meeting is confirmed — no silent double-booking) and **Risk #5** (an unanswered invitation expires and stops being actionable past 24h). Today neither has automated coverage, and the conflict math can't be unit-tested where it lives.

## Starting Point

The conflict-overlap algorithm is inline, non-exported `.astro` frontmatter (`meetings.astro:23-85`) — reachable only by rendering the page. The 24h expiry is already enforced in three coupled layers (sweep RPC `<24h`, RLS USING `>24h` lazy accept-block, page read filter), all keyed on `invited_at`. Phases 1-2 built an integration-only Vitest harness (`signInAs`/`serviceClient`, HTTP cookie-jar, build-and-serve globalSetup) but no `tests/unit/` and no behavioural oracle for conflict/expiry.

## Desired End State

`npm test` runs a fast **unit** project (no server) proving the overlap algorithm's boundary cases directly, plus an **integration** project where one test proves `/meetings` wires the helper (conflict-warning DOM) and a suite proves the expiry sweep predicate, idempotency, and the lazy RLS accept-block. `meetings.astro` renders identically to before. A new `supabase/tests/invitation-expiry.md` is the spec the expiry tests cite.

## Key Decisions Made

| Decision            | Choice                                                                 | Why                                                                                           | Source          |
| ------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------- |
| Conflict unit seam  | Extract overlap math to pure `src/lib/conflicts.ts`                    | Inline frontmatter has no unit seam; honors §6.1 "pure-logic unit" without the tautology trap | Research → Plan |
| Extraction scope    | Whole builder `computeConflictsByInvitationId` (+ `endsAt`/`overlaps`) | Unit-covers self-exclusion + multi-clash mapping, not just the 2-line predicate               | Plan            |
| Unit test isolation | Split vitest into `unit` (no globalSetup) + `integration` projects     | Pure logic runs in ms without building/serving Astro; fast feedback                           | Plan            |
| Expiry fixtures     | RPC-create then `serviceClient().update({invited_at})` to backdate     | Reuses the validated creation path; only the timestamp is synthetic                           | Research → Plan |
| Risk #3 coverage    | Unit + one render-level integration assertion                          | Proves page→helper wiring the unit can't; satisfies "unit + one integration"                  | Plan            |
| Expiry oracle       | Author `supabase/tests/invitation-expiry.md`                           | Matches the "expectations from scenario doc, not SQL" convention                              | Plan            |

## Scope

**In scope:** pure conflict helper + behaviour-identical `meetings.astro` refactor; vitest projects split; conflict unit tests; one conflict render assertion; expiry oracle doc; expiry integration tests (sweep predicate, idempotency, `responded_at`-null, lazy RLS block, exact-24h limbo).

**Out of scope:** any conflict behaviour change; e2e/Playwright (Phase 4); the Cron→`scheduled()` trigger (deploy-only); changing the 24h window or any migration; component-internal render tests; touching the other proof docs.

## Architecture / Approach

Phase 1 (Risk #3): lift `meetings.astro:23-85` verbatim into `src/lib/conflicts.ts`, repoint the frontmatter (single `endsAt` for both conflict scan and upcoming/past split — the S-03 anti-drift invariant), add vitest `unit`/`integration` projects, unit-test the algorithm, add one `/meetings` DOM assertion via the HTTP jar. Phase 2 (Risk #5): write the oracle doc, then integration-test the live sweep RPC via `serviceClient()` (service_role-only) and the lazy-expiry RLS via the real respond endpoint over HTTP, with RPC-then-backdate fixtures and residual-row teardown.

## Phases at a Glance

| Phase                          | What it delivers                                                              | Key risk                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1. Conflict-overlap (Risk #3)  | Pure helper + page refactor + vitest split + unit tests + 1 render assertion  | The refactor must not change rendered output                             |
| 2. Invitation expiry (Risk #5) | Oracle doc + integration tests (sweep, idempotency, lazy RLS block, 24h edge) | Backdate fixture must reflect real rows; silent-pass guard on deny cases |

**Prerequisites:** local Supabase up (`npx supabase start` + `npm run db:reset`); `.env.test` populated (`SUPABASE_URL`/`SUPABASE_KEY`/`SUPABASE_SERVICE_ROLE_KEY`).
**Estimated effort:** ~2 sessions, one per phase.

## Open Risks & Assumptions

- The extraction is behaviour-preserving — verified by an unchanged `/meetings` render, not just green tests.
- The lazy RLS block (stale accept → 404 pre-sweep) is the load-bearing expiry assertion; it must run against a real backdated fixture row with a paired fresh-invite 200 control, or a non-owner/anonymous 404 could masquerade as a pass.
- Windows/CRLF: lint only touched paths (`npx eslint <files>`), per the repo posture.

## Success Criteria (Summary)

- A unit test fails if the overlap algorithm regresses (equal-start, back-to-back, multi-clash, self-exclusion) — independent of the page.
- An integration test fails if `/meetings` stops showing the conflict warning for an overlapping invite.
- An integration test fails if a >24h invite can still be accepted, if the sweep isn't idempotent, or if expiry stamps `responded_at`.
