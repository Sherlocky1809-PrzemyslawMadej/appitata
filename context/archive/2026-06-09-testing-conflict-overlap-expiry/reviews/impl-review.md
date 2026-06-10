<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Conflict-Overlap & 24h Invitation-Expiry Tests

- **Plan**: context/changes/testing-conflict-overlap-expiry/plan.md
- **Scope**: Full plan (Phase 1 + Phase 2)
- **Date**: 2026-06-10
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 1 observation

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | PASS    |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | PASS    |

Both review agents independently confirmed: the `src/lib/conflicts.ts` extraction is
behaviour-identical to the pre-refactor inline math (verified against commit `b69800f`:
`mStart < piEnd && piStart < mEnd`, half-open with self-exclusion); all "What We're NOT
Doing" guardrails hold (no migration/24h-window changes, no Playwright, no component
isolation test); and the user-approved exact-24h reframe is implemented coherently across
the oracle doc (block 6) and the test (boundary→404 + under-24h-stays-pending), with no live
assertion of the impossible frozen-clock instant. Success criteria verified green this
session (lint clean; expiry suite 6/6; full suite 73/73; Phase 1 build/unit at `35a8ed2`).

## Findings

### F1 — Boundary fixture aged to exactly now()-24h leaves the thinnest margin

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (test reliability)
- **Location**: tests/integration/invitation-expiry.test.ts:106
- **Detail**: The boundary invite was aged to exactly `Date.now() - 24h` (client clock) and
  asserted un-acceptable (→404) by the DB-clock predicate `invited_at > now()-24h`. Robust on
  this local/CI single-clock harness, but it was the only assertion leaning on elapsed
  wall-time and the margin was sub-second-thin.
- **Fix**: Age the boundary row to `24 * HOUR_MS + 60_000` (1 min past the edge). Fail-closed
  semantic and oracle block-6 observable unchanged; the sweep's strict lower edge is already
  covered independently by the now()-23h `under` row. Oracle doc fixture bullet updated to
  match.
- **Decision**: FIXED (re-ran expiry suite → 6/6 green)

### F2 — Idempotency `2nd sweep === 0` is a whole-DB invariant, not row-scoped

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (test reliability)
- **Location**: tests/integration/invitation-expiry.test.ts:196-200
- **Detail**: The second-sweep `toBe(0)` holds only because no pending invite anywhere in the
  DB is >24h old at that moment (true today: serial files + per-file cleanup + no stale seed
  rows). Coupled to global DB state, so a future author who weakens `fileParallelism` could
  break it.
- **Fix**: Added a clarifying comment noting the `=== 0` is a whole-DB invariant dependent on
  serial execution.
- **Decision**: FIXED (comment-only)
