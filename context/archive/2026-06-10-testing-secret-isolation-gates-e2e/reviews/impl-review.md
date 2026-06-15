<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Secret Isolation, Quality-Gate Wiring & North-Star E2E

- **Plan**: context/changes/testing-secret-isolation-gates-e2e/plan.md
- **Scope**: All 4 phases
- **Date**: 2026-06-15
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 4 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | PASS    |
| Safety & Quality    | PASS    |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | PASS    |

## Highlights

- All 4 phases verdict MATCH — no DRIFT, MISSING, or problematic EXTRA.
- Two intentional improvements over the plan's literal text: e2e shipped as the canonical `tests/e2e/seed.spec.ts` (+ `auth.setup.ts` storageState project, `E2E-RULES.md`), and per-test id-tracked cleanup instead of a global `public.meetings` wipe (stricter test-independence; codified in §6.3).
- Secret isolation is genuinely fail-closed: the import scan asserts the importer set EQUALS `{src/worker.ts}` (allow-list, verified non-vacuous against the live import graph); storageState cookie files are gitignored AND untracked; no secret is logged.
- All "What We're NOT Doing" boundaries respected (no key rotation, no Supabase in CI, no e2e/integration in CI/pre-push, no ESLint rule, `.verify-evidence/` untracked).
- Automated gates green at review time: `npm run test:unit` 14/14 (incl. 2 secret-isolation tests), `npm run typecheck` 0 errors. E2e is the documented manual/pre-merge gate (verified in commit a6d2876).
- One reasonable out-of-plan file: `src/components/friends/FriendSearch.tsx` (commit b8c1bd7) — a behavior-preserving lint unblock directly caused by this change wiring `npm run lint` into CI. Justified.

## Findings

### F1 — E2e runs in no automated gate (by design)

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: .github/workflows/ci.yml, .husky/pre-push
- **Detail**: The e2e suite is invoked by neither CI nor pre-push — only `npm run test:e2e` manually. Despite the change title, this is the documented decision (plan "What We're NOT Doing"; test-plan §5 lists e2e as "local (pre-merge)"). Resolves CLEAN.
- **Fix**: None needed — by design.
- **Decision**: SKIPPED (by design)

### F2 — Secret-isolation import scan doesn't cover require()/CJS

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: tests/unit/secret-isolation.test.ts:42-53
- **Detail**: The specifier regex catches ESM `import`, dynamic `import()`, and `export … from` re-exports (the realistic leak vectors in this pure-ESM Astro/Vite project), but not CJS `require("@/lib/supabase-admin")`. No `require` exists in src/\*\* today — theoretical hardening only.
- **Fix**: Optionally add `require\(` to the specifier set to fail-close against a future CJS-interop file.
- **Decision**: SKIPPED

### F3 — E2e afterEach delete status unchecked

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Reliability)
- **Location**: tests/e2e/seed.spec.ts:56-61
- **Detail**: The cleanup loop `await alice.delete(...)` ignores the response status, so a failed delete silently leaks a fixture row into the shared local DB — softly contradicting the file's "re-run starts clean" promise. Mitigated by the per-run `crypto.randomUUID()` tag and consistent with the integration suite's log-but-don't-throw teardown convention.
- **Fix**: Optionally assert `[200,204].includes(res.status())` or `console.warn` on a non-2xx delete.
- **Decision**: SKIPPED

### F4 — §5 "lint + typecheck → local + CI" slightly overstates CI

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency (doc accuracy)
- **Location**: context/foundation/test-plan.md:111
- **Detail**: CI (ci.yml) runs `npm run lint` explicitly but has no standalone `typecheck` step — typecheck runs at pre-push and is covered implicitly by `astro build` in CI. Pre-existing row (outside this phase's contract), but worth correcting in a doc-reconciliation phase.
- **Fix**: Reworded the `Where` cell to "lint: local + CI; typecheck: local (pre-push) + CI build".
- **Decision**: FIXED
