<!-- PLAN-REVIEW-REPORT -->

# Plan Review: Friend Connection Handshake Implementation Plan

- **Plan**: `context/changes/friend-connection-handshake/plan.md`
- **Mode**: Deep
- **Date**: 2026-05-27
- **Verdict (pre-triage)**: REVISE
- **Verdict (post-triage)**: SOUND — all CRITICAL/WARNING findings fixed; F5 consciously accepted
- **Findings**: 1 critical, 2 warnings, 2 observations

## Verdicts

| Dimension             | Pre-triage | Post-triage |
| --------------------- | ---------- | ----------- |
| End-State Alignment   | WARNING    | PASS        |
| Lean Execution        | PASS       | PASS        |
| Architectural Fitness | PASS       | PASS        |
| Blind Spots           | FAIL       | PASS        |
| Plan Completeness     | WARNING    | PASS        |

## Grounding

6/6 existing paths ✓, 4/4 new paths free ✓, key symbols (`is_connected`, `handle_new_user`, `parents_select`, `PROTECTED_ROUTES`, `context.locals.user`) match plan claims ✓, brief↔plan consistency ✓, no `docs/reference/contract-surfaces.md` (skipped).

## Findings

### F1 — Pending FC rows can't render requester/addressee details under current parents RLS

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment + Blind Spots
- **Location**: Phase 1 migration (`is_connected` body & `parents_select` policy) ↔ Phase 3 `friends.astro` list queries
- **Detail**: F-01's `parents_select` policy is `using ( public.is_connected(auth.uid(), id) )`. The S-01 plan extends `is_connected` to return true only for ACCEPTED FC rows (or self). Phase 3's nested-select join `friend_connections → parents` therefore returns null for the embedded `requester`/`addressee` field on any PENDING FC row — the Incoming/Outgoing lists can't render display_names. UX is broken without a fix.
- **Fix A ⭐ Recommended**: Extend `parents_select` with a second OR-branch allowing SELECT when a PENDING FC exists in either direction; keep `is_connected` pure ("accepted or self"); tighten Phase 3 connected-list query to explicitly filter via `is_connected(auth.uid(), id) AND id <> auth.uid()` (otherwise pending-only parents leak in).
  - Strength: Smallest change consistent with F-01's pattern; keeps `is_connected` semantically clean; pending-visibility scopes exactly to the two parties.
  - Tradeoff: `parents_select` becomes a 2-branch OR with a subquery; negligible at MVP scale.
  - Confidence: HIGH — standard PostgREST + RLS pattern.
  - Blind spot: New `friend-connections-rls.md` needs an extra block proving pending-visibility scope is correct.
- **Fix B**: Add a `SECURITY DEFINER` RPC `list_my_pending_with_handles()` returning the joined FC + parent display_name; use it instead of nested-select.
  - Strength: Keeps `parents_select` unchanged.
  - Tradeoff: Two new RPCs (incoming + outgoing); loses the natural supabase-js nested-select pattern.
  - Confidence: HIGH on correctness; MED on ergonomics.
  - Blind spot: RPC return types need careful shaping for `database.types.ts`.
- **Decision**: FIXED via Fix A. Plan edits applied: (1) Phase 1 migration SQL gains an `alter policy parents_select … using (…)` block widening to pending-OR; (2) a second SECURITY DEFINER RPC `public.list_my_friends()` was added to the Phase 1 migration alongside `find_parent_by_handle` (used by Phase 3's connected-list query); (3) `friend-connections-rls.md` grew from 4 to 6 blocks (added pending-state UPDATE policy block + pending-FC-widens-parents_select scope block); (4) Phase 1 manual verification 1.9 and the §Success Criteria reference now say "six" not "four".

### F2 — Already-connected parents can still send each other new pending requests via the API

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 — `POST /api/friends/request`
- **Detail**: `UNIQUE(requester_id, addressee_id)` blocks duplicates from the same direction but not the reverse. Scenario: A→B accepted; B's UI searches for A and clicks Send request; B→A is a different tuple, UNIQUE allows the INSERT. Result: A sees a stale pending request from B even though they're already friends.
- **Fix**: Pre-INSERT guard in the handler — call `is_connected(auth.uid(), addressee_id)`; if true, return `409 { error: "already connected" }`. One extra round trip, no schema change.
- **Decision**: FIXED. Plan edits applied: (1) Phase 2 #4 Contract now documents the pre-INSERT guard explicitly; (2) Progress row 2.6 now covers the new 409-with-"already connected" case alongside the existing duplicate-from-same-direction 409.

### F3 — AGENTS.md refresh missing from the plan

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW
- **Dimension**: Plan Completeness
- **Location**: Plan body — no §AGENTS.md update in any phase
- **Detail**: F-01 deliberately landed an AGENTS.md refresh in its Phase 2 (§Current state acknowledged the new parents table + is_connected; §Key conventions added the RLS-template bullet). S-01 adds `friend_connections`, extends `is_connected`, adds two RPCs (`find_parent_by_handle`, `list_my_friends`), and introduces the column-level GRANT hardening pattern — all worth surfacing to future agents, but the plan had no phase touching AGENTS.md.
- **Fix**: Add an AGENTS.md edit item to Phase 3 covering §Current state (acknowledge `friend_connections` + extended `is_connected` + the two RPCs + `parents_select` pending-OR branch) and §Key conventions (new "Search/list RPCs" bullet + "Column-level partial-UPDATE GRANT" bullet).
- **Decision**: FIXED. Plan edits applied: (1) new Phase 3 §"Changes Required" #8 documents the AGENTS.md edit shape; (2) Phase 3 manual verification gained a 7th bullet (AGENTS.md diff readability); (3) Progress row 3.10 added.

### F4 — friend-connections-rls.md missing a pending-state RLS test block

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — `supabase/tests/friend-connections-rls.md`
- **Detail**: The four planned SQL blocks cover the accepted case, outsider blindness, the RPC, and column-level write isolation — but none exercises the pending-state RLS, which is exactly where F1 surfaced.
- **Fix**: Add a 5th block proving "as Bob (addressee) with a pending FC from Alice, `UPDATE status='accepted'` succeeds; as Carol (uninvolved), the same UPDATE affects 0 rows".
- **Decision**: RESOLVED BY F1's fix. F1's plan edit already grew the doc from 4 to 6 blocks, including the pending-state UPDATE block and the pending-FC-widens-parents_select scope block. No further action.

### F5 — Both-directions-pending race condition unhandled

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Blind Spots
- **Location**: Phase 2 — `POST /api/friends/request`
- **Detail**: A and B both initiate friend requests near-simultaneously (A→B pending + B→A pending). When the first accept fires, an accepted FC row exists; the OTHER pending row remains — stale pending between two already-connected parents. Harmless data-wise (`is_connected` returns true regardless), purely a UX wart.
- **Fix**: Extend F2's guard to ALSO refuse if a reverse-direction pending FC exists with a friendlier "they have already requested you — check Incoming" hint. Or tolerate.
- **Decision**: ACCEPTED. Vanishingly unlikely at MVP scale; F2's post-accept guard already cleans up the larger pathology; the remaining race window is brief and harmless. Revisit if real users hit it.
