<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: 24h Invitation Expiry Cron Backstop

- **Plan**: context/changes/invitation-expiry-cron-backstop/plan.md
- **Scope**: All phases (3 of 3)
- **Date**: 2026-06-02
- **Verdict**: APPROVED (with 2 minor warnings)
- **Findings**: 0 critical, 2 warnings, 1 observation

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | PASS    |
| Safety & Quality    | PASS    |
| Architecture        | WARNING |
| Pattern Consistency | PASS    |
| Success Criteria    | WARNING |

## Live verification performed

- `expire_stale_invitations` is `security definer`, `search_path = public, pg_temp`, returns `integer`; EXECUTE granted only to `service_role` (+ owner). Locked down correctly.
- Sweep correct + idempotent against the running local DB (first call expired stale rows; second returned 0).
- Recreated `meeting_invitations_update` policy is byte-faithful to the S-03 original plus the single freshness predicate (`invited_at > now() - interval '24 hours'` added to USING; WITH CHECK unchanged).
- `npx eslint src/worker.ts src/lib/supabase-admin.ts src/pages/meetings.astro` passed (exit 0).
- Service-role key isolation confirmed: `supabase-admin.ts` imported only by `worker.ts`, reads from Worker `env` (not `astro:env/server`), never on the request/client path.

## Findings

### F1 — Step 2.7 marked done but epilogue says "left intentionally pending"

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/invitation-expiry-cron-backstop/plan.md:282 (vs change.md:21)
- **Detail**: Progress marked `2.7 wrangler deploy registers the daily cron trigger — ea5cb54` as [x] complete with a commit sha, but the change.md epilogue says the real Cron-Trigger → scheduled() invocation "can only be exercised on a real deploy … left intentionally pending." The checkbox overstated what was verified on a human-gated deploy step. (Sibling 2.6 was handled correctly with a documented alternative probe.)
- **Fix**: Flip 2.7 to `- [ ]`, drop the sha, annotate as blocked on the human-only `wrangler deploy`.
- **Decision**: FIXED (plan.md:282 flipped to `- [ ]` with deploy-gated note)

### F2 — 24h expiry window duplicated across three layers, no shared constant

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architecture
- **Location**: supabase/migrations/20260601120000_invitation_expiry_sweep.sql:36,58 + src/pages/meetings.astro:50
- **Detail**: The 24h cutoff is encoded independently in the sweep RPC (SQL), the RLS `meeting_invitations_update` USING clause (SQL), and meetings.astro (JS). They agree today (all exclusive boundaries), but a future change to the window must touch all three in lockstep or the layers silently disagree. Defense-in-depth is correct; the magic-number triplication is the cost.
- **Fix A ⭐ Recommended**: Accept as-is for MVP; record the "change all three together" coupling as a /10x-lesson.
  - Strength: Window is a stable product rule (FR-008), not a tunable knob; centralizing a literal across SQL/JS is awkward and premature.
  - Tradeoff: Coupling stays implicit; relies on the lesson being read.
  - Confidence: HIGH — matches how this repo treats stable invariants.
  - Blind spot: None significant.
- **Fix B**: Centralize the window now (DB setting or generated constant spanning SQL+JS).
  - Strength: Single source of truth.
  - Tradeoff: SQL and JS can't share a literal cleanly; real complexity for a rarely-changing value.
  - Confidence: MED.
  - Blind spot: No design yet for how SQL reads a shared TS const.
- **Decision**: ACCEPTED-AS-RULE: "The 24h invitation-expiry window is encoded in three layers — change them together" (appended to context/foundation/lessons.md). Code left as-is (Fix A; user declined the Fix B code change).

### F3 — Exact-24h instant falls in a one-moment no-op gap

- **Severity**: 📋 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260601120000_invitation_expiry_sweep.sql:36,58
- **Detail**: Sweep expires `invited_at < now() - 24h` (exclusive); RLS allows accept where `invited_at > now() - 24h` (exclusive). A row at exactly `now() - 24h` is neither swept nor acceptable for one sub-microsecond instant. Harmless — next `now()` moves it past the boundary and the next sweep catches it; matches the plan's exclusive boundary.
- **Fix**: None recommended.
- **Decision**: SKIPPED (acknowledged; harmless boundary artifact)
