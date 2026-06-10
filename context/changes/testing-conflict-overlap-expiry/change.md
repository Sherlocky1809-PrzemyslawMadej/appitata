---
change_id: testing-conflict-overlap-expiry
title: Testing conflict overlap expiry
status: impl_reviewed
created: 2026-06-09
updated: 2026-06-10
archived_at: null
---

## Notes

Phase 3 of the frozen test rollout (`test-plan.md` §3) — Risks #3 (conflict overlap) & #5 (24h expiry); types: unit + integration.

**Scoping decision (2026-06-09):** Risk #3 conflict math is inline in `meetings.astro` frontmatter with no unit seam. Reversed the initial "test as-is" call — `/10x-plan` should include a **small extraction** of the overlap predicate + `endsAt` into a pure exported helper (e.g. `src/lib/conflicts.ts`) so it can be unit-tested per §6.1, keeping `meetings.astro` behaviour identical and one render-level integration check. Expiry (Risk #5) is tested via the `expire_stale_invitations()` RPC through `serviceClient()`; cron→`scheduled()` is deploy-only and out of scope. See `research.md` Open Questions for the full rationale and the expiry-fixture backdating note.
