# Conflict-Overlap & 24h Invitation-Expiry Tests Implementation Plan

## Overview

Test-plan **Phase 3** — prove **Risk #3** (silent double-booking: the conflict warning fails to fire) and **Risk #5** (a stale invitation never expires and stays actionable past 24h). Risk #3 is covered by extracting the inline overlap math into a pure, unit-testable helper plus one render-level integration assertion; Risk #5 by integration tests against the live sweep RPC and the lazy-expiry RLS policy, anchored to a new behavioural-proof doc.

## Current State Analysis

- **Conflict math is inline `.astro` frontmatter** ([src/pages/meetings.astro:23-85](src/pages/meetings.astro#L23-L85)): a non-exported `endsAt()` helper and an anonymous `.filter` predicate `mStart < piEnd && mEnd > piStart` inside an `Object.fromEntries(...)` builder. **No unit seam exists** — the live line is reachable only by rendering the page. The accept endpoint and the `create_meeting_with_invitations` RPC do no conflict math (the warning is advisory; accept never blocks).
- **Expiry is enforced in three coupled layers** (`context/foundation/lessons.md`): the `expire_stale_invitations()` sweep RPC (`< now()-24h`), the `meeting_invitations_update` RLS USING clause (`> now()-24h`, lazy accept-block), and the `meetings.astro` read filter (`> now-24h`). All key on `invited_at`. The sweep is `SECURITY DEFINER`, granted to `service_role` **only**.
- **Test harness exists but is integration-only.** `tests/{helpers,integration,setup}` with `signInAs`/`serviceClient`/`anonClient` ([tests/helpers/supabase.ts](tests/helpers/supabase.ts)), the HTTP cookie-jar ([tests/helpers/http.ts](tests/helpers/http.ts)), and a `globalSetup` ([tests/setup/server.ts](tests/setup/server.ts)) that builds + serves Astro for **every** test file. A single [vitest.config.ts](vitest.config.ts) with `fileParallelism:false`. **No `tests/unit/` and no vitest projects split** — this phase introduces the first pure unit test.
- **No behavioural oracle for conflict or expiry** — `supabase/tests/` has only `parents-rls.md`, `friend-connections-rls.md`, `meetings-rls.md` (blocks 9-13 cover the S-03 accept contract, not expiry).

## Desired End State

`npm test` runs a fast **unit** project (no server) and the existing **integration** project. Unit tests prove the conflict-overlap algorithm directly (boundary cases incl. equal-start, back-to-back, multi-clash, self-exclusion). One integration test proves `/meetings` actually wires the helper (conflict-warning DOM present/absent). Integration tests prove the expiry sweep predicate, idempotency, `responded_at`-stays-null, and the lazy RLS accept-block, all citing a new `supabase/tests/invitation-expiry.md`. `meetings.astro` renders identically to before the refactor.

### Key Discoveries:

- Overlap predicate + duration helper to extract: [meetings.astro:23-25](src/pages/meetings.astro#L23-L25), [:71-85](src/pages/meetings.astro#L71-L85). Half-open `[start,end)`; equal-start = clash, touching = no clash.
- Datasets feeding the builder: `pendingInvitations` ([:52-58](src/pages/meetings.astro#L52-L58)) and `myScheduleForConflicts` ([:60-63](src/pages/meetings.astro#L60-L63)); single RLS-scoped query at [:34-40](src/pages/meetings.astro#L34-L40).
- Sweep RPC + revoke/grant + tightened RLS: [20260601120000_invitation_expiry_sweep.sql:24-40,48-49,54-59](supabase/migrations/20260601120000_invitation_expiry_sweep.sql#L24-L59).
- Stale → 404 via row-invisibility: [respond.ts:41-60](src/pages/api/meetings/invitations/respond.ts#L41-L60).
- Fixture template (RPC create + service teardown + residual-row assert): [tests/integration/meetings-isolation.test.ts](tests/integration/meetings-isolation.test.ts), [tests/integration/api/authz.test.ts](tests/integration/api/authz.test.ts).
- `invited_at` has no RPC backdate param → fixtures use **RPC-then-`serviceClient().update({invited_at})`**.
- Silent-pass guard (assert `userId === expected` before any zero-row/deny) and `fileParallelism:false` are non-negotiable inheritances from Phases 1-2.

## What We're NOT Doing

- **No new conflict rules or behaviour change.** The extraction is a pure refactor; the predicate, the advisory-only accept, and the rendered output stay byte-identical.
- **No e2e / Playwright** — Phase 4 owns the north-star browser flow. Phase 3's render check is a single DOM assertion through the existing HTTP harness, not a browser driver.
- **No testing of the Cron→`scheduled()` trigger** — deploy-only, out of scope (research §B.3). We test the RPC the cron calls, not the cron.
- **No change to the 24h window** in any of the three layers; no migration changes. Tests observe current behaviour.
- **No component-level test of `PendingInvitationsList`** rendering internals — the render check asserts the page wiring, not the component in isolation.
- **No touching the `meetings-rls.md` / parents / friend-connections proof docs** beyond adding the new expiry doc.

## Implementation Approach

Phase 1 makes Risk #3 testable then tests it: extract `src/lib/conflicts.ts`, repoint the frontmatter, split vitest into `unit`/`integration` projects so pure logic runs without spawning Astro, unit-test the helper, and add one render assertion. Phase 2 documents expected expiry behaviour as a proof doc and writes integration tests against the live sweep RPC (via `serviceClient()`) and the lazy-expiry RLS policy (via the real respond endpoint over HTTP), using RPC-then-backdate fixtures. Phases are independent (different risks) and can be verified at separate manual gates.

## Critical Implementation Details

- **Behaviour-identical extraction.** `meetings.astro` currently uses `endsAt` for _both_ the conflict scan and the upcoming/past split ([:65-67](src/pages/meetings.astro#L65-L67)). The extracted `endsAt` must replace **both** call sites so there is a single source (the S-03 anti-drift decision, `2026-05-29-meeting-accept-with-conflict-and-list/plan.md:74`). Verify the three sections render unchanged after the refactor.
- **Vitest projects, not the deprecated workspace file.** Define a `unit` project (node env, **no** `globalSetup`, e.g. `tests/unit/**`) and an `integration` project (current `globalSetup`, `tests/integration/**`). Preserve `fileParallelism:false` for the integration project (shared-DB fixtures race); the unit project can parallelize freely. `npm test` must run both.
- **Expiry fixtures bypass RLS for the timestamp only.** Create the invitation through `create_meeting_with_invitations` (real validation), then `serviceClient().update({invited_at: <past ISO>})` keyed by the invitation id. The service client bypasses RLS — that is intended for fixture setup, never for an isolation assertion (test-plan §6.2).
- **Lazy-block is the load-bearing expiry assertion.** A >24h pending invite must be un-acceptable via the **real respond endpoint** (`POST /api/meetings/invitations/respond` → **404**) _even when the sweep has not run_ — this proves RLS enforces expiry independently of the cron. Pair with a fresh-invite accept (**200**) as the positive control, and assert the silent-pass guard (`302 → /` at signin) so an anonymous jar can't masquerade as a pass.
- **Exact-24h is a fail-closed limbo, not a bug.** At `invited_at == now()-24h` (all three predicates strict), the row is un-acceptable, un-displayed, and un-swept (stays `pending`). The test asserts this trio and documents it as intended-safe in the proof doc.

## Phase 1: Conflict-overlap (Risk #3) — extract, unit-test, render-assert

### Overview

Extract the overlap math into a pure helper, repoint `meetings.astro` at it without changing behaviour, split vitest so pure units run without the server, unit-test the algorithm's boundary cases, and add one render-level integration assertion proving the page wires the helper.

### Changes Required:

#### 1. Pure conflict helper

**File**: `src/lib/conflicts.ts` (new)

**Intent**: Hold the conflict-detection logic as pure, deterministic, exported functions so it can be unit-tested without rendering the page. Lifts the current inline math verbatim (no behaviour change).

**Contract**: Export `endsAt(m: { starts_at: string; duration_minutes: number }): number` (epoch ms = `Date.parse(starts_at) + duration_minutes*60_000`); `overlaps(a, b): boolean` implementing the half-open test `aStart < bEnd && bStart < aEnd`; and `computeConflictsByInvitationId(pending: PendingInvite[], schedule: MeetingLike[]): Record<string, ClashingMeetingSummary[]>` reproducing the [:71-85](src/pages/meetings.astro#L71-L85) builder including `m.id !== pi.meeting.id` self-exclusion and the `ClashingMeetingSummary` mapping. Reuse the types from [src/components/meetings/types.ts](src/components/meetings/types.ts) (`MeetingRow`, `ClashingMeetingSummary`) rather than redefining shapes.

#### 2. Repoint the page frontmatter

**File**: `src/pages/meetings.astro`

**Intent**: Replace the inline `endsAt` and the inline conflict-builder with calls to `src/lib/conflicts.ts`, keeping all three rendered sections (Pending/Upcoming/Past) and the conflict warnings identical.

**Contract**: Import from `@/lib/conflicts`. The local `function endsAt` ([:23-25](src/pages/meetings.astro#L23-L25)) is removed and both its uses (conflict scan [:73-79](src/pages/meetings.astro#L73-L79) and upcoming/past split [:65-67](src/pages/meetings.astro#L65-L67)) call the imported `endsAt`. `conflictsByInvitationId` ([:71-85](src/pages/meetings.astro#L71-L85)) becomes `computeConflictsByInvitationId(pendingInvitations, myScheduleForConflicts)`. No change to the query, the dataset derivations, or the props passed to React.

#### 3. Vitest unit/integration project split

**File**: `vitest.config.ts`

**Intent**: Introduce a `unit` project that runs pure tests without building/serving Astro, alongside the existing integration setup, so the first unit test is fast and decoupled from server readiness.

**Contract**: Use vitest `projects`: `unit` (environment `node`, include `tests/unit/**/*.test.ts`, **no** `globalSetup`), `integration` (include `tests/integration/**/*.test.ts`, keep `globalSetup: ./tests/setup/server.ts`, `fileParallelism:false`, raised timeouts). Shared `resolve.alias` `@`→`src` and `.env.test` loading apply to both. `npm test` (`vitest run`) runs both projects; confirm `test:watch` still works.

#### 4. Conflict-overlap unit tests

**File**: `tests/unit/conflicts.test.ts` (new)

**Intent**: Prove the overlap algorithm and the builder directly, deriving expectations from the documented behaviour (S-03 plan + research), not by copying the predicate.

**Contract**: Cases — (a) equal start → clash; (b) back-to-back `aEnd === bStart` → no clash (both directions); (c) 1-minute overlap → clash; (d) fully disjoint → no clash; (e) self-exclusion: a pending invite does not clash with its own meeting (`m.id === pi.meeting.id` filtered); (f) multi-clash: one pending invite returns ≥2 clashing meetings; (g) varied `duration_minutes` (not the 60 default) computes the right end; (h) `computeConflictsByInvitationId` returns an entry per pending invite (empty array when no clash, not missing key). Construct inputs as plain objects matching the helper's param types; assert the returned map shape.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build` (Astro type-check + build succeeds with the refactor)
- Lint passes on touched files: `npx eslint src/lib/conflicts.ts src/pages/meetings.astro tests/unit/conflicts.test.ts`
- Unit project runs without spawning the server and passes: `npx vitest run --project unit`
- Full suite passes: `npm test`

#### Manual Verification:

- `/meetings` renders the Pending/Upcoming/Past sections and the conflict warning identically to before the refactor (visual diff on a seeded overlapping invitation).
- The `unit` project completes in well under a second and does not trigger an `astro build`/`preview` (observe no server log lines).

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase. Phase blocks use plain bullets — the corresponding `- [ ]` checkboxes for these items live in the `## Progress` section at the bottom of the plan.

---

## Phase 2: Invitation expiry (Risk #5) — oracle doc + integration tests

### Overview

Document expected expiry behaviour as a behavioural-proof doc, then write integration tests proving the sweep predicate, idempotency, the `responded_at`-stays-null invariant, the lazy RLS accept-block (the load-bearing assertion), and the exact-24h limbo — using RPC-then-backdate fixtures and the existing harness.

### Changes Required:

#### 1. Expiry behavioural-oracle doc

**File**: `supabase/tests/invitation-expiry.md` (new)

**Intent**: Provide the source-of-truth for expected expiry behaviour so test expectations are derived from documented scenarios, not lifted from the sweep/RLS SQL (the tautology trap, test-plan §6.2/§6.5). Mirror the structure of `meetings-rls.md`.

**Contract**: Numbered behavioural blocks: (1) a >24h pending invite is swept to `expired`, count = number swept; (2) a <24h pending invite is untouched; (3) sweep is idempotent — second run returns 0, no rows re-touched; (4) the sweep does **not** stamp `responded_at` (stays null on expiry); (5) a >24h pending invite cannot be accepted via respond even before a sweep (lazy RLS block → 404), while a fresh invite accepts (200); (6) exact-24h-old row: un-acceptable, absent from Pending, and **not** swept (stays `pending`) — documented as intended fail-closed. Each block states the expected observable, not the SQL predicate.

#### 2. Expiry integration tests

**File**: `tests/integration/invitation-expiry.test.ts` (new)

**Intent**: Exercise the live sweep RPC and the lazy-expiry RLS policy against local Supabase with RLS on, citing the oracle doc for expectations.

**Contract**: Fixtures via `signInAs(ALICE)` + `create_meeting_with_invitations` (invitee Bob, accepted-connected), then `serviceClient().update({invited_at})` to backdate the invitation; capture ids; `afterAll` deletes the meeting (FK-cascades invitations) and asserts zero residual rows. Tests — (a) sweep via `serviceClient().rpc("expire_stale_invitations")`: a backdated row flips `pending→expired` and the returned count includes it; a fresh row stays `pending`; (b) idempotency: second `rpc` call returns 0 and the expired row is unchanged; (c) `responded_at` is null on the swept row (read via `serviceClient`); (d) **lazy block**: with a backdated-but-unswept invite, Bob's `POST /api/meetings/invitations/respond` (via `signInOverHttp` jar) → **404**, paired with a fresh invite → **200** + side-effect (`status='accepted'`, `responded_at` stamped) read via `serviceClient`; assert `302 → /` at signin (silent-pass guard); (e) exact-24h: backdate to `now()-24h`, assert respond → 404 and sweep count excludes it (still `pending`). Filter all assertions by created row ids (not bare counts). Annotate any order-dependent block per the Phase 2 (authz) convention.

### Success Criteria:

#### Automated Verification:

- Lint passes on touched files: `npx eslint tests/integration/invitation-expiry.test.ts`
- Expiry integration tests pass against local Supabase (stack up + `npm run db:reset`): `npx vitest run --project integration tests/integration/invitation-expiry.test.ts`
- Full suite passes: `npm test`

#### Manual Verification:

- The expiry tests fail loudly if pointed at a misconfigured/empty DB (no silent zero-row pass) — spot-check by confirming the fresh-invite accept control returns 200 and the side-effect read shows the flip.
- `supabase/tests/invitation-expiry.md` blocks match the test assertions (the doc is the spec the test cites, not a copy of the SQL).

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful. Phase blocks use plain bullets — the `- [ ]` checkboxes live in the `## Progress` section at the bottom.

---

## Testing Strategy

### Unit Tests:

- `src/lib/conflicts.ts`: overlap boundary matrix (equal-start, back-to-back, 1-min overlap, disjoint), self-exclusion, multi-clash, non-default durations, full-map shape. Pure, no DB, no server.

### Integration Tests:

- Conflict render wiring: `/meetings` shows/hides `[data-testid="conflict-warning"]` for overlapping vs non-overlapping seeded fixtures (Phase 1, via HTTP jar).
- Expiry: sweep predicate + idempotency + `responded_at` invariant + lazy RLS accept-block + exact-24h limbo (Phase 2, via `serviceClient()` RPC and the real respond endpoint).

### Manual Testing Steps:

1. Load `/meetings` as a seeded user with an overlapping pending invite — confirm the conflict warning renders exactly as before the refactor.
2. Confirm `npx vitest run --project unit` runs in milliseconds with no Astro build/serve.
3. With the local stack up, run the expiry suite and confirm the fresh-invite control accepts (200) while the stale invite is blocked (404).

## Performance Considerations

The conflict builder is O(P×M) (pending × schedule) — fine at MVP scale (S-03 review noted revisit > ~500 meetings); the extraction does not change complexity. The unit project removes the `astro build`/`preview` cost from pure-logic runs, materially speeding the inner test loop.

## Migration Notes

No schema or data migration. The only production-code change is the behaviour-preserving extraction in Phase 1; rollback is reverting `src/lib/conflicts.ts` + the `meetings.astro` import. Tests are additive.

## References

- Research: `context/changes/testing-conflict-overlap-expiry/research.md`
- Test plan: `context/foundation/test-plan.md` §2 (Risks #3/#5), §6.1/§6.2/§6.5
- Lessons: `context/foundation/lessons.md` (three-layer 24h coupling; errcode mapping; loginable seed)
- Prior art: `context/archive/2026-05-29-meeting-accept-with-conflict-and-list/plan.md` (overlap predicate, anti-drift `endsAt`); `context/archive/2026-06-01-invitation-expiry-cron-backstop/` (sweep, lazy RLS, deploy-only cron); `context/archive/2026-06-08-testing-api-authz-validation/` (HTTP jar, build-before-serve, silent-pass guard)
- Fixture/harness templates: `tests/integration/meetings-isolation.test.ts`, `tests/integration/api/authz.test.ts`, `tests/helpers/{supabase,http}.ts`, `tests/setup/server.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Conflict-overlap (Risk #3) — extract, unit-test, render-assert

#### Automated

- [x] 1.1 Type checking passes: `npm run build` — 35a8ed2
- [x] 1.2 Lint passes on touched files: `npx eslint src/lib/conflicts.ts src/pages/meetings.astro tests/unit/conflicts.test.ts` — 35a8ed2
- [x] 1.3 Unit project runs without the server and passes: `npx vitest run --project unit` — 35a8ed2
- [x] 1.4 Full suite passes: `npm test` — 35a8ed2
- [x] 1.7 Conflict render-wiring integration test passes: `npx vitest run --project integration tests/integration/conflict-render.test.ts` — 35a8ed2

#### Manual

- [x] 1.5 `/meetings` renders all three sections + conflict warning identically to pre-refactor — 35a8ed2
- [x] 1.6 `unit` project completes sub-second with no astro build/preview — 35a8ed2

### Phase 2: Invitation expiry (Risk #5) — oracle doc + integration tests

#### Automated

- [x] 2.1 Lint passes on touched files: `npx eslint tests/integration/invitation-expiry.test.ts`
- [x] 2.2 Expiry integration tests pass: `npx vitest run --project integration tests/integration/invitation-expiry.test.ts`
- [x] 2.3 Full suite passes: `npm test`

#### Manual

- [x] 2.4 Expiry suite fails loudly on a misconfigured DB; fresh-invite control returns 200 with side-effect
- [x] 2.5 `invitation-expiry.md` blocks match the test assertions (spec, not SQL copy)
