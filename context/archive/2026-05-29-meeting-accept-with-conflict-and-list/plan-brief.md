# Meeting Accept with Conflict and List (S-03) — Plan Brief

> Full plan: `context/changes/meeting-accept-with-conflict-and-list/plan.md`

## What & Why

S-03 closes the co-care loop: a parent invited to a meeting can accept or decline, sees an inline conflict warning at accept-time when the meeting overlaps something on their schedule (FR-009), and the `/meetings` page reshapes into a Pending invitations → Upcoming → Past three-section view (FR-010). It exists because the create-and-invite slice (S-02) only writes pending invitations — without the respond side, no meeting ever transitions to confirmed and the primary success criterion in the PRD cannot complete end-to-end.

## Starting Point

S-02 (archived) shipped the `meetings` + `meeting_invitations` tables with all four enum values, the cross-table SELECT helpers (`user_is_meeting_invitee` / `user_is_meeting_creator`), `revoke update on meeting_invitations from authenticated` (the REVOKE half of the column-grant pattern is **already in place**), and a creator-only `/meetings` page with create form + "My created meetings" list. The friend-respond pattern (`/api/friends/respond.ts` + `IncomingRequestsList.tsx`) is the structural twin S-03's respond endpoint and UI mirror line-for-line. No `responded_at` column yet; no UPDATE policy on `meeting_invitations`; the page does not show invitee-side data.

## Desired End State

Opening `/meetings` shows three sections under the existing create form: pending invitations the parent has received (with an inline yellow conflict warning where the meeting overlaps their already-confirmed schedule), upcoming meetings (unified creator + accepted-invitee view, date-asc, future only), and past meetings (same source, descending). Clicking Accept on a pending invitation flips its status to `accepted` and stamps `responded_at`; Decline does the same with `declined`. A parent cannot change their response after submitting it. The conflict warning is informational — the second click on Accept IS the consent, matching the "shown before they can confirm" reading of FR-009.

## Key Decisions Made

| Decision                        | Choice                                                                              | Why (1 sentence)                                                                                                                                                                         | Source                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Conflict warning UX             | Inline yellow notice above the Accept button                                        | Single click in the happy case; warning is part of initial paint so impossible to miss; matches the inline-error vocabulary already in `ServerError.tsx` / `FormField.tsx`               | Plan                                                                                                                                                             |
| Conflict scope (which meetings) | Meetings the viewer created + invitations the viewer has already accepted           | Matches PRD's "the meetings each invited friend already has on their schedule" — confirmed commitments only; both index-supported (`creator_starts_at_idx`, `invitee_accepted_idx`)      | Plan                                                                                                                                                             |
| Conflict-detection layer        | SSR in TypeScript on `/meetings.astro`, single pass against unified meetings data   | Same dataset feeds upcoming/past lists; renders the warning in initial paint with zero extra calls; auditable as plain JS; no new SQL surface                                            | Plan                                                                                                                                                             |
| Page composition                | Three sections: Pending → Upcoming → Past (Create form stays on top)                | Each section has one job; pending gets the most prominent placement; reads natively from the PRD's "upcoming and past" prose                                                             | Plan                                                                                                                                                             |
| Upcoming/past boundary          | Past iff `starts_at + duration_minutes < now()`                                     | Matches what a parent thinks "past" means; honours the duration field S-02 introduced; a meeting in progress stays in Upcoming                                                           | Plan                                                                                                                                                             |
| `responded_at` audit column     | Add nullable `timestamptz`, stamped server-side in the same UPDATE as `status`      | Explicit follow-up flagged in the S-02 plan-brief; cheap now; hardens the data model for S-04's cron expiry (`responded_at IS NULL` means "no human ever responded")                     | Plan                                                                                                                                                             |
| Response semantics              | One-shot: only `pending → accepted                                                  | declined` allowed                                                                                                                                                                        | Mirrors the friend-respond policy literally; PRD FR-008 says "accept or decline", not "change your mind"; removes a whole class of "did they re-flip?" confusion | Plan |
| Post-respond UX                 | `window.location.reload()`                                                          | Consistent with `IncomingRequestsList` + `MyMeetingsList` delete; SSR re-runs conflict detection over the new schedule so newly-stale warnings auto-correct                              | Plan                                                                                                                                                             |
| API endpoint shape              | `POST /api/meetings/invitations/respond` mirroring `/api/friends/respond`           | Bare supabase-js + RLS is sufficient (single-row mutation, no cross-table atomicity needed); 404-on-RLS-filter-miss is the established repo idiom                                        | Plan                                                                                                                                                             |
| Column-level GRANT              | `grant update (status, responded_at) on meeting_invitations to authenticated`       | The REVOKE was already done in S-02; only the column GRANT is new; mirrors friend_connections's `grant update (status)` pattern                                                          | Plan                                                                                                                                                             |
| List component refactor         | `MyMeetingsList` → `MeetingsList`, perspective-aware via `viewerId` prop            | Lets a unified upcoming/past list render both creator (per-invitee badges + Delete) and invitee (creator name + own accepted badge, no Delete) rows from one template                    | Plan                                                                                                                                                             |
| E2E testing tool                | Playwright (`@playwright/test`) — single Chromium project, serial execution         | Cross-browser story not needed at MVP; serial-only because the suite shares a single seeded DB; Chromium-only keeps the install footprint small (~200MB vs ~600MB for all three)         | Plan                                                                                                                                                             |
| Screenshot policy               | Evidence-only to gitignored `.verify-evidence/playwright/`, no committed goldens    | Catches no visual regressions automatically but avoids cross-platform pixel noise and golden-file churn during active UI development; reuses the existing `.verify-evidence/` scratchpad | Plan                                                                                                                                                             |
| E2E coverage scope              | Comprehensive — 6 UI tests mirror Phase 3 manual matrix (3.4-3.9) + 4 API negatives | Full mirror of the manual matrix means future regressions in any covered path are caught; serial runtime stays under 150s; each test maps 1:1 to a PRD requirement                       | Plan                                                                                                                                                             |
| DB state per suite              | `globalSetup` runs `npm run db:reset` once before all tests                         | Self-contained suite; CI-friendly; per-test reset would add ~200s overhead; tests use unique `starts_at` offsets to avoid cross-test pollution                                           | Plan                                                                                                                                                             |

## Scope

**In scope:**

- New migration: `responded_at timestamptz` (nullable) + `meeting_invitations_update` RLS policy (`pending → accepted|declined`) + `grant update (status, responded_at)` (REVOKE already in S-02)
- Five new blocks (9-13) in `supabase/tests/meetings-rls.md` covering the UPDATE policy from invitee, non-invitee, terminal-row, and column-level angles
- Regenerated `src/db/database.types.ts`
- New API endpoint `POST /api/meetings/invitations/respond` (zod-validated, mirrors friend-respond)
- `/meetings.astro` SSR rewrite: combined meetings fetch (creator OR invitee, RLS-filtered) + JS-side derivation of `pendingInvitations`, `upcoming`, `past`, and `conflictsByInvitationId` map
- New `PendingInvitationsList.tsx` component (conflict warning + Accept/Decline)
- Refactor `MyMeetingsList.tsx` → `MeetingsList.tsx` (perspective-aware via `viewerId`)
- Three-section page composition: Pending → Upcoming → Past, with the create form on top
- AGENTS.md `§Current state` refresh
- Playwright E2E harness: `@playwright/test` dev dep, `playwright.config.ts`, `globalSetup` running `npm run db:reset`, storage-state auth for Alice and Bob, ten serial tests (six UI flows mirroring Phase 3 manual items 3.4-3.9 + four API negative paths mirroring Phase 2 items 2.6-2.9), evidence-only screenshots to gitignored `.verify-evidence/playwright/`

**Out of scope:**

- Cron expiry of `pending` invitations after 24h (S-04)
- Editing a meeting after create (no change from S-02)
- Adding/removing invitees after create
- Allowing a parent to flip their response (one-shot policy)
- Server-side blocking of double-booking (warning is informational; the second click IS the consent)
- A proactive availability-matching view (PRD §Non-Goals)
- A visual calendar grid (PRD §Non-Goals)
- A `responded_at`-driven UI surface ("you declined 3 hours ago")
- Dashboard counter / topbar badge for pending invitations
- Pagination / virtualization of the lists
- shadcn dialog / toast components
- SECURITY DEFINER RPC for the respond mutation (bare supabase-js + RLS suffices)
- Pushing migrations to a remote Supabase project
- pgTAP / automated SQL tests
- Committed visual-regression baselines (golden screenshots via `expect(page).toHaveScreenshot()`) — evidence-only capture, no pixel-diff assertions
- Parallel Playwright execution — tests run serially (`workers: 1`) because they share a single seeded local DB
- A unit-test runner (`vitest`, `node:test`) — still a Module-3 concern; Phase 4 adds E2E only
- CI integration for the Playwright suite — local-only first; wiring into `.github/workflows/ci.yml` is a follow-up

## Architecture / Approach

**The respond endpoint is a literal mirror of `/api/friends/respond.ts`** — zod-validate `{ invitation_id, action }`, supabase-js `update({ status: nextStatus, responded_at: new Date().toISOString() }).eq("id", ...).eq("status", "pending").select(...).maybeSingle()`, RLS USING gates authz (404 on null `data`). The defense-in-depth `.eq("status", "pending")` mirrors the RLS USING — belt-and-suspenders. No SECURITY DEFINER RPC: single-row update, no cross-table atomicity needed.

**Conflict detection runs SSR in TypeScript, not in SQL**. The page already needs to fetch the full schedule (creator-side + accepted-invitee-side) to render the upcoming/past lists; the same dataset feeds a `Map<invitation_id, ClashingMeetingSummary[]>` computed before the components mount. Overlap predicate: `aStart < bEnd && aEnd > bStart`. The `endsAt(m) = new Date(m.starts_at).getTime() + m.duration_minutes * 60_000` derivation is reused for the upcoming/past split — extracted once to prevent drift.

**A single SSR fetch returns the union.** Because the existing `meetings_select` RLS policy already allows the viewer to see meetings where they are creator OR invitee, a bare `from("meetings").select(...)` returns both sides. JS-side filters split into the three sections. Pending invitations are projected from the `invitations` array on each meeting where `invitee_id == user.id && status == 'pending'`.

**The list component becomes perspective-aware.** `MyMeetingsList.tsx` is renamed to `MeetingsList.tsx` and takes a `viewerId` prop. Each row branches on `meeting.creator.id === viewerId`: creator-branch keeps the per-invitee status list + Delete; invitee-branch shows "Created by `<creator_name>`" + the viewer's own accepted badge, no Delete. One template, conditional branch. The file rename is intentional — no backwards-compat re-export.

## Phases at a Glance

| Phase                 | What it delivers                                                                                            | Key risk                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Data layer         | `responded_at` column + `meeting_invitations_update` policy + column-level GRANT + types + 5 new RLS tests  | Forgetting to list `responded_at` in the column GRANT alongside `status` (permission denied on the two-field UPDATE despite RLS passing); USING `status = 'pending'` omission breaks one-shot                      |
| 2. Server-side wiring | Respond endpoint + `/meetings.astro` SSR rewrite (unified fetch + conflict map) + shared types              | The conflict scope filter (creator-OR-accepted-invitee only); the `endsAt(m)` derivation must be used identically for conflict and upcoming/past split (drift hazard)                                              |
| 3. UI + integration   | `PendingInvitationsList` + refactored `MeetingsList` (perspective-aware) + 3-section page + AGENTS.md       | Invitee-branch rendering correctness (creator name visible, no Delete); conflict-warning copy is informational not blocking; stale-page 404 path renders cleanly                                                   |
| 4. E2E + screenshots  | `@playwright/test` + `playwright.config.ts` + globalSetup db:reset + auth.setup + 10 tests + evidence shots | Seed fixture currently has empty `encrypted_password` — Phase 4 must extend `supabase/seed.sql` to bcrypt-stamp known passwords for Alice and Bob; Cloudflare-workerd dev server boot stability inside `webServer` |

**Prerequisites:** S-02 (`meetings_foundation` migration) must be applied and the data layer cross-table SELECT helpers must exist — both are in place (archived). S-01's `list_my_friends` RPC is still used by the create form (unchanged). Phase 4 adds `@playwright/test` as a new devDependency and requires Chromium binary install via `npm run test:e2e:install` on first run.

**Estimated effort:** ~3 sessions across 4 phases (Phases 1-3 mirror prior slices; Phase 4 is one extra session covering harness scaffolding, ten tests, and seed-password extension).

## Open Risks & Assumptions

- **Column-level GRANT scope** — `responded_at` must be listed alongside `status` in the GRANT; missing it produces a "permission denied for column" error on the two-field UPDATE even when RLS WITH CHECK would otherwise pass. Phase 1's `\dp meeting_invitations` verification block surfaces this immediately.
- **One-shot enforcement is layered at three levels** — RLS USING (`status = 'pending'`), supabase-js `.eq("status", "pending")` defense-in-depth, and the zod enum (`accept | decline` only). Removing any one is fine; removing two is a path to flip semantics.
- **Conflict basis excludes pending invitations of the viewer** — an unresponded invitation isn't a commitment, so it doesn't count as scheduled. A parent who pre-accepts the wrong invitation creates a false "no conflict" reading for a later one; this is acceptable at MVP scale.
- **Stale-page race** — a parent opens `/meetings`, walks away for 10 minutes, then clicks Accept on what is now a deleted or already-responded invitation. The 404 surfaces in the error banner with "not found"; the page reload pulls fresh state. No special UX beyond what the friend-respond path already shipped.
- **No timezone story** — the `<input type="datetime-local">` conversion was settled in S-02 (browser TZ → UTC ISO). The respond endpoint does no datetime input; `responded_at` is server-side `new Date().toISOString()` so client clock skew is impossible.
- **The unified meetings query returns the parent's full history** — at MVP scale this is fine; if a parent ever accumulates >500 past meetings the render hit would surface. Pagination is an explicit non-goal here; revisit when a real user hits that volume.
- **Playwright seed-password coupling** — Phase 4's auth.setup needs Alice and Bob to sign in via the real `/auth/signin` form, which requires `auth.users.encrypted_password` to be set. The current seed fixture leaves both rows with empty passwords. Phase 4 extends `supabase/seed.sql` to bcrypt-stamp a documented local-dev constant; this is the only schema-shape coupling Phase 4 imposes on prior phases. The constant lives in `tests/e2e/README.md` and is never used outside local dev.
- **Cloudflare-workerd dev server boot inside Playwright's `webServer`** — Astro on workerd can take 10-30s to be ready; the config sets `webServer.timeout: 120_000` to absorb cold-start variance. If a future Astro/Cloudflare update changes the readiness shape, `webServer.url` may need to point to a health endpoint instead of the bare baseURL.
- **Test-state pollution across the suite** — `globalSetup` resets the DB once; subsequent tests accumulate state within the run. Tests use unique `starts_at` values (each test offsets by a unique number of days from "now") so cross-test interference stays bounded. If a future test needs a perfectly clean DB it adds an explicit `beforeEach` that calls a cleanup helper — not the global default, since per-test reset would add ~200s to suite runtime.
- **Cross-platform pixel noise irrelevant by design** — evidence screenshots are not diffed, so Windows/Linux/Darwin font and AA differences don't matter. If goldens are ever added later (out of scope here), this assumption flips and OS-specific baselines become a real concern.

## Success Criteria (Summary)

- A parent receives an invitation, opens `/meetings`, sees it in the Pending section with no conflict warning (no overlapping commitments), clicks Accept, and the meeting appears in their Upcoming section with "Created by `<inviter>`" — completing the PRD's primary success-criteria flow end-to-end for the first time.
- A second invitation overlapping the first surfaces a yellow inline conflict warning naming the clashing meeting; the parent can still Accept (informational warning), or Decline.
- A parent who already responded sees the row no longer in Pending; the API rejects a repeat attempt with 404 (one-shot enforced); the creator sees the per-invitee status update on their own Upcoming list.
