<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Meeting Accept with Conflict and List

- **Plan**: context/changes/meeting-accept-with-conflict-and-list/plan.md
- **Scope**: Phase 2 of 4
- **Date**: 2026-05-29
- **Verdict**: NEEDS ATTENTION (resolved during triage — see Decisions)
- **Findings**: 0 critical · 3 warnings · 3 observations
- **HEAD at review**: abf1851

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | WARNING |
| Scope Discipline    | WARNING |
| Safety & Quality    | PASS    |
| Architecture        | PASS    |
| Pattern Consistency | WARNING |
| Success Criteria    | PASS    |

All three warnings are transient — Phase 3 is the natural cleanup gate. None block Phase 2 commit; they shape what Phase 3 has to remember.

## Findings

### F1 — Derivations computed but not rendered; creatorOwnedMeetings interim filter

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence / Scope Discipline
- **Location**: src/pages/meetings.astro:83, 113-119
- **Detail**: Plan §Phase 2 SSR rewrite said pass pendingInvitations/conflictsByInvitationId/upcoming/past/viewerId to React components. Actual: all five computed (:49-79) but only `creatorOwnedMeetings = meetings.filter(m => m.creator?.id === user?.id)` at :83 is rendered, feeding the Phase-1 MyMeetingsList. Defensible Phase-2-continuity bridge (Phase 3 forbids new UI components in Phase 2 scope), but creates Phase 3 cleanup the implementer must remember.
- **Fix A ⭐ Recommended**: Accept as Phase-2 bridge; log a Phase 3 entry-checklist note.
- **Fix B**: Delete creatorOwnedMeetings + the My-created-meetings section now.
- **Decision**: ACCEPTED-AS-BRIDGE (Fix A). Phase 3 §3 contract explicitly replaces MyMeetingsList with the perspective-aware MeetingsList and reads upcoming/past, deleting this branch.

### F2 — Visible debug <p> with ssr-debug-counts testid leaks to end users

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/pages/meetings.astro:115-117
- **Detail**: `<p data-testid="ssr-debug-counts">pending: {pendingCount} · upcoming: {upcomingCount} · past: {pastCount} · conflict-keys: {conflictKeys.length}</p>` shipped visible to all users. Added for Manual Verification 2.10. Phase 4 testing per the plan uses different testids (`data-testid="pending-invitation"` + `data-invitation-id={r.invitation_id}` on individual rows), not this counts paragraph.
- **Fix**: Delete the <p> and the four unused derivation consts (pendingCount/upcomingCount/pastCount/conflictKeys).
- **Decision**: FIXED in chore commit (see post-triage section).

### F3 — InvitationStatus declared in BOTH types.ts AND MyMeetingsList.tsx

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/meetings/types.ts:1, src/components/meetings/MyMeetingsList.tsx:5
- **Detail**: The string-literal union `"pending" | "accepted" | "declined" | "expired"` is now declared in both files. Phase 3 renames MyMeetingsList → MeetingsList and the local copy goes away.
- **Fix**: Accept as transient (Phase 3 deletes MyMeetingsList.tsx; the duplication dies with it).
- **Decision**: SKIPPED (accepted as Phase-3 transient).

### F4 — creator/invitee `{...} | null` looser than friends precedent

- **Severity**: ◯ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/meetings/types.ts:8,21
- **Detail**: creator_id / invitee_id are NOT NULL columns, so the embedded relation is non-null at runtime. The friends twin types `requester: { ... }` non-null. The `| null` here forces optional-chaining at meetings.astro:50,56,83 against a state that can't occur. Conservative, not unsafe.
- **Fix**: Drop `| null` from creator and invitee; remove redundant `?.` chains.
- **Decision**: SKIPPED. Per the recorded lesson "Lint-validate type-system findings before applying", no evidence the friend precedent is the right tightening — conservative typing is harmless until narrowing actually bites.

### F5 — eq("status","pending") divergence from friend-respond lacks an in-file comment

- **Severity**: ◯ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/pages/api/meetings/invitations/respond.ts:47
- **Detail**: `.eq("status", "pending")` is intentional belt-and-suspenders mirroring the RLS USING. Friend twin (friends/respond.ts:44) does NOT have this clause, so a future reader diffing the two may "fix" the asymmetry the wrong way.
- **Fix**: Add a 1-line comment at respond.ts:47 noting the intentional defense-in-depth divergence vs friends.
- **Decision**: FIXED in chore commit.

### F6 — Derived consts declared outside the happy-path else block

- **Severity**: ◯ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/pages/meetings.astro:83-87
- **Detail**: Derived consts computed AFTER the `if (!user) { loadError } else { ... }` block. On the error branch, meetings = [] (initial), so filters return [] — correct, but code path runs filter logic only meaningful on happy path.
- **Fix**: After F2 deletes the 4 count consts, move creatorOwnedMeetings into the happy-path else block.
- **Decision**: FIXED in chore commit (bundled with F2).

## Success criteria re-run at HEAD = abf1851

- 2.1 `npm run astro check` → 0 errors / 0 warnings ✓
- 2.2 `npx eslint <touched>` → clean ✓
- 2.3 `npm run build` → Complete ✓
- 2.4-2.10 verified via curl probes + screenshots in `.verify-evidence/phase2/`
