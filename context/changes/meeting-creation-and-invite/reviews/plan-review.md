<!-- PLAN-REVIEW-REPORT -->

# Plan Review: Meeting Creation and Invite (S-02)

- **Plan**: `context/changes/meeting-creation-and-invite/plan.md`
- **Mode**: Deep
- **Date**: 2026-05-28
- **Verdict**: SOUND (minor cleanup before implement; no architectural blockers)
- **Findings**: 0 critical · 2 warnings · 2 observations

## Verdicts

| Dimension             | Verdict |
| --------------------- | ------- |
| End-State Alignment   | PASS    |
| Lean Execution        | PASS    |
| Architectural Fitness | WARNING |
| Blind Spots           | PASS    |
| Plan Completeness     | WARNING |

## Grounding

13/13 paths ✓, 6/6 verified claims hold ✓, brief↔plan ✓. Blast radius: zero existing references to planned names; no callers of middleware/dashboard/AGENTS.md/database.types.ts at risk.

## Findings

### F1 — Success criterion 1.10 contains internal-monologue parenthetical

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: plan.md Phase 1 §Manual Verification, bullet "1.10"
- **Detail**: The bullet currently reads: "The `\dp public.meetings` output shows `authenticated=ard/postgres` (no `w`, no `D` — wait, `D` is delete, we want it) — actually `authenticated=ardD/postgres` (a=insert, …); concretely: presence of `a`, `r`, `d`, absence of `w` (update); verify the column-level grants are absent for UPDATE". The "wait, `D` is delete, we want it" is thinking-out-loud that should not appear in a final plan. The underlying assertion (insert/select/delete present, update absent) is correct; just trim the fragment.
- **Fix**: Replace the parenthetical with a clean statement, e.g. "The `\dp public.meetings` output shows `authenticated` carrying `a` (insert), `r` (select), `d` (delete), and NOT `w` (update); column-level UPDATE grants are absent."
- **Decision**: FIXED (in plan)

### F2 — Phase 3 Progress section drifts from the body Success Criteria

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: plan.md Phase 3 §Manual Verification ↔ §Progress §Phase 3
- **Detail**: Two mismatches against the progress-format contract (every Success Criteria bullet should have a matching `- [ ] N.M` in Progress): (a) body bullet "Submit with a past datetime → succeeds" has no corresponding Progress entry; (b) Progress 3.11 ("`/dashboard` shows the new 'Meetings' link …") has no corresponding body bullet under §Manual Verification. `/10x-implement` parses these mechanically; the mismatch won't crash but it muddles the bookkeeping.
- **Fix**: Either (a) add a dashboard-link bullet to the Phase 3 body AND add a "past datetime succeeds" entry to Progress, or (b) drop the past-datetime body bullet (it's defensive, not load-bearing) and add only the dashboard-link body bullet. Option (b) is the smaller diff.
- **Decision**: FIXED via option (b)

### F3 — RPC SQL uses misleading column alias `distinct_invitee`

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: plan.md Phase 1 §Changes Required #1 — RPC body
- **Detail**: The bulk insert in the RPC reads `insert into public.meeting_invitations (meeting_id, invitee_id) select v_meeting_id, distinct_invitee from unnest(p_invitee_ids) as distinct_invitee;`. The alias `distinct_invitee` suggests deduplication, but `unnest` does not deduplicate — the alias is just a column name. Duplicates in the input array would hit the `unique (meeting_id, invitee_id)` constraint and fail; the API maps that to 422 (the chosen UX), so the behavior is correct. The naming is just misleading to anyone reading the SQL.
- **Fix**: Rename the alias to `invitee_id` (matches the target column): `select v_meeting_id, invitee_id from unnest(p_invitee_ids) as invitee_id;`.
- **Decision**: FIXED (in plan)

### F4 — New "atomic cross-table mutation RPC" pattern is undocumented

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architectural Fitness
- **Location**: plan.md Phase 3 §Changes Required #6 (AGENTS.md refresh)
- **Detail**: `create_meeting_with_invitations` is the first SECURITY DEFINER RPC in the codebase that writes to multiple tables in one transaction (every other RPC — `is_connected`, `find_parent_by_handle`, `list_my_friends` — is read-only and stable; `handle_new_user` is a trigger, not a user-facing RPC). The plan's AGENTS.md refresh only adds a "Cross-table visibility via RLS" bullet — it doesn't document the new mutation-RPC pattern. S-03 (accept-with-conflict) will likely need a similar atomic RPC (read conflicting meetings + UPDATE invitation status in one transaction), and S-04 may too. Documenting the pattern now means S-03's planning can lean on a settled convention instead of re-deciding.
- **Fix A ⭐ Recommended**: Add a second AGENTS.md §Key conventions bullet ("Cross-table mutation via SECURITY DEFINER RPC") naming the shape (security definer, set search_path = public, pg_temp, validate auth.uid(), validate inputs explicitly, raise typed exceptions for HTTP mapping) and pointing at `create_meeting_with_invitations` as the canonical example.
  - Strength: S-03 plan benefits immediately; pattern is named before it gets reinvented; consistent with how F-01/S-01 documented their new patterns mid-flight.
  - Tradeoff: Adds one bullet to AGENTS.md before the pattern has been used twice — a mild "rule-of-three" violation.
  - Confidence: HIGH — same posture as the column-level GRANT bullet added during S-01.
  - Blind spot: S-03's actual shape may diverge enough that the bullet needs revision when S-03 lands.
- **Fix B**: Defer documentation until S-03 confirms the pattern; leave AGENTS.md as-is for S-02.
  - Strength: YAGNI; doesn't lock in a convention before two instances exist.
  - Tradeoff: S-03's planning will re-derive the pattern from scratch; risks divergence (e.g., different error-code conventions between the two RPCs).
  - Confidence: MEDIUM — the cost of forking is small but real.
  - Blind spot: How often the pattern recurs after S-04 is unknown.
- **Decision**: FIXED via Fix A
