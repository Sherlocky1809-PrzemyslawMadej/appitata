# Meeting Accept with Conflict and List (S-03) Implementation Plan

## Overview

S-03 closes the co-care loop: an invited parent can accept or decline a pending meeting invitation, sees a conflict warning at accept-time if the meeting overlaps something already on their schedule (FR-009), and the `/meetings` page reshapes into three sections — Pending invitations → Upcoming → Past (FR-010) — drawn from a single combined view of meetings the parent created OR has already accepted. The data layer is mostly ready from S-02; this slice adds one column (`responded_at`), one RLS UPDATE policy, one column-level GRANT, one new API endpoint (mirror of `/api/friends/respond`), an SSR-side conflict-detection map on the page, and a perspective-aware list component.

## Current State Analysis

- **Data layer (S-02, archived).** `public.meetings` + `public.meeting_invitations` ship in `supabase/migrations/20260528105428_meetings_foundation.sql` with the `meeting_invitation_status` enum carrying all four values (`pending / accepted / declined / expired`) from day one. Cross-table SELECT helpers (`public.user_is_meeting_invitee`, `public.user_is_meeting_creator`) bypass RLS recursion. There is **no UPDATE policy** on `meeting_invitations` today. The migration runs `revoke update, delete on public.meeting_invitations from authenticated` — the REVOKE-first half of the column-grant pattern is **already in place**, so S-03 only needs the column-level GRANT.
- **API surface (S-02, archived).** `POST /api/meetings` and `DELETE /api/meetings/[id]` exist. No respond endpoint. The friend-respond endpoint at `src/pages/api/friends/respond.ts` is the structural twin to mirror.
- **Page (S-02, archived).** `/meetings.astro` SSR-loads only meetings the user **created** (`eq("creator_id", user.id)`). It does not load pending invitations the user has received, nor accepted invitations. The page renders the create form and a single "My created meetings" section. The list component `MyMeetingsList.tsx` assumes creator-perspective rendering (per-invitee status badges, delete button).
- **Mirror pattern in place (S-01, archived).** `IncomingRequestsList.tsx` + `respond.ts` together demonstrate the accept/decline UX in this codebase: POST `{ id, action }` → server `update({ status: nextStatus }).eq("id", id).select().maybeSingle()` → RLS USING gate → 404 if filtered → `window.location.reload()`. S-03's response endpoint reuses this exact shape with `responded_at` co-written.
- **Column-grant precedent (S-01, archived).** `friend_connections` shipped the partial GRANT pattern in `supabase/migrations/20260527103435_friend_connections_foundation.sql`: `revoke update from authenticated; grant update (status) on … to authenticated;`. S-03 follows the same shape on `meeting_invitations(status, responded_at)`.
- **DB types regen.** `src/db/database.types.ts` will need re-running after the migration. The current `meeting_invitations.Row` has no `responded_at`.
- **No SECURITY DEFINER RPC needed.** Unlike `create_meeting_with_invitations` (cross-table mutation), the respond endpoint mutates a single row — supabase-js + RLS UPDATE policy is sufficient. No multi-statement transaction required.

## Desired End State

- A parent navigates to `/meetings` and immediately sees three sections (above the existing create form on top): **Pending invitations** (with per-row inline conflict warning + Accept/Decline buttons), **Upcoming meetings** (combined creator + accepted-invitee view, future only, date-asc), **Past meetings** (same source, past only, date-desc).
- Clicking Accept on a pending invitation transitions the row to `accepted` + writes `responded_at = now()` atomically, and the page reloads to reflect the new state — including a re-computed conflict map for the remaining pending rows.
- Clicking Decline transitions the row to `declined` + writes `responded_at` and reloads.
- A pending invitation whose meeting overlaps the parent's confirmed schedule (own meetings ∪ accepted invitations) renders an inline warning above its Accept/Decline buttons listing the clashing meeting(s) by date+time. Accept stays enabled — the warning is informational; the second click IS the consent.
- A parent cannot change their response after submitting it — the RLS UPDATE policy gates `using (auth.uid() = invitee_id and status = 'pending')` and `with check (status in ('accepted','declined'))`. Attempting it returns 404 from the API.
- A parent cannot accept/decline an invitation that isn't theirs — RLS USING filters the row out; the API returns 404.
- The cross-perspective row template renders correctly: meetings the viewer created show per-invitee status badges + Delete; meetings the viewer was invited to (now accepted) show "Created by <name>" + the viewer's own accepted status, no Delete affordance.
- AGENTS.md `§Current state` reflects the new shape: UPDATE policy + column-level GRANT on `(status, responded_at)`, `responded_at` audit column, the three-section page composition.
- `supabase/tests/meetings-rls.md` carries new blocks proving the UPDATE policy lets the invitee accept/decline a pending invitation, blocks non-invitee, blocks an already-responded row, blocks UPDATE of fields other than `status`/`responded_at`, and confirms the creator cannot UPDATE.

### Key Discoveries:

- The `revoke update on public.meeting_invitations from authenticated` is **already in place** from S-02 ([meetings_foundation.sql:142](supabase/migrations/20260528105428_meetings_foundation.sql#L142)) — S-03 just adds the column-level GRANT and the UPDATE policy.
- Partial indexes already exist for both `pending` and `accepted` lookups on `invitee_id` ([meetings_foundation.sql:43-46](supabase/migrations/20260528105428_meetings_foundation.sql#L43-L46)) — both halves of the SSR query (pending invitations to render, accepted invitations for schedule basis) are pre-indexed.
- The current `meetings` SELECT policy ([meetings_foundation.sql:99-104](supabase/migrations/20260528105428_meetings_foundation.sql#L99-L104)) already allows the invitee to see meetings they're invited to. So a single `from("meetings").select(...)` returns meetings I created + meetings where I have a pending OR accepted invitation. JS-side filtering shapes them into the three sections.
- `IncomingRequestsList.tsx` ([IncomingRequestsList.tsx:29-49](src/components/friends/IncomingRequestsList.tsx#L29-L49)) is the literal structural twin: POST → reload pattern, lucide `Check`/`X` icons, in-flight per-row state, `Button` styling.
- `MyMeetingsList.tsx` already handles the per-invitee status badge palette ([MyMeetingsList.tsx:39-44](src/components/meetings/MyMeetingsList.tsx#L39-L44)) — the same palette is reused for the viewer's own status badge in the invitee-perspective row.
- The `<input type="datetime-local">` ↔ ISO conversion is settled in S-02; S-03 does no datetime input — `responded_at` is set server-side via `new Date().toISOString()`.

## What We're NOT Doing

- Cron expiry of `pending` invitations after 24h — that's S-04 (the enum already carries `expired`; this slice does not write it).
- Editing a meeting after create — still no UPDATE policy on `meetings` (no change from S-02).
- Changing invitee list after create — still no add/remove invitee endpoint.
- Allowing a parent to flip their response (accept↔decline) — one-shot policy; PRD literal.
- A server-side enforcement of no-double-booking — the warning is informational, the server still allows accept on a conflicting invitation (PRD: "before they confirm" — confirm is in the parent's hands).
- A proactive availability view ("which friends are free at this time") — explicit non-goal in PRD §Non-Goals; lands in a future "v2" of the conflict rule.
- A visual calendar grid — PRD §Non-Goals; the list stays a date-sorted list.
- A `responded_at`-driven UI surface (e.g. "you declined 3 hours ago") — the column is recorded but not displayed yet.
- A dashboard counter / topbar pending-invitations badge — out of scope for the slice; the link on `/dashboard` to `/meetings` already exists.
- Pagination or virtualization of the upcoming/past lists — out of scope at MVP `target_scale.users: medium` and "3 friends" secondary success criterion.
- shadcn dialog / toast components — keep the slice component-budget-neutral.
- A SECURITY DEFINER RPC for the respond mutation — single-row update; bare supabase-js + RLS is enough.
- An automated test suite (Playwright, vitest, `node:test`, etc.) — this slice ships UI + API code only; coverage stays manual via the verification matrix at the bottom of the doc. A test-runner story is a Module-3 concern.

## Implementation Approach

**Mirror the friend-respond pattern, end-to-end.** API endpoint, request schema, RLS gating shape, 404-on-RLS-filter-miss, client-side accept/decline UX, and post-respond reload are all already in the repo for `friend_connections`. The S-03 endpoint differs only in: the table is `meeting_invitations`, the additional `responded_at` field is written in the same UPDATE, and the response payload is a 200 with the new status. Defense-in-depth `eq("status", "pending")` on the supabase-js call mirrors the RLS USING — belt-and-suspenders.

**Conflict detection runs server-side in TypeScript, not in SQL.** The Astro page already needs to fetch the parent's full schedule (creator-side + accepted invitee-side) to render the upcoming/past lists. Reuse the same dataset to compute a `Map<invitation_id, ClashingMeeting[]>` for each pending invitation and pass it as a prop to `PendingInvitationsList`. No new RPC. The overlap predicate is the textbook `aStart < bEnd && aEnd > bStart`. This decision keeps the conflict logic auditable as plain JavaScript (a single function in the page frontmatter), avoids the cost of a SECURITY DEFINER SQL function for what is fundamentally a presentation-layer concern, and runs once per page render instead of per Accept click.

**Page composition uses a single SSR fetch of meetings.** Because the existing `meetings_select` RLS policy lets the viewer see meetings where they are creator OR invitee, a bare `supabase.from("meetings").select(...)` returns the union — no `or()` filter needed. JS-side then splits into:

- Pending invitations = invitations where `invitations[i].invitee_id == user.id && invitations[i].status == 'pending'` (need the meeting body for display + conflict math).
- My schedule (for conflict basis) = meetings where I'm creator OR I have an `accepted` invitation.
- Upcoming = my schedule, `starts_at + duration_minutes >= now()`, ascending.
- Past = my schedule, `starts_at + duration_minutes < now()`, descending.

**The meetings list component becomes perspective-aware.** Today's `MyMeetingsList.tsx` (creator-only) becomes a more general `MeetingsList.tsx` taking an explicit `viewerId` and rendering each row based on `meeting.creator_id === viewerId`. Creator-row branch keeps the per-invitee status list + Delete button. Invitee-row branch shows "Created by `<creator_name>`" + the viewer's own accepted status badge, no Delete. The component name change is small and signals the broader semantics.

## Critical Implementation Details

- **RLS UPDATE-policy shape mirrors `friend_connections`**. The USING clause must scope to `status = 'pending'` (so already-responded rows are filtered out and the API returns 404). The WITH CHECK clause must restrict the resulting status to `('accepted', 'declined')` (so a misbehaving client cannot set `status = 'expired'` or `status = 'pending'` again). Both halves are load-bearing; omitting either opens a path to bypass the one-shot rule.
- **Column-level GRANT is required for both `status` AND `responded_at`** — listing only `status` would block the API's two-field UPDATE with a permission error even though RLS WITH CHECK would otherwise pass. Verify post-migration via `\dp meeting_invitations`: `responded_at: authenticated=w/postgres` should appear in the Column privileges row alongside `status: authenticated=w/postgres`. (See the friend_connections lesson preserved in [AGENTS.md §Key conventions](AGENTS.md).)
- **The respond endpoint sets `responded_at` server-side**, not from the client payload. The client never sends the timestamp; the endpoint stamps `new Date().toISOString()` in the same UPDATE that flips `status`. This prevents client-clock drift from polluting an audit column.
- **Conflict math considers `duration_minutes`, not just `starts_at`** (per the Q-Round-2 decision on the upcoming/past boundary). The "ends_at" derivation `new Date(starts_at).getTime() + duration_minutes * 60_000` must be used consistently for both the conflict overlap check AND the upcoming/past split. A second computation site is a drift hazard — extract `meetingEndsAt(m)` once and reuse.

## Phase 1: Data layer

### Overview

One migration that adds the `responded_at` column, the UPDATE policy, and the column-level GRANT. Regenerate types. Extend the RLS test doc with five blocks covering the new surface.

### Changes Required:

#### 1. Migration: `responded_at` + UPDATE policy + column-level GRANT

**File**: `supabase/migrations/20260529120000_meeting_invitations_respond.sql` (new)

**Intent**: Adds the audit column the API will stamp, adds the RLS UPDATE policy that pins which rows can flip and to which states, and adds the column-level GRANT pinning the writeable surface to `(status, responded_at)`. The REVOKE half is already in place from the S-02 migration — do not re-emit it.

**Contract**:

- `alter table public.meeting_invitations add column responded_at timestamptz` (nullable; null while pending, stamped on the first response).
- `create policy meeting_invitations_update on public.meeting_invitations for update to authenticated using (auth.uid() = invitee_id and status = 'pending') with check (auth.uid() = invitee_id and status in ('accepted', 'declined'))`. The USING clause filters the row out for: (a) non-invitee callers, (b) already-responded rows. The WITH CHECK rejects writes that would set `status` to `pending` or `expired`. Status `expired` is reserved for S-04's cron writer (a different role, bypassing RLS).
- `grant update (status, responded_at) on public.meeting_invitations to authenticated;` — pins the column surface. No standalone REVOKE statement; S-02 already revoked the broad UPDATE.
- A `comment on column public.meeting_invitations.responded_at is 'S-03: stamped by the respond endpoint when the invitee accepts or declines. Null while pending.'` for posterity.

#### 2. Regenerate Database types

**File**: `src/db/database.types.ts` (regenerated)

**Intent**: Surface the new `responded_at` field to the TypeScript layer so the API endpoint and the SSR query can read/write it type-safely.

**Contract**: After running `npm run db:types`, `Database["public"]["Tables"]["meeting_invitations"]["Row"]` includes `responded_at: string | null`; the `Insert` and `Update` shapes include the same as optional. Do not hand-edit; the file is mechanically regenerated.

#### 3. Extend RLS test doc with response-side blocks

**File**: `supabase/tests/meetings-rls.md` (append five blocks numbered 9-13)

**Intent**: Prove the new UPDATE surface end-to-end the same way blocks 1-8 covered SELECT/INSERT/DELETE.

**Contract** (titles + intent only; the doc itself carries the SQL): block 9 — invitee (Bob) UPDATEs his own pending invitation to `accepted` ⇒ 1 row affected, `responded_at` non-null. Block 10 — non-invitee (Dave) tries the same UPDATE ⇒ 0 rows (USING filter). Block 11 — invitee tries to UPDATE an already-`accepted` invitation back to `declined` ⇒ 0 rows (USING `status = 'pending'` filter). Block 12 — invitee tries to UPDATE the invitation to `status = 'expired'` ⇒ rejected by WITH CHECK (ERROR: new row violates row-level security policy). Block 13 — invitee tries to UPDATE `invited_at` (not in column grant) ⇒ permission denied for table (column-level GRANT scope). Mirrors the friend_connections test convention used in [friend-connections-rls.md](supabase/tests/friend-connections-rls.md).

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly on a fresh DB: `npm run db:reset` returns 0 with no error output.
- DB types regenerate without errors: `npm run db:types` succeeds; the resulting file contains `responded_at` in `meeting_invitations`.
- Type-check still passes after types regen (the column is a strict addition; existing reads are unaffected): `npm run astro check`.

#### Manual Verification:

- All five new blocks in `supabase/tests/meetings-rls.md` produce the documented `expect:` outputs when run in Supabase Studio against a freshly reset local DB.
- `\dp meeting_invitations` shows `authenticated=arw/postgres` at table level (read + delete-via-cascade only; no broad write — UPDATE was already revoked in S-02) and `status: authenticated=w/postgres` AND `responded_at: authenticated=w/postgres` in the Column privileges column.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Server-side wiring

### Overview

Add the respond endpoint mirroring `/api/friends/respond.ts`. Rewrite `/meetings.astro`'s SSR data fetch to load pending invitations + a combined creator-OR-accepted-invitee meetings query, and compute the conflict map server-side. Define shared TypeScript types for the new payload shapes.

### Changes Required:

#### 1. Respond endpoint

**File**: `src/pages/api/meetings/invitations/respond.ts` (new)

**Intent**: Accept a `{ invitation_id, action: "accept" | "decline" }` payload and flip the invitation's `status` + stamp `responded_at` in one supabase-js UPDATE. Rely on the new RLS UPDATE policy for authz; map RLS-filter misses to 404. Mirror `/api/friends/respond.ts` shape literally.

**Contract**:

- `POST` route. zod schema: `{ invitation_id: z.string().regex(UUID_SHAPE, "invalid UUID"), action: z.enum(["accept", "decline"]) }`. Use the same `UUID_SHAPE` constant pattern used in `/api/meetings/index.ts` and `/api/friends/respond.ts` (define locally; do not extract yet).
- Unauthenticated → 401. Invalid JSON → 400 "invalid json". Schema-invalid → 400 with the first issue's message.
- `nextStatus = parsed.data.action === "accept" ? "accepted" : "declined"`.
- supabase call: `.from("meeting_invitations").update({ status: nextStatus, responded_at: new Date().toISOString() }).eq("id", parsed.data.invitation_id).eq("status", "pending").select("id, status, responded_at").maybeSingle()`. The defense-in-depth `eq("status", "pending")` mirrors RLS USING; even if the policy were softened, this guarantees one-shot semantics at the API layer.
- supabase error → 500 with `error.message`. `data == null` → 404 "not found" (RLS USING filtered the row out: it doesn't exist, the caller isn't the invitee, or the status is no longer pending).
- Success → 200 with `{ id, status, responded_at }`. Same JSON helper as the friend-respond file.

#### 2. SSR rewrite on /meetings.astro

**File**: `src/pages/meetings.astro`

**Intent**: Replace the creator-only meetings query with a combined fetch covering all three sections, plus compute the conflict map server-side and hand it to the pending-invitations component.

**Contract**:

- Keep the existing `list_my_friends` fetch (still needed for the create form's friend picker).
- Replace the single `from("meetings").select(...).eq("creator_id", user.id)` with a single `from("meetings").select("id, starts_at, duration_minutes, street, city, postal_code, country, description, created_at, creator:parents!creator_id(id, display_name), invitations:meeting_invitations(id, status, invited_at, responded_at, invitee:parents!invitee_id(id, display_name))").order("starts_at", { ascending: true })`. No `.eq("creator_id", ...)` — RLS returns the creator-OR-invitee union.
- Add an `endsAt(m)` helper in the frontmatter computing `new Date(m.starts_at).getTime() + m.duration_minutes * 60_000`. Reused by both the conflict map and the upcoming/past split.
- Compute four derived arrays from the unified `meetings` result:
  - `pendingInvitations` — for each meeting where some `invitations[i].invitee_id === user.id && invitations[i].status === 'pending'`, project a `{ invitation_id, meeting }` pair.
  - `myScheduleForConflicts` — meetings where (a) `creator_id === user.id` OR (b) some `invitations[i].invitee_id === user.id && status === 'accepted'`. Used only as the conflict basis.
  - `upcoming` — same filter as `myScheduleForConflicts`, additionally `endsAt(m) >= now`, sorted asc.
  - `past` — same as upcoming, `endsAt(m) < now`, sorted **desc** (most-recent past first; date-sorted but reversed for the past bucket).
- Compute `conflictsByInvitationId: Record<invitation_id, ClashingMeetingSummary[]>` via the overlap predicate `mStart < piEnd && mEnd > piStart`, excluding the invitation's own meeting from the basis (it isn't in `myScheduleForConflicts` anyway because the invitation is pending, but assert this with a `.filter(m => m.id !== pi.meeting.id)` for defense-in-depth).
- Pass `pendingInvitations`, `conflictsByInvitationId`, `upcoming`, `past`, and `viewerId = user.id` to the React components.
- `loadError` and the existing `if (loadError) ... else { ... }` shape stay; only the queries inside change.

#### 3. Shared types for the new SSR payload shapes

**File**: `src/components/meetings/types.ts` (new; or inline-export from the component files)

**Intent**: Centralise the TypeScript types the page passes into the new and refactored components so the page frontmatter stays readable.

**Contract**: Export `MeetingRow` (the unified row used by the upcoming/past list, including `creator: { id, display_name }` and `invitations: InvitationRow[]`), `InvitationRow` (with `responded_at: string | null`), `PendingInvitation` (`{ invitation_id, meeting }`), and `ClashingMeetingSummary` (`{ id, starts_at, duration_minutes }`). The friends pattern inlines its types into each component file (e.g. `IncomingRequest` in `IncomingRequestsList.tsx`); follow the same convention here unless the type is genuinely shared across components — in which case `src/components/meetings/types.ts` is the home. Default: inline each component's prop type into its own file; only extract to `types.ts` if two components both need the same shape (e.g. `MeetingRow` used by both the upcoming and past lists).

### Success Criteria:

#### Automated Verification:

- Type-check passes: `npm run astro check` returns 0 with the new SSR shape + the new endpoint.
- Lint passes on the new/changed files: `npx eslint src/pages/api/meetings/invitations/respond.ts src/pages/meetings.astro src/components/meetings/types.ts` (the Windows-CRLF posture from [feedback memory](feedback_windows_crlf_lint.md) applies — only touched paths).
- Build passes (Cloudflare Workers runtime catches a few edge-case TS issues lint misses): `npm run build`.
- (No new unit tests in this slice; verification is via the manual matrix below + the RLS test doc from Phase 1.)

#### Manual Verification:

- Curl/REST probe: signed-in as Bob, POST `/api/meetings/invitations/respond` with a valid `{ invitation_id, action: "accept" }` returns 200 with `{ id, status: "accepted", responded_at: <ISO> }`. The DB row reflects the change.
- Signed-in as Bob, POST with action `"decline"` on a different pending invitation returns 200 with `status: "declined"`.
- Signed-in as Bob, POST with an `invitation_id` Bob never received → 404 "not found".
- Signed-in as Bob, POST with an already-accepted `invitation_id` → 404 "not found" (one-shot enforced).
- Signed-in as Bob, POST with `action: "expired"` → 400 (zod enum rejects).
- Unauthenticated POST → 401 "unauthorized".
- Opening `/meetings` after a few accepts/declines: the SSR data shape is correct (pending count, upcoming count, past count match the DB expectations; `conflictsByInvitationId` keys match the pending IDs).

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: UI + integration

### Overview

Restructure `/meetings.astro` into three sections, ship `PendingInvitationsList` (new), refactor `MyMeetingsList` → `MeetingsList` (perspective-aware), and refresh AGENTS.md's `§Current state` to reflect S-03 landed.

### Changes Required:

#### 1. PendingInvitationsList component

**File**: `src/components/meetings/PendingInvitationsList.tsx` (new)

**Intent**: Render each pending invitation as a card with the meeting summary (when/where/who-from/description), an inline conflict warning if `conflictsByInvitationId[invitation_id]` is non-empty, and Accept/Decline buttons mirroring `IncomingRequestsList`.

**Contract**:

- Props: `{ invitations: PendingInvitation[]; conflicts: Record<string, ClashingMeetingSummary[]> }`.
- Empty state: "No pending invitations." (matches the `IncomingRequestsList` vocabulary).
- Per-row layout: top — display the meeting starts_at (formatted via `toLocaleString()`), duration, address summary, creator display_name, description. Conflict block — only when `conflicts[id].length > 0`: a yellow notice card (`border-amber-400/40 bg-amber-500/10 text-amber-200`) with `data-testid="conflict-warning"` reading "Heads up — this overlaps with: " then a bulleted list of clashing meetings by `toLocaleString(starts_at)` + duration. Accept (emerald, `<Check>` icon) + Decline (outline ghost, `<X>` icon) buttons aligned to the right.
- **Test hooks.** Each `<li>` row receives `data-testid="pending-invitation"` and `data-invitation-id={r.invitation_id}`. The conflict notice card receives `data-testid="conflict-warning"`. The Accept/Decline buttons receive `data-testid="accept-button"` / `data-testid="decline-button"` respectively. These give a future test harness stable selectors that don't couple to copy. Adding them is a one-attribute-per-element delta with zero behavioral impact.
- In-flight state: `const [pendingId, setPendingId] = useState<string | null>(null)` mirroring `IncomingRequestsList`. Both buttons disabled when `pendingId === r.invitation_id`.
- On click: fetch `/api/meetings/invitations/respond` with `{ invitation_id, action }`. On 2xx → `window.location.reload()`. On error → setError with the body's `error` field (fallback "Could not respond"). Catch → "Network error".
- Use the same `Button` import from `@/components/ui/button`, same lucide icons (`Check`, `X`), and same color vocabulary as `IncomingRequestsList`. No new shadcn components.

#### 2. Refactor MyMeetingsList → MeetingsList (perspective-aware)

**File**: `src/components/meetings/MyMeetingsList.tsx` → renamed to `src/components/meetings/MeetingsList.tsx` (file rename); the type `MeetingWithInvitations` becomes `MeetingRow` and gets `creator: { id, display_name }`

**Intent**: Make the list component handle both creator and invitee perspectives so it can render the unified upcoming/past lists without two parallel components.

**Contract**:

- Props change from `{ meetings: MeetingWithInvitations[] }` to `{ meetings: MeetingRow[]; viewerId: string; emptyMessage?: string }`. `emptyMessage` defaults to "No meetings here yet." but is overridden per usage ("No upcoming meetings." / "No past meetings.").
- Per-row branch: `const isCreator = m.creator.id === viewerId`. The summary header (`<summary>`) shows date + duration unchanged. The expanded body shows:
  - **Creator branch** (`isCreator === true`): unchanged from today — Address, Description, full Invitations list with badges, Delete button. The "accepted/total" counter in the summary stays.
  - **Invitee branch** (`isCreator === false`): Address, Description, "Created by `<m.creator.display_name>`" line, and the viewer's own status badge (always `accepted` for upcoming/past rows since pending lives in section 1; assert and render `accepted` badge from `m.invitations.find(i => i.invitee_id === viewerId)`). No Delete button.
- Pass-through: the Delete-cascade logic and the in-flight delete state stay; they just become guarded by `isCreator`.
- Update the importing page (`/meetings.astro`) to import `MeetingsList` from the new file path; update the `type { MeetingRow }` import. `MyMeetingsList` is fully replaced — no re-export shim, no aliased import (no backwards-compat artefacts per repo posture).
- Note for the implementer: the `<details>` element's open-state-loss on reload is a known UX nit; out of scope here.

#### 3. /meetings.astro three-section composition

**File**: `src/pages/meetings.astro`

**Intent**: Replace the single "My created meetings" section with three: Pending invitations, Upcoming, Past. Keep "Create new meeting" on top.

**Contract**:

- Section order top-to-bottom: header, error banner (existing), Create new meeting (existing), **Pending invitations**, **Upcoming meetings**, **Past meetings**.
- Each new section is the same `<section class="rounded-2xl border border-white/10 bg-white/10 p-6 text-white backdrop-blur-xl">` envelope used today.
- Pending section: `<h2>Pending invitations</h2>` + `<PendingInvitationsList invitations={pendingInvitations} conflicts={conflictsByInvitationId} client:visible />`. Section is hidden entirely when `pendingInvitations.length === 0` AND the page has at least one upcoming or past meeting (i.e. the parent has been active before); otherwise the empty-state message renders.
- Upcoming section: `<h2>Upcoming meetings</h2>` + `<MeetingsList meetings={upcoming} viewerId={user.id} emptyMessage="No upcoming meetings." client:visible />`.
- Past section: `<h2>Past meetings</h2>` + `<MeetingsList meetings={past} viewerId={user.id} emptyMessage="No past meetings." client:visible />`.
- The friend-picker SSR data + the create form (`<MeetingCreateForm>`) are unchanged.

#### 4. AGENTS.md §Current state refresh

**File**: `AGENTS.md`

**Intent**: Update the §Current state paragraph to reflect that S-03 has landed: the UPDATE policy + column-level GRANT on `(status, responded_at)` is in place, the `/meetings` page is three-section, and the cron-expiry is the only remaining S-04 follow-up. Drop the "accept/decline transitions and conflict warning ship in the next slice (S-03)" line because that's now historical.

**Contract**: The current paragraph ends with "accept/decline transitions and conflict warning ship in the next slice (S-03), cron expiry in S-04." After this slice: replace with "Accept/decline transitions are gated by a `meeting_invitations_update` RLS policy (one-shot, `pending → accepted|declined`), and the API stamps a `responded_at` audit column via a column-level GRANT on `(status, responded_at)`. The `/meetings` page renders three sections (Pending invitations with inline conflict warning → Upcoming → Past, the latter two sourced from a unified creator-OR-accepted-invitee meetings query). Cron expiry of unanswered invitations lands in S-04." Adjust the surrounding sentence flow so the prose reads coherently with the rest of the section.

### Success Criteria:

#### Automated Verification:

- Type-check passes: `npm run astro check` returns 0 across the new component, the renamed list, and the updated page.
- Lint passes on touched files only (Windows-CRLF posture): `npx eslint src/components/meetings/PendingInvitationsList.tsx src/components/meetings/MeetingsList.tsx src/pages/meetings.astro`.
- Build passes: `npm run build`.

#### Manual Verification:

- Sign in as Alice (creator), `/meetings` renders: Create form on top, an empty Pending invitations section (Alice received no invites in seed), one Upcoming meeting (the one Alice would create as part of the verification flow), no Past meetings yet.
- Create a meeting for Saturday 2pm inviting Bob. Sign out, sign in as Bob. `/meetings` renders: Create form, one Pending invitation (Alice's meeting), Upcoming empty, Past empty.
- Click Accept on Bob's pending invitation. Page reloads. Pending section now empty; the meeting appears in Upcoming with creator name "Alice" and no Delete button.
- As Alice, create a second meeting for the same Saturday 2pm inviting Bob. Sign in as Bob. `/meetings` shows a pending invitation with an inline yellow conflict warning naming the already-accepted Saturday 2pm meeting. Click Decline. Page reloads. Decline-branch verified: no longer pending, doesn't appear in Upcoming.
- Sign in as Alice, `/meetings` Upcoming shows one accepted Saturday 2pm meeting (per-invitee status = accepted for Bob on the first; declined for Bob on the second — which Alice sees because she's the creator).
- A past-dated meeting (manually seed or wait) renders in the Past section with descending order.
- A 404 happens when Bob attempts to respond to a stale page after Alice deleted the meeting: error banner shows "not found" via the existing `error` state.
- AGENTS.md `§Current state` reads coherently with S-03 reflected; the "accept/decline … ships in S-03" line is removed and the new RLS policy + column-grant + three-section page composition are described.

**Implementation Note**: This is the final phase. After all automated checks pass and the manual matrix is confirmed, the slice is done.

---

## Testing Strategy

### Unit Tests:

- None added in this slice. The repo still has no unit-test runner configured; a `vitest`-style runner remains a Module-3 concern.

### Integration / E2E Tests:

- No automated suite in this slice. Coverage is the manual matrix at the bottom of Phase 3 (six UI flows: 3.4-3.9) plus the Phase 2 negative-path API checks (2.6-2.9), executed by a human in a browser / curl after each meaningful change. The testid hooks shipped in Phase 3 (`pending-invitation` / `conflict-warning` / `accept-button` / `decline-button` + `data-invitation-id`) are in place so a future test harness can wire onto stable selectors.

### Manual Testing Steps:

1. `npm run db:reset` to apply the new migration.
2. `npm run db:types` to regenerate types.
3. Open Supabase Studio → SQL editor and run each of blocks 9-13 from the updated `supabase/tests/meetings-rls.md`. Every block's `expect:` comment must match.
4. `npm run dev`. Sign in as Alice. Create a meeting for Saturday 2pm inviting Bob. Sign out.
5. Sign in as Bob. Verify the pending invitation shows with no conflict warning. Accept. Verify it moves to Upcoming with creator branch correctness ("Created by Alice", no Delete).
6. Sign in as Alice. Create a second meeting for Saturday 2pm inviting Bob. Sign out.
7. Sign in as Bob. Verify the new pending invitation shows with a yellow conflict warning naming Alice's first meeting. Decline. Verify it does not move to Upcoming.
8. Negative path: in Bob's session, try POSTing the respond endpoint with the just-declined invitation_id → 404. Try with action = "expired" → 400.
9. Verify AGENTS.md §Current state reads coherently and reflects the S-03 changes.

## Performance Considerations

- The pending invitations partial index (`meeting_invitations_invitee_pending_idx`) and the accepted invitations partial index (`meeting_invitations_invitee_accepted_idx`) are in place from S-02. Both halves of the SSR fetch are pre-indexed.
- The conflict map computation is O(P × S) where P = pending invitations, S = parent's confirmed schedule. At PRD `target_scale.users: medium` + the "3 friends" secondary success criterion, P × S is comfortably small (< 100 × 100 = 10k JS operations on render). No optimisation needed.
- The unified meetings SSR query returns the parent's full history. At MVP scale this is fine; if a parent ever accumulates >500 past meetings, the page-render hit would be visible. Pagination is an explicit non-goal here; revisit when a real user hits that volume.

## Migration Notes

- The new migration is additive: it adds a nullable column, adds a policy, and adds a column GRANT. It does not touch existing rows. Pre-S-03 invitation rows have `responded_at = null`; that's the expected state for any row that was created before the audit column existed.
- No data backfill required.
- Rollback (local-only): a hypothetical `drop policy meeting_invitations_update on public.meeting_invitations; alter table public.meeting_invitations drop column responded_at;` would revert the schema. No remote migrations are pushed (per the AGENTS.md scope posture).

## References

- Prior slice (archived): `context/archive/2026-05-28-meeting-creation-and-invite/plan.md` — S-02 data layer this slice extends.
- Friend-respond pattern: `src/pages/api/friends/respond.ts`, `src/components/friends/IncomingRequestsList.tsx`.
- Column-level GRANT (REVOKE-first) precedent: `supabase/migrations/20260527103435_friend_connections_foundation.sql:65-78`.
- Cross-table SELECT helpers: `supabase/migrations/20260528105428_meetings_foundation.sql:48-94`.
- PRD: `context/foundation/prd.md` §FR-008, §FR-009, §FR-010, §Business Logic.
- AGENTS.md §Current state, §Key conventions (Column-level partial-UPDATE GRANT, Cross-table visibility, Cross-table mutation via SECURITY DEFINER RPC — last one informs why S-03 does NOT need an RPC).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data layer

#### Automated

- [x] 1.1 Migration applies cleanly on a fresh DB: `npm run db:reset` returns 0 with no error output — 4907439
- [x] 1.2 DB types regenerate without errors: `npm run db:types` succeeds; the resulting file contains `responded_at` in `meeting_invitations` — 4907439
- [x] 1.3 Type-check still passes after types regen: `npm run astro check` — 4907439

#### Manual

- [x] 1.4 All five new blocks in `supabase/tests/meetings-rls.md` produce the documented `expect:` outputs when run in Supabase Studio against a freshly reset local DB — 4907439
- [x] 1.5 `\dp meeting_invitations` shows the expected table-level + column-level grants (no broad UPDATE; `status` + `responded_at` writeable to authenticated) — 4907439

### Phase 2: Server-side wiring

#### Automated

- [x] 2.1 Type-check passes: `npm run astro check` returns 0 with the new SSR shape + the new endpoint — abf1851
- [x] 2.2 Lint passes on touched files: `npx eslint src/pages/api/meetings/invitations/respond.ts src/pages/meetings.astro src/components/meetings/types.ts` (Windows-CRLF posture — touched paths only) — abf1851
- [x] 2.3 Build passes: `npm run build` — abf1851

#### Manual

- [x] 2.4 Curl/REST probe: signed-in as Bob, POST `/api/meetings/invitations/respond` with a valid `{ invitation_id, action: "accept" }` returns 200 with `{ id, status: "accepted", responded_at: <ISO> }` and the DB row reflects the change — abf1851
- [x] 2.5 Signed-in as Bob, POST with action `"decline"` on a different pending invitation returns 200 with `status: "declined"` — abf1851
- [x] 2.6 Signed-in as Bob, POST with an `invitation_id` Bob never received → 404 "not found" — abf1851
- [x] 2.7 Signed-in as Bob, POST with an already-accepted `invitation_id` → 404 "not found" (one-shot enforced) — abf1851
- [x] 2.8 Signed-in as Bob, POST with `action: "expired"` → 400 (zod enum rejects) — abf1851
- [x] 2.9 Unauthenticated POST → 401 "unauthorized" — abf1851
- [x] 2.10 Opening `/meetings` after a few accepts/declines: the SSR data shape is correct (pending count, upcoming count, past count match the DB expectations; `conflictsByInvitationId` keys match the pending IDs) — abf1851

### Phase 3: UI + integration

#### Automated

- [x] 3.1 Type-check passes: `npm run astro check` returns 0 across the new component, the renamed list, and the updated page — ad4fb64
- [x] 3.2 Lint passes on touched files: `npx eslint src/components/meetings/PendingInvitationsList.tsx src/components/meetings/MeetingsList.tsx src/pages/meetings.astro` — ad4fb64
- [x] 3.3 Build passes: `npm run build` — ad4fb64

#### Manual

- [x] 3.4 As Alice: `/meetings` renders Create form + empty Pending + (after creating one) Upcoming with creator-branch rendering — ad4fb64
- [x] 3.5 As Bob: pending invitation shows; clicking Accept moves it to Upcoming with invitee-branch rendering ("Created by Alice", no Delete) — ad4fb64
- [x] 3.6 As Alice: create a second meeting for the same time inviting Bob. As Bob: pending shows inline yellow conflict warning naming the already-accepted meeting. Decline. Verify it does not move to Upcoming. — ad4fb64
- [x] 3.7 As Alice (creator): Upcoming shows per-invitee status reflecting Bob's accept on first meeting and decline on second — ad4fb64
- [x] 3.8 A past-dated meeting renders in the Past section in descending order — ad4fb64
- [x] 3.9 Stale-page 404: Bob attempts to respond after Alice deleted the meeting → error banner shows "not found" — ad4fb64
- [x] 3.10 AGENTS.md §Current state reads coherently with S-03 reflected; the "accept/decline … ships in S-03" line is removed — ad4fb64
