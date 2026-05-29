# Meeting Creation and Invite — Plan Brief

> Full plan: `context/changes/meeting-creation-and-invite/plan.md`

## What & Why

S-02 is the third foundation slice in AppiTata's co-care loop: a parent creates a meeting (date+time, structured address, description) and atomically invites one or more connected friends. It exists because S-03 (accept-with-conflict) has nothing to operate on without it, and because the time-field shape settled here directly determines how S-03 can express FR-009's overlap check.

## Starting Point

F-01 + S-01 are done and archived: `parents`, `friend_connections`, the `is_connected` helper, `list_my_friends()`, the `find_parent_by_handle` RPC, the column-level GRANT pattern (REVOKE-first), and a `/friends` page with four-section UI all exist. No `meetings`/`meeting_invitations` tables, no `/meetings` route, no datetime input usage anywhere in `src/`. shadcn/ui has only `button.tsx` installed — no date picker, dialog, textarea, or checkbox components.

## Desired End State

The creator can open `/meetings`, fill in a combined form (date+time, 4 address fields, description, checkboxed friend-picker), submit once, and see the new meeting appear in their flat "My created meetings" list with a per-invitee status badge under it. The creator can delete a meeting (cascades to invitations); fields are immutable after create. The invitee's data is in place in the DB (RLS allows them to see meetings they're invited to) but the invitee-side UI lands in S-03, not here.

## Key Decisions Made

| Decision                          | Choice                                                                                 | Why (1 sentence)                                                                                                                              | Source |
| --------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Time field shape                  | `starts_at timestamptz` + `duration_minutes int` (default 60, hidden from user)        | Lets S-03 implement true interval-overlap conflict warnings without forcing the user to type a duration; satisfies the roadmap S-02 risk note | Plan   |
| Structured address fields         | `street + city + postal_code + country` (4 NOT NULL text columns)                      | Matches roadmap S-02's documented default and PRD's "structured, not free text" demand                                                        | Plan   |
| Description constraints           | NOT NULL, 1–500 chars, plain text                                                      | Forces the creator to provide context; cap prevents pathological writes                                                                       | Plan   |
| Invitation status enum            | `pending / accepted / declined / expired` (all 4 from day one)                         | One migration covers the whole slice; S-03/S-04 don't need ALTER TYPE; read-side filters are type-safe immediately                            | Plan   |
| Create + invite form shape        | Single combined form, atomic via SECURITY DEFINER RPC                                  | Matches PRD acceptance flow literally; cross-table insert atomicity isn't expressible without an RPC in supabase-js                           | Plan   |
| Friend picker UI                  | Inline checkbox list rendered from `list_my_friends()`                                 | No new shadcn components needed; transparent at MVP scale (≤30 friends per parent); accessible by default                                     | Plan   |
| Creator-side list view in S-02    | Minimal "My created meetings" — flat date-ascending, all statuses                      | Lets the creator verify the slice end-to-end without stealing FR-010's upcoming/past split from S-03                                          | Plan   |
| Per-invitee status visibility     | Per-invitee row with display_name + status badge                                       | The creator gets the answer the slice exists to give them ("did Bob accept?"); data already in the SSR query                                  | Plan   |
| Editing a meeting after create    | No — fields are immutable; no UPDATE policy, no UPDATE grant                           | Avoids the "Bob accepted a meeting whose time then changed" problem entirely; PRD doesn't require edit                                        | Plan   |
| Deleting a meeting after create   | Yes — creator-only DELETE, cascade to invitations via FK, native `window.confirm()`    | Given edit=no, delete is the only path to curate the list; cascade keeps invariants clean; native confirm avoids installing a dialog          | Plan   |
| Adding more invitees later        | No — invitee list is final at create                                                   | Smallest scope; consistent with edit=no; the invariant "meeting_invitations is the create-time manifest" is easy to reason about              | Plan   |
| Connected-friend validation owner | Inside the RPC (loop + `is_connected` check), not RLS WITH CHECK                       | Typed exception → specific HTTP error → actionable UI message; same transaction as the inserts                                                | Plan   |
| Friend picker data source         | `list_my_friends()` RPC, not bare `parents` select                                     | `parents_select` was widened in S-01 for pending FCs; bare select would offer not-yet-accepted friends as invitees                            | Plan   |
| Datetime client-side conversion   | `new Date(value).toISOString()` before POST; API zod requires strict ISO with timezone | `<input type="datetime-local">` has no TZ marker; relying on Postgres session TZ is fragile                                                   | Plan   |

## Scope

**In scope:**

- `meetings` + `meeting_invitations` tables with full enum, cross-table SELECT RLS, creator-only INSERT/DELETE on meetings, creator-only INSERT on invitations
- `create_meeting_with_invitations(...)` RPC (atomic, validates `is_connected`)
- `POST /api/meetings` + `DELETE /api/meetings/[id]` (zod-validated)
- `/meetings` page with combined create form + flat creator's meetings list
- `MeetingCreateForm` + `MyMeetingsList` React components
- Middleware update (`/meetings` in `PROTECTED_ROUTES`)
- Dashboard link to `/meetings`
- New `supabase/tests/meetings-rls.md` covering both sides of cross-table visibility
- AGENTS.md refresh (§Current state + new Cross-table-visibility convention bullet)

**Out of scope:**

- Editing a meeting after create (no UPDATE policy)
- Adding invitees after create (no add-invitee endpoint)
- Removing individual invitees
- Invitee accept/decline UI (S-03)
- Conflict warning on accept (S-03; FR-009)
- Upcoming/past split on the meetings list (S-03; FR-010)
- Cron expiry of unanswered invitations (S-04; FR-008 hardening)
- `responded_at` audit column (S-03 lands it)
- Bulk operations, pagination, time-zone preferences
- shadcn dialog / datepicker / textarea / checkbox components (use raw elements styled inline)
- Pushing migrations to a remote Supabase project
- pgTAP / automated SQL tests

## Architecture / Approach

**Cross-table RLS pattern**: a meeting is visible to its creator OR to any parent who has an invitation row for it; an invitation is visible to its invitee OR to the meeting's creator. The `EXISTS` subqueries in both SELECT policies must qualify the outer-table column (e.g., `mi.meeting_id = public.meetings.id`, not bare `meeting_id = id`) — a hazard S-01 already documented for `parents_select`.

**Atomic create via RPC**: `supabase.rpc('create_meeting_with_invitations', { ... })` wraps a meeting insert + N invitation inserts in one Postgres transaction. The RPC iterates the invitee array and calls `is_connected(auth.uid(), invitee)` for each, raising `'invitee not connected'` (errcode 42501) on failure. The API handler maps that to HTTP 403. Two-step API-side inserts would not be atomic in supabase-js.

**Immutability via missing GRANT**: `meetings` and `meeting_invitations` ship with `revoke update on … from authenticated`. No UPDATE policy is sufficient — the REVOKE is needed because Supabase pre-grants ALL on every `public` table. S-03 will add the column-level UPDATE grant on `meeting_invitations.status` paired with its accept/decline policy.

**Friend picker source**: SSR-fetched from `list_my_friends()` (not a bare `parents` select) to avoid the pending-FC widening leak.

**UI vocabulary**: reuses `FormField`, `SubmitButton`, `ServerError` from `src/components/auth/`; introduces raw `<input type="datetime-local">` (wrapped via FormField with a `CalendarClock` icon), a raw `<textarea>` styled to match, raw `<input type="checkbox">` rows for the friend picker, and `window.confirm()` for delete. No new shadcn components.

## Phases at a Glance

| Phase                 | What it delivers                                                                                          | Key risk                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Data layer         | Both tables + enum + cross-table RLS + indexes + atomic-create RPC + regenerated types + new SQL test doc | EXISTS subquery shadowing the outer-table column (silent invitee-cant-see-meeting bug); REVOKE-first GRANT needed for immutability               |
| 2. Server-side wiring | `POST /api/meetings` (zod, RPC) + `DELETE /api/meetings/[id]` (RLS-guarded)                               | Datetime ISO conversion: client must convert wall-clock to UTC ISO; zod must enforce strict ISO to prevent fragile Postgres session-TZ parsing   |
| 3. UI + integration   | `/meetings` page + form + list + middleware + dashboard link + AGENTS.md refresh                          | Friend picker must source from `list_my_friends()` not bare `parents` select (pending-FC widening leak); empty-friends disabled state must exist |

**Prerequisites:** F-01 (parents + `is_connected`) and S-01 (friend_connections + `list_my_friends` + `parents_select` widening) must be done — both are archived. No new external dependencies.
**Estimated effort:** ~2-3 sessions across 3 phases (similar shape and surface to S-01).

## Open Risks & Assumptions

- **Cross-table EXISTS shadowing** — the policies must qualify the outer table inside the subquery. The plan's Critical Implementation Details call this out; Phase 1's manual SQL test doc verifies both sides explicitly so a silent failure surfaces immediately.
- **Datetime conversion correctness** — assumes the browser's local TZ is the user's intended meeting TZ. True for the MVP user persona (parents using AppiTata where they live); will surface only if a user is travelling and creates a meeting in a different TZ from where it will happen. PRD doesn't address.
- **Friend picker scales visually only to ~50 friends** — checkbox list with no search/filter is fine at PRD `target_scale.users: medium` + secondary success criterion of "3 or more connected friends". Revisit when a real user has >30.
- **`window.confirm()` UX feels jarring in a modern app** — acceptable for one destructive action; lift to a shadcn dialog when a second one lands.
- **No invitee-side UI in S-02** — verifies S-02's data correctness only via SQL probe + visual confirmation in the creator's view. S-03 will catch any RLS regression by exercising the invitee branch through a real UI.
- **Description and address inputs use raw `<textarea>` and `FormField`-with-extra-icons** — no new shadcn components shipped for one slice. Visual polish from a proper Textarea/DateField may surface in a UX-polish iteration later.

## Success Criteria (Summary)

- A parent can open `/meetings`, fill the combined create form, select one or more connected friends from a checkbox picker, submit once, and see their new meeting appear in the My created meetings list with a per-invitee pending status badge.
- The invitee can see the meeting via a SQL probe (RLS cross-table SELECT works); no UI for the invitee yet (S-03 territory).
- The creator can delete a meeting; the cascade removes all its invitations.
