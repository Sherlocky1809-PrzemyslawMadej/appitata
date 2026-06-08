<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Test-runner bootstrap + privacy-boundary RLS isolation

- **Plan**: context/changes/testing-privacy-rls-isolation/plan.md
- **Scope**: Phases 1–3 of 3 (full plan)
- **Date**: 2026-06-08
- **Verdict**: APPROVED (with 2 minor latent-hardening warnings)
- **Findings**: 0 critical, 2 warnings, 2 observations

## Verdicts

| Dimension           | Verdict                              |
| ------------------- | ------------------------------------ |
| Plan Adherence      | PASS                                 |
| Scope Discipline    | PASS                                 |
| Safety & Quality    | WARNING                              |
| Architecture        | PASS                                 |
| Pattern Consistency | PASS                                 |
| Success Criteria    | PASS (13/13 tests green, lint clean) |

## Findings

### F1 — Vitest file-parallelism unconstrained around a shared-DB fixture

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (reliability)
- **Location**: tests/integration/meetings-isolation.test.ts:43-71 + vitest.config.ts
- **Detail**: The meetings fixture inserts a real row in beforeAll and deletes it in afterAll. Vitest runs test FILES in parallel worker threads by default and the config pins no fileParallelism / sequence constraint. Safe today (every assertion filters on the unique meetingId; no other file does an unfiltered meetings count) — a LATENT race, not a present bug. A future file asserting an unfiltered meetings/invitations count would race this fixture.
- **Fix**: Add `test: { fileParallelism: false }` to vitest.config.ts (or a poolOptions singleThread / sequence constraint).
  - Strength: Cheap one-line config; removes the race class before the suite grows. Shared-DB integration tests are inherently order-sensitive, so serial files is the safer default.
  - Tradeoff: Slightly slower suite — negligible at 4 files.
  - Confidence: HIGH — config-level, no test logic touched.
  - Blind spot: None significant.
- **Decision**: FIXED — added `test.fileParallelism: false` to vitest.config.ts.

### F2 — afterAll teardown ignores the delete error

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (reliability)
- **Location**: tests/integration/meetings-isolation.test.ts:66-71
- **Detail**: afterAll issues a service-client DELETE but discards the returned `{ error }`. If the delete silently fails, the fixture row leaks into the next run. The insert path checks its error; the teardown does not.
- **Fix**: Capture and surface the delete error (`const { error } = await serviceClient()...; if (error) console.warn(...)`).
- **Decision**: FIXED — teardown now captures `{ error }` and `console.warn`s on failure (with a single-line eslint-disable for the intentional console).

### F3 — Header comment label "Risk #2" is ambiguous

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency (docs)
- **Location**: tests/integration/meetings-isolation.test.ts:1-16
- **Detail**: Header says "Risk #2 cross-table visibility." Matches the test-plan risk map (Risk #2 = authorization/IDOR, read path), which the plan covers as "#2 (read path)" — technically correct. But AGENTS.md's load-bearing invariant #2 is "no silent double-booking," which this file does NOT test. A reader cross-referencing AGENTS.md could misread the label.
- **Fix**: Tighten to "Risk #1 cross-table read isolation (test-plan Risk #2 read path)" or add a one-line "double-booking/conflict deferred to §3 Phase 3".
- **Decision**: FIXED — header now names test-plan Risk #1/#2-read-path and notes the double-booking invariant is deferred to §3 Phase 3.

### F4 — Hardcoded future timestamp in the fixture

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (reliability)
- **Location**: tests/integration/meetings-isolation.test.ts:54
- **Detail**: p_starts_at is the fixed date 2026-07-15. Harmless today (assertions filter by meetingId, never on upcoming/past), but a known time-bomb class if a future test in this file ever asserts on upcoming/past partitioning.
- **Fix**: Leave as-is for now; switch to a now()+interval-style relative time only if upcoming/past logic enters this file.
- **Decision**: SKIPPED — harmless today (assertions filter by meetingId); revisit only if upcoming/past partitioning enters this file.
