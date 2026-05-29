<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Meeting Creation and Invite

- **Plan**: context/changes/meeting-creation-and-invite/plan.md
- **Scope**: Phases 2 & 3 of 3 (Phase 1 reviewed separately in `reviews/impl-review-phase-1.md`, triaged in commit 973bc77)
- **Date**: 2026-05-29
- **Verdict**: APPROVED
- **Findings**: 0 critical | 1 warning | 3 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | PASS    |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | PASS    |

## Findings

### F1 — POST handler dispatches by error.message string instead of SQLSTATE

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (Reliability)
- **Location**: `src/pages/api/meetings/index.ts:70-83`
- **Detail**:
  Inside the `if (error)` block the handler routes 42501 ("invitee not connected" → 403, "authentication required" → 401) and 22023 ("at least one invitee required", "too many invitees (max 50)" → 400) by RAW message strings. Native 23505 / 23514 are SQLSTATE-driven; the RPC-raised exceptions are message-driven. If a future migration renames any of those RAISE strings, the relevant branch silently falls through to the generic 500 at L84, leaking the raw RPC message and swapping 403/400 for 500. Sibling `src/pages/api/friends/request.ts` discriminates on `error.code` first; only this handler uses message-only fall-through within a SQLSTATE bucket.

  Plan §Phase 2 §1 prescribes message-keyed dispatch (the codes overlap), so the implementation matches the plan — this is a hardening, not a correctness fix. Current behavior is right; the lock-in is fragile.

- **Fix**: Add a SQLSTATE fallback after the message checks so a renamed RAISE degrades to the correct HTTP class:

  ```ts
  if (error.code === "42501") return json({ error: "unauthorized" }, 403);
  if (error.code === "22023") return json({ error: "invalid request" }, 400);
  return json({ error: error.message }, 500);
  ```

  - Strength: Robust to RPC RAISE-text edits; mirrors sibling friends/request.ts SQLSTATE discipline.
  - Tradeoff: Two extra lines; the 42501 fallback can't distinguish 401-auth from 403-not-connected without the message (defensible — the locals.user guard at L51 already 401s before the RPC, so 42501 in production effectively means "invitee not connected").
  - Confidence: HIGH — failure mode is mechanical, fix is three additive lines.
  - Blind spot: None significant.

- **Decision**: FIXED (applied as proposed; SQLSTATE fallback added before generic 500 at index.ts:84-86)

### F2 — meetings.astro comment contradicts the belt-and-braces guard below it

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/pages/meetings.astro:8-19`
- **Detail**:
  L8 says "Middleware guarantees `user` is non-null on this protected route", and L17 then sets `loadError = "Not signed in"` if user is null. The guard mirrors sibling friends.astro (project convention); the comment is the misleading part.
- **Fix**: Reword L8 to "Middleware redirects unauthenticated users; the guards below are defense-in-depth." No code change.
- **Decision**: SKIPPED

### F3 — 23514 mapping is unreachable from this endpoint

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/pages/api/meetings/index.ts:69`
- **Detail**:
  Zod (L11-28) already enforces `duration_minutes ∈ [1, 1440]`, address-text length bounds, description length, and array non-empty before the RPC runs. The DB CHECK constraints can fire only if zod is bypassed — which can't happen through this handler. The branch documents intent rather than handling a realistic state.
- **Fix**: Either tighten to a duration-specific message or leave as-is for symmetry. No action required.
- **Decision**: SKIPPED

### F4 — Hand-rolled submit button in MeetingCreateForm vs canonical SubmitButton

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/components/meetings/MeetingCreateForm.tsx:227-236`
- **Detail**:
  Auth siblings (SignInForm, SignUpForm) use `<SubmitButton>` which delegates `disabled` to `useFormStatus().pending`. This form re-implements inline because `disabled` also needs to fold in `selectedInvitees.size === 0`, which `useFormStatus` can't observe. The divergence is justified; the risk is a future agent normalizing it back to SubmitButton.
- **Fix**: Add one comment line above L227: "Hand-rolled (not SubmitButton) — disabled depends on selectedInvitees, which useFormStatus can't see."
- **Decision**: SKIPPED

## Dismissed (lessons-rule disagree)

### D1 — Agent-suggested `?? []` guards on `friendsRes.data` / `meetingsRes.data`

Per `context/foundation/lessons.md` ("Lint-validate type-system findings from /10x-impl-review before applying"): after the `.error` ladder at L33-34, supabase-js narrows `.data` to the non-null array type. Verified — `list_my_friends` `Returns: { display_name; id }[]` (not nullable). The same wrong fix was rejected in the friend-handshake F2 lesson. Build is green; no runtime null-deref vector. DISAGREE.
