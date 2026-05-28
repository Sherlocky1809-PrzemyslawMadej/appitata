<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Meeting Creation and Invite — Phase 1

- **Plan**: `context/changes/meeting-creation-and-invite/plan.md`
- **Scope**: Phase 1 of 3
- **Date**: 2026-05-28
- **Verdict**: APPROVED (3 minor observations worth considering before Phase 2)
- **Findings**: 0 critical · 0 warnings · 3 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | PASS    |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | WARNING |
| Success Criteria    | PASS    |

All 12 Progress items checked at SHA cc61bb2. Plan-drift sweep clean (the migration matches the adapted intent verbatim; the SECURITY DEFINER recursion fix landed correctly). Scope-discipline sweep clean (nothing from "What We're NOT Doing" snuck in). Cross-table RLS recursion fix verified — both `meetings_select` and `meeting_invitations_select` route through SECURITY DEFINER helpers, no bare cross-table EXISTS remains.

## Findings

### F1 — RPC invitee loop has no upper bound

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260528105428_meetings_foundation.sql:176-180
- **Detail**: The `foreach v_invitee in array p_invitee_ids` loop is bounded only by the caller-supplied array length. A 10k-element array would run 10k `is_connected` calls in one transaction. PRD's secondary success criterion is "3 or more connected friends", so legitimate cardinality is ≤ ~30. Phase 2's zod schema may cap it, but defense-in-depth at the DB layer is cheap and removes a class of abuse from the picture.
- **Fix**: Add a cardinality cap to the existing guard at L172: `if p_invitee_ids is null or cardinality(p_invitee_ids) = 0 or cardinality(p_invitee_ids) > 50 then raise 'invitee count out of range' using errcode = '22023'`. Optionally split into two raises with distinct messages (empty vs too-many).
- **Decision**: FIXED — split into two raises (`'at least one invitee required'` 22023 / `'too many invitees (max 50)'` 22023). Verified via direct probe: 51-element array rejects with cap message, empty array still rejects with original message.

### F2 — No CHECK on starts_at (past-time meetings allowed at DB layer)

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260528105428_meetings_foundation.sql:18
- **Detail**: `starts_at` has no temporal CHECK. The plan's Phase 3 manual verification explicitly said "Submit with past datetime → succeeds" — that bullet was DROPPED during plan-review F2 cleanup, so the plan is technically silent. We're in a documentation gap. The DB layer accepts any timestamptz, including past times.
- **Fix A ⭐ Recommended**: Leave it open (no CHECK; no zod constraint either)
  - Strength: Past-time meetings are a real use case (logging a meetup that already happened to remember it); PRD is silent and shouldn't be over-interpreted. Matches the original plan author's intent before plan-review F2 cleanup removed the bullet.
  - Tradeoff: A creator who picks "yesterday" by accident sees a meeting confirmation rather than a validation error.
  - Confidence: HIGH — matches the original plan intent.
  - Blind spot: None significant.
- **Fix B**: Add `check (starts_at > now() - interval '1 day')` to allow "today and forward" only
  - Strength: Catches accidental year-typos at insert time.
  - Tradeoff: Time-dependent CHECK constraints make table dumps from old backups un-restorable; blocks the "log a past meetup" use case.
  - Confidence: MED — past-meetup workflow may or may not be real.
  - Blind spot: Haven't asked the user if past-meeting creation is intended.
- **Decision**: SKIPPED via Fix A — leave open; past-meetup logging is a legitimate use case; PRD silent.

### F3 — Test doc blocks 2/3 narrative still describes the bare-EXISTS failure mode

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: supabase/tests/meetings-rls.md — block 2 diagnostic note ("...likely the outer-table qualification (`mi.meeting_id = public.meetings.id`) was missed and the inner alias is shadowing") + the block 2/3 framing of the cross-table EXISTS mental model.
- **Detail**: The SQL blocks themselves are correct against the shipped policies. But the surrounding narrative references the "qualify outer-table inside EXISTS" failure mode — which was the ORIGINAL intent that got REPLACED by SECURITY DEFINER helpers when the mutual-recursion bug surfaced. A reader gets a misleading mental model of what would cause Block 2c to fail today.
- **Fix**: Update the block 2 diagnostic note (and block 3 if similar) to reference the helper-based pattern: "A non-zero result from Dave's block means the `user_is_meeting_invitee` helper is over-broad or the `meetings_select` USING clause is mis-wired — likely the helper's filter conditions don't actually narrow on the input parameters." Optionally add a one-line lead-in noting the shipped policies use SECURITY DEFINER helpers, not inline EXISTS, so the test exercises the helper boundary.
- **Decision**: FIXED — block 2 diagnostic note rewritten to reference the SECURITY DEFINER helper (`user_is_meeting_invitee`) and explain why the shipped policies use helpers rather than inline EXISTS (mutual-recursion guard). Block 3 had no parallel diagnostic note, so no change there.
