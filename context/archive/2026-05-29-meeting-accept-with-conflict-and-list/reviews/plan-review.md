<!-- PLAN-REVIEW-REPORT -->

# Plan Review: Meeting Accept with Conflict and List (S-03)

- **Plan**: `context/changes/meeting-accept-with-conflict-and-list/plan.md`
- **Mode**: Deep
- **Date**: 2026-05-29
- **Verdict (initial)**: REVISE
- **Verdict (after triage)**: SOUND
- **Findings**: 3 critical · 1 warning · 3 observations — 7/7 triaged

## Verdicts

| Dimension             | Verdict                            |
| --------------------- | ---------------------------------- |
| End-State Alignment   | PASS                               |
| Lean Execution        | PASS                               |
| Architectural Fitness | WARNING → PASS (F7 fixed)          |
| Blind Spots           | FAIL → PASS (F2, F4 fixed)         |
| Plan Completeness     | FAIL → PASS (F1, F3, F5, F6 fixed) |

## Grounding

- 8/8 paths exist (plan, brief, migration, friend-respond, IncomingRequestsList, MyMeetingsList, meetings.astro, RLS test doc)
- All symbols verified (`is_connected`, `list_my_friends`, `user_is_meeting_invitee`, `meetings_select`); `responded_at` column and `meeting_invitations_update` policy correctly absent (plan introduces them)
- `MyMeetingsList` / `MeetingWithInvitations` only referenced by `meetings.astro` (safe rename)
- `docs/reference/contract-surfaces.md` absent — surface check skipped per skill spec
- `npm run dev` is `astro dev` (port 4321), confirmed in `package.json:6`
- brief↔plan consistent: 4 phases, 10 tests, decisions table aligned

## Findings

### F1 — Phase 4 password-stamping is hand-wavy and won't compile

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 4 §2 — Global DB reset + auth state setup
- **Detail**: Supabase has no SQL-level password hashing helper; the seed ships empty `encrypted_password` so `/auth/signin` rejects every Playwright login attempt. The plan's vague "bcrypt-stamp via Supabase's helper" leaves the implementer stuck.
- **Fix**: Replace vague language with concrete SQL: `update auth.users set encrypted_password = crypt('password123!', gen_salt('bf')) where id in (alice_uuid, bob_uuid);` appended to `supabase/seed.sql`. Document the constant in `tests/e2e/README.md`. State pgcrypto is pre-enabled in Supabase local.
- **Decision**: FIXED (Fix in plan)

### F2 — Phase 4 tests have no concrete strategy for discovering invitation_ids

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 4 §4 (tests 3.5/3.6/3.7) + §5 (test 2.7)
- **Detail**: Tests pre-arrange via API but need `invitation_id` to drive the respond endpoint. No GET endpoint lists invitations; no stable DOM selector exists today; service-role admin queries would add an undocumented dependency.
- **Fix**: Add `data-testid="pending-invitation"` + `data-invitation-id="<uuid>"` + `data-testid="conflict-warning"` + `data-testid="accept-button"` / `data-testid="decline-button"` to `PendingInvitationsList` in Phase 3 §1. Tests discover via `getByTestId('pending-invitation').first().getAttribute('data-invitation-id')`. Document as canonical arrange pattern in `tests/e2e/README.md`.
- **Decision**: FIXED (Fix in plan; also resolves F7)

### F3 — Phase 1 has a Success-Criteria bullet with no Progress entry

- **Severity**: ❌ CRITICAL (per Progress↔Phase mechanical contract)
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §Automated Verification ↔ Progress §Phase 1
- **Detail**: Phase 1 body has four Automated bullets including the editorial "Lint passes on the new migration file ... mark as completed if the file lints in the editor." Progress has only three checkboxes (1.1-1.3). Violates the format contract `/10x-implement` parses.
- **Fix**: Delete the parenthetical bullet from the Phase 1 body. It's editorial, not a runnable criterion.
- **Decision**: FIXED (Fix in plan)

### F4 — Test 3.8 past-dated meeting at "1 hour ago" is timing-racy

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 4 §4 — Test 5 (mirrors Phase 3 item 3.8)
- **Detail**: With default `duration_minutes = 60`, a meeting starting 1h ago ends NOW. The upcoming/past cutoff (`endsAt < now()`) flips on tiny latency between arrange and render. Flaky test.
- **Fix**: Pin fixture to `starts_at = now - 3h` (ends 2h ago) and a second past meeting at `now - 5h` for the descending-order assertion.
- **Decision**: FIXED (Fix in plan)

### F5 — wrangler-dev caveat in Phase 4 is misleading

- **Severity**: 💭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 4 §1 — playwright.config.ts contract
- **Detail**: Plan said "if wrangler dev is configured to a different port" — but `npm run dev` is `astro dev` (verified). The wrangler caveat invents flexibility that doesn't apply.
- **Fix**: Replace with "Astro dev defaults to 4321 — pin both `baseURL` and `webServer.url` to a shared `BASE_URL` const at the top of `playwright.config.ts`." Note the Cloudflare adapter is build-time only and that root path 302→/auth/signin works as a Playwright readiness probe.
- **Decision**: FIXED (Fix in plan)

### F6 — Progress 3.10 (AGENTS.md verification) has no matching body bullet

- **Severity**: 💭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 §Manual Verification ↔ Progress 3.10
- **Detail**: Progress 3.10 covers AGENTS.md coherence, but Phase 3 body's Manual Verification bullets don't list it. Reverse direction isn't a parse-breaking rule, but inconsistent with the slice's own pattern.
- **Fix**: Add an AGENTS.md verification bullet to Phase 3 §Manual Verification mirroring Progress 3.10.
- **Decision**: FIXED (Fix in plan)

### F7 — Conflict-warning UI lacks a stable test selector

- **Severity**: 💭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 3 §1 ↔ Phase 4 §4 Test 3.6
- **Detail**: Test 3.6 asserted via copy literal ("Heads up — this overlaps with:"). Future copy changes break the test for a non-functional reason.
- **Fix**: Add `data-testid="conflict-warning"` to the conflict notice card; Test 3.6 asserts via testid + content (formatted starts_at) rather than the heading literal.
- **Decision**: FIXED (resolved as part of F2's edit)

## Triage Summary

- **Fixed**: F1, F2, F3, F4, F5, F6, F7 (7)
- **Skipped**: 0
- **Accepted**: 0
- **Dismissed**: 0

Final verdict: **SOUND**.
