---
change_id: meetings-23503-fk-error-leak
title: Map 23503 FK-violation to a safe 404 in POST /api/meetings (close the raw-500 leak)
status: implemented
created: 2026-06-15
updated: 2026-06-15
archived_at: null
---

## Notes

Close the latent raw-500 secret-leak documented in `context/foundation/test-plan.md` §6.6 and `context/foundation/lessons.md` ("Map every errcode an RPC/RLS path can raise, or it leaks a raw-500").

**The leak**: `src/pages/api/meetings/index.ts` maps `23505`/`23514`/`42501`/`22023` (+ RPC message strings) but not `23503` (FK violation). An unmapped `23503` falls through to `return json({ error: error.message }, 500)` and leaks the raw Postgres message (`relation`/`constraint`/SQLSTATE text). The sibling `src/pages/api/friends/request.ts:79` already maps `23503` → 404.

**Trigger**: a parent (creator or invitee) deleted in the window between the RPC's `is_connected` check and its FK insert — a mid-transaction race, impractical to reproduce deterministically through the public RPC (confirmed: `parents → auth.users` and `friend_connections → parents` are both `on delete cascade`, so a passing `is_connected` guarantees the parent exists at check time; only concurrency can break it).

**Approach (m3l5 debugging-as-test)**: extract the inline error ladder into a pure, importable `mapCreateMeetingError(error)` helper, then write a deterministic **unit** test that feeds it a `23503`-coded error and asserts `{ status: 404, safe body }` (no `constraint`/`relation`/SQLSTATE text). RED before the fix, GREEN after adding the `23503` branch. This also hardens the fragile message-string mapping flagged in test-plan §6.4 by making it unit-testable. Drive red→green→refactor via `/10x-tdd`.

**Out of scope**: the concurrency-choreographed integration repro (rejected as flaky per §6.6); any other errcode beyond auditing the ladder for completeness.
