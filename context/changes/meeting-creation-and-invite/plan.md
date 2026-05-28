# Meeting Creation and Invite Implementation Plan

## Overview

Ship S-02 — a parent creates a meeting (date/time, structured address, description) and atomically invites one or more connected friends — as the third foundation slice that unlocks S-03 (accept-with-conflict) and S-04 (cron expiry). Land two new tables (`meetings`, `meeting_invitations`) with cross-table RLS, the `meeting_invitation_status` enum (full 4 values from day one), a `SECURITY DEFINER` RPC that creates the meeting + N invitations in one transaction with per-invitee `is_connected` validation, and a `/meetings` page with two sections (combined create-and-invite form + flat "my created meetings" list with per-invitee status badges and delete). Meetings are immutable after create; the creator can delete a meeting (cascade to invitations) but cannot edit fields or add invitees later.

## Current State Analysis

- **No `meetings` or `meeting_invitations` tables** exist — nothing in `supabase/migrations/`, nothing referenced from `src/`.
- **`public.is_connected(viewer, owner)`** already returns true for accepted FCs in either direction ([archived plan](../../archive/2026-05-27-friend-connection-handshake/plan.md) §Phase 1). The new invitation RPC consumes it directly to validate every invitee is a connected friend.
- **`public.list_my_friends()`** already returns `(id, display_name)` for accepted-connected parents excluding self ([archived plan](../../archive/2026-05-27-friend-connection-handshake/plan.md) §Phase 1). Phase 3's friend-picker calls it server-side from `meetings.astro` to render the checkbox list.
- **`parents_select`** widens past pure `is_connected` to also expose parents involved in a _pending_ friend-connection ([archived plan](../../archive/2026-05-27-friend-connection-handshake/plan.md) §Critical Implementation Details). The creator's nested SSR query that joins `meeting_invitations.invitee → parents` is safe because every invitee is an _accepted_ connection (the RPC enforces this); we do NOT need to bypass `parents_select` via another RPC for the meeting view.
- **API surface** is auth + friends ([src/pages/api/](../../../src/pages/api/)). Existing handlers under `friends/` use the canonical pattern S-02 mirrors: zod-validated JSON body, inline `UUID_SHAPE` regex, `json()` helper, `context.locals.user` guard with 401, `.maybeSingle()` for RLS-guarded mutations to distinguish "not found" from "access denied" (see [request.ts](../../../src/pages/api/friends/request.ts), [respond.ts](../../../src/pages/api/friends/respond.ts), [requests/[id].ts](../../../src/pages/api/friends/requests/[id].ts)).
- **No `/meetings` page** exists. `src/middleware.ts` has `PROTECTED_ROUTES = ["/dashboard", "/friends"]` — needs `/meetings` added.
- **shadcn/ui** has only `button.tsx` installed ([src/components/ui/](../../../src/components/ui/)) — no `input`, `textarea`, `checkbox`, `select`, `dialog`, or `popover`. The friends slice handles all form input via [FormField](../../../src/components/auth/FormField.tsx), [SubmitButton](../../../src/components/auth/SubmitButton.tsx), and inline `<p>`-based error display (no toast library). S-02 inherits the same vocabulary; description (multi-line) and friend-picker (checkbox list) use thin Tailwind-styled raw elements rather than installing new shadcn components for one slice.
- **`<input type="datetime-local">` is not used anywhere in the codebase** today. The combined form introduces it for date+time entry; the browser produces a wall-clock string (no timezone), so the client must convert to a UTC ISO string before POSTing — `new Date(value).toISOString()` is the idiomatic conversion (browser interprets the wall-clock value in the local TZ, ISO output is UTC).
- **`src/components/auth/FormField.tsx`** requires an `icon: LucideIcon` prop — we pass `CalendarClock` for the datetime field. Its `type` prop is loose; `type="datetime-local"` works without modification.
- **No `src/lib/validation/` module** — S-01 deferred shared zod schemas; S-02 follows suit (inline per handler).
- **No `src/types.ts` with domain DTOs** — types are defined inline in their primary consumer, same as S-01.
- **`src/pages/dashboard.astro`** has the friends link as a hardcoded `<a>` styled identically to the sign-out button ([dashboard.astro:17–22](../../../src/pages/dashboard.astro#L17-L22)) — we mirror the same anchor for `/meetings`.

## Desired End State

- `public.meetings` exists, RLS-protected, with an immutable shape after create (no UPDATE policy / no UPDATE grant), and creator-only DELETE that cascades to invitations via FK `ON DELETE CASCADE`.
- `public.meeting_invitations` exists, RLS-protected, with the `meeting_invitation_status` enum carrying all four values (`pending` / `accepted` / `declined` / `expired`) — S-02 only writes `pending`; S-03 transitions to `accepted` / `declined`; S-04 transitions to `expired`. No UPDATE policy yet (S-03 lands it).
- Cross-table SELECT visibility holds: a meeting is visible to its creator AND to any parent who has a row in `meeting_invitations` for that meeting (any status). An invitation row is visible to its `invitee_id` AND to the meeting's `creator_id`.
- `public.create_meeting_with_invitations(...)` exists as a `SECURITY DEFINER` RPC that, in one transaction, inserts the meeting row (creator = `auth.uid()`), validates that every invitee in the input array is `is_connected(auth.uid(), invitee_id)`, and inserts one `pending` invitation per invitee. Returns the new `meeting_id`. Locked `set search_path = public, pg_temp`, granted `execute … to authenticated`.
- One new JSON API route `POST /api/meetings` (zod-validated body, calls the RPC) and one `DELETE /api/meetings/[id]` (creator-only via RLS), both under `src/pages/api/meetings/`.
- `/meetings` is a protected page with two sections (Create new meeting form + My created meetings list). The form is one combined create + select-invitees submit; the list is flat date-ascending (no past/upcoming split — that ships in S-03), each row showing meeting fields plus a per-invitee row with a status badge and a Delete button at the top.
- `/dashboard` has a visible link to `/meetings` mirroring the existing Friends link.
- `supabase/tests/meetings-rls.md` covers both sides of the cross-table visibility model and the RPC's connected-friend enforcement, with copy-pasteable SQL blocks.
- AGENTS.md §Current state acknowledges the new tables and RPC; §Key conventions gets one new bullet about the cross-table RLS pattern (a meeting is visible via creator-OR-invitee, mirroring how `parents_select` was widened for pending FCs).

### Key Discoveries

- **The combined create + invite form maps cleanly to one transaction**: a single `SECURITY DEFINER` RPC that inserts the meeting row, then bulk-inserts invitations from the `uuid[]` parameter, is atomic without any application-level transaction plumbing — Supabase-js does not expose multi-statement transactions, so an RPC is the only path to atomicity across two tables.
- **`is_connected` validation belongs in the RPC, not in RLS WITH CHECK**: an RLS `WITH CHECK` on `meeting_invitations.insert` _could_ enforce `is_connected(auth.uid(), invitee_id)`, but the error message would be a generic RLS denial ("new row violates row-level security policy"). The RPC raises a typed exception (`'invitee not connected'`) that the API layer maps to a specific HTTP error, giving the UI an actionable message.
- **Cross-table EXISTS in RLS requires explicit qualification inside the subquery** (the lesson from S-01 Critical Implementation Details — bare `id` inside an `EXISTS` scoped to another table shadows the outer table). The `meetings_select` policy's EXISTS subquery on `meeting_invitations mi` must write `mi.meeting_id = public.meetings.id`, not bare `meeting_id = id`.
- **`<input type="datetime-local">`** has no timezone — `new Date(value)` parses it in the browser's local TZ, and `.toISOString()` then produces a UTC ISO string. Sending the UTC ISO to a `timestamptz` column round-trips correctly. (The alternative — sending the wall-clock string and letting Postgres interpret it with the session TZ — is fragile because the Workers runtime's session TZ is not the user's.)
- **The friend-picker's data source is `list_my_friends()`** (already shipped in S-01), not a bare `select id, display_name from parents`. The latter would also return parents with pending FCs (because `parents_select` was widened for the friend-handshake UX), which would let the creator invite a not-yet-accepted friend. The RPC would reject this at insert-time, but the UI would be misleading.
- **The S-01 friends slice already established that `list_my_friends()` is the canonical "accepted-only connected parents" source** — using it here keeps the seam clean and avoids inventing a `parents`-filter that re-implements the same logic.
- **The unique constraint `(meeting_id, invitee_id)` on invitations** prevents the form from accidentally double-inviting (e.g., if the checkbox state and the submit handler disagree); the RPC's bulk insert would error 23505, and the API maps to 422.
- **`grant select, insert on meeting_invitations` without an UPDATE grant** in S-02 is intentional: S-03 will land the UPDATE policy + the column-level grant restricting mutability to `status` (mirroring the `friend_connections.status` pattern documented in AGENTS.md §Key conventions).

## What We're NOT Doing

- **Editing a meeting** — date/time, address, description, and invitee list are all immutable after create. No UPDATE policy on `meetings`, no UPDATE grant. The creator's recourse for any mistake is delete + recreate.
- **Adding invitees after meeting creation** — no `POST /api/meetings/[id]/invite`, no UI affordance. The invitee list is final at create-time.
- **Removing individual invitees** — the creator cannot uninvite one friend while keeping the meeting. Delete + recreate covers the rare case.
- **Invitee accept/decline UX** — that's S-03. S-02 ships the data model (the `pending` row), the cross-table RLS that lets the invitee SEE the meeting, and stops there. No invitee-side `/meetings` view in this slice.
- **Conflict warning on invitation accept (FR-009)** — S-03. S-02's only contribution is making sure the time-field shape (`starts_at` + `duration_minutes`) is the one S-03 needs for its overlap check.
- **Upcoming / past split on the meeting list (FR-010)** — S-03. S-02 ships a flat date-ascending list so the creator can verify their meeting round-tripped; S-03 wraps it in the upcoming/past presentation.
- **Cron expiry of unanswered invitations (FR-008 hardening)** — S-04. S-02 ships the `'expired'` enum value so S-03/S-04 can read/write it without ALTER TYPE, and stops there.
- **Editing the meeting description even when other fields are locked** — considered as a compromise; rejected to keep the no-UPDATE invariant clean. Trivial typo-fix scope creep that opens questions about column-level grants for one slice.
- **`responded_at` audit column on `meeting_invitations`** — S-03 owns the accept/decline transition; the column lands there. S-02 ships only `invited_at`.
- **A unique invite link or shareable URL for a meeting** — every surface is signed-in (per AGENTS.md §About AppiTata), so a meeting is reached only via the invitee's `/meetings` page (S-03) or the creator's list. No public URL.
- **Personal "note from creator to invitee" field on the invitation** — PRD lists meeting description as the only free-text field; per-invitee notes are not in scope.
- **Time zone display preferences** — meetings store `timestamptz` (UTC inside); the UI uses `toLocaleString()` to render in the viewer's browser TZ, same as the friend-handshake `requested_at` rendering. No explicit TZ field on the meeting.
- **shadcn components for date picker, dialog, textarea, checkbox** — none installed; not adding any. Use raw `<input type="datetime-local">` (wrapped by [FormField](../../../src/components/auth/FormField.tsx) with a `CalendarClock` icon), a raw `<textarea>` styled inline with Tailwind to match `FormField`'s input look, raw `<input type="checkbox">` in the friend-picker list, and `window.confirm()` for the Delete prompt. Lift to a real shadcn dialog later if a future slice needs richer confirmation.
- **Bulk operations** — no "cancel all my meetings" or "invite all my friends" shortcuts. One meeting per submit.
- **Pagination on the creator's meetings list** — MVP `target_scale.users: medium, qps: low`; a single parent's created-meetings count is small. Revisit when a real list grows past a screenful.
- **Pushing migrations to a remote Supabase project** — local Docker remains the verification surface. Same posture as F-01 and S-01.
- **pgTAP / automated SQL tests** — manual RLS walkthroughs in `supabase/tests/*.md` remain the verification surface, mirroring S-01.

## Implementation Approach

Three phases mapping to three layers: **data → server → UI**. Each phase lands one atomic commit and can be reviewed independently. The phase boundaries are chosen so each leaves the working tree consistent — never a half-migrated table that the API code expects.

- **Phase 1** is one atomic migration (both tables + enum + cross-table RLS + indexes + the `create_meeting_with_invitations` RPC) plus the regenerated types plus the new RLS test doc. After Phase 1 the database is fully usable from psql/Studio; no application code calls it yet.
- **Phase 2** wires the server side: two API routes (`POST /api/meetings`, `DELETE /api/meetings/[id]`). After Phase 2 the create + delete flow is exercisable with `curl` against `npm run dev`.
- **Phase 3** wires the UI: `/meetings` page with the combined form + the my-meetings list, middleware update, dashboard link, AGENTS.md refresh. After Phase 3 the creator-side loop works in a browser; the invitee-side data exists in the DB ready for S-03 to render.

## Critical Implementation Details

- **Mutual cross-table RLS recursion — wrap cross-table EXISTS in SECURITY DEFINER helpers.** Bare cross-table EXISTS subqueries in two RLS policies that reference each other (here: `meetings_select` selects from `meeting_invitations`; `meeting_invitations_select` selects from `meetings`) trigger Postgres's infinite-recursion guard (`ERROR: infinite recursion detected in policy for relation "meetings"`) on every SELECT — the planner can't break the cycle. Discovered during Phase 1 verification, after the test doc's blocks 2/3/7/8 all failed with that error. The fix is to wrap each cross-table EXISTS in a `SECURITY DEFINER` helper function (here: `public.user_is_meeting_invitee(p_meeting_id, p_user_id)` and `public.user_is_meeting_creator(p_meeting_id, p_user_id)`) — the definer call bypasses RLS during the lookup, breaking the cycle. Same shape as `is_connected` from F-01 / S-01. The `meeting_invitations_insert` WITH CHECK also uses `user_is_meeting_creator` for consistency (the INSERT path alone wouldn't recurse, but using the helper keeps the abstraction clean).

- **Cross-table EXISTS in RLS USING must qualify the outer table.** The lesson from S-01 (Critical Implementation Details — `parents_select` widening) still applies inside the SECURITY DEFINER helpers above: the EXISTS subqueries reference the helper's parameter names (`p_meeting_id`, `p_user_id`), not the outer table — so shadowing is moot here. If a future migration ever inlines a cross-table EXISTS in a single-direction policy (no recursion partner), this rule kicks back in: write `mi.<fk> = public.<outer_table>.<pk>`, not bare `<fk> = <pk>`.

- **Datetime client-side conversion is load-bearing.** `<input type="datetime-local">` produces a wall-clock string (`"2026-06-15T14:00"`) with no timezone marker. The submit handler MUST convert via `new Date(value).toISOString()` — which parses the wall-clock string in the _browser's_ local TZ, then formats as UTC ISO — before sending to the API. Sending the bare wall-clock string to a `timestamptz` column makes Postgres interpret it using the session TZ (whatever the Workers runtime configures), which is wrong for any user not in that TZ. The API zod schema accepts only `z.string().datetime()` (strict ISO with timezone) to make this contract enforceable.

- **The RPC owns connected-friend validation; the API layer just maps errors.** The RPC iterates the `invitee_ids` array and `raise exception ... using errcode = '42501'` for any invitee that fails `is_connected(auth.uid(), invitee_id)`. The API handler catches that PostgrestError (status 42501 → HTTP 403, message "invitee not connected"). Putting the validation in the API handler (loop over invitees + N round-trips to `is_connected`) is N times the queries and not atomic with the insert — between the check and the insert, the FC could be deleted (out of MVP scope but a real consideration). The RPC's `is_connected` check runs in the same transaction as the inserts.

- **The unique constraint `(meeting_id, invitee_id)` catches duplicate invitees inside the same submit.** If the form's `Set<uuid>` somehow ends up with duplicates (defensive: shouldn't happen with `Set`, but the array passes through the wire), the bulk insert errors 23505. The API maps that to 422 with a "duplicate invitee" message. Without the constraint, duplicate invitations would silently accumulate.

- **The meeting `created_at` defaults to `now()`; `starts_at` is user-supplied.** Don't accidentally use one for the other in queries. The "my created meetings" list orders by `starts_at ASC` (chronological), NOT by `created_at` (creation-order is not what the user wants to see).

- **`description` length CHECK uses `length(trim(description))` for the lower bound, raw `length` for the upper bound.** A description of 500 spaces would pass `length <= 500` but `length(trim(...)) >= 1` rejects it. The same shape is reused for the four address fields.

- **No UPDATE grant on `meetings` at all in S-02.** RLS without an UPDATE policy is still permissive at the GRANT level by Supabase default (the schema setup pre-grants ALL to `authenticated`). The migration MUST `revoke update on public.meetings from authenticated;` even though no UPDATE policy exists, to make the immutability invariant enforceable end-to-end. Same pattern for `meeting_invitations` for the S-02 window (S-03 will pair its UPDATE policy with the column-level grant on `status`).

- **`window.confirm()` is synchronous and blocks the event loop.** It's adequate for a Delete prompt on a single row but feels jarring in a modern app. Living with it in S-02 keeps the slice from installing a shadcn `dialog` component for one usage; lift to a proper confirmation modal when a second destructive action lands.

- **`list_my_friends()`, not bare `parents` select, is the friend-picker's data source.** Phase 3's SSR fetch in `meetings.astro` calls `supabase.rpc('list_my_friends')` to populate the picker's options — because `parents_select` was widened in S-01 to expose pending-FC parents, a bare `parents.select('id, display_name').filter('id', 'neq', user.id)` would let the picker offer a not-yet-accepted friend as an invitee. The RPC would reject at submit-time, but the UI would have misled the user. (Same gotcha S-01 §Phase 3 callout for the Connected friends list.)

## Phase 1: Data layer — meetings + meeting_invitations tables, cross-table RLS, RPC

### Overview

Land one atomic migration that adds `meetings` + `meeting_invitations` + the `meeting_invitation_status` enum, the cross-table SELECT policies, the meeting-side INSERT/DELETE policies (creator-only, no UPDATE), the invitation-side INSERT policy (creator-only, no UPDATE in S-02), the column-level grant strips that pin immutability, the partial indexes for the access patterns S-03 will need, and the `create_meeting_with_invitations` RPC that wraps the whole create flow in one transaction with eager `is_connected` validation. Regenerate types. Add the new RLS test doc.

### Changes Required:

#### 1. New foundation migration for meetings

**File**: `supabase/migrations/<timestamp>_meetings_foundation.sql` (new — generate via `npx supabase migration new meetings_foundation`)

**Intent**: Add both domain tables + enum + cross-table RLS + column-level grant strips + four partial indexes + the SECURITY DEFINER RPC for atomic create. Single migration so the database never lives in a half-state. Every helper hardening posture from F-01 / S-01 carries forward: `set search_path = public, pg_temp`, `security definer` only where required, no public/anon grants, qualified outer-table references inside EXISTS subqueries.

**Contract**: One SQL file. The cross-table SELECT visibility shape (via the `user_is_meeting_invitee` / `user_is_meeting_creator` SECURITY DEFINER helpers — see Critical Implementation Details for _why_ the helpers, not inline EXISTS), the column-level revokes (no UPDATE on either table in S-02), the RPC's signature `create_meeting_with_invitations(timestamptz, int, text, text, text, text, text, uuid[]) returns uuid`, the enum's four values, and the FK `ON DELETE CASCADE` from `meeting_invitations.meeting_id → meetings.id` are all load-bearing — Phase 2's API routes and Phase 3's UI depend on them. The RPC must validate `auth.uid() is not null`, that `cardinality(p_invitee_ids) >= 1`, and that every invitee satisfies `is_connected(auth.uid(), invitee)`; failures raise typed exceptions the API maps to specific HTTP statuses.

> **Note on the SQL block below.** The snippet shows the ORIGINAL intent with bare EXISTS inside the SELECT policies. Phase 1 verification surfaced the mutual-recursion bug; the shipped migration wraps both EXISTS clauses in SECURITY DEFINER helpers (`user_is_meeting_invitee`, `user_is_meeting_creator`). See [supabase/migrations/<timestamp>\_meetings_foundation.sql](../../../supabase/migrations/) for the as-shipped shape and the Critical Implementation Details section above for the lesson.

```sql
-- enum (all 4 values from day one; S-03 transitions to accepted/declined, S-04 to expired)
create type public.meeting_invitation_status as enum ('pending', 'accepted', 'declined', 'expired');

-- meetings table
create table public.meetings (
  id                uuid primary key default gen_random_uuid(),
  creator_id        uuid not null references public.parents(id) on delete cascade,
  starts_at         timestamptz not null,
  duration_minutes  int not null default 60 check (duration_minutes between 1 and 1440),
  street            text not null check (length(trim(street))      between 1 and 200),
  city              text not null check (length(trim(city))        between 1 and 100),
  postal_code       text not null check (length(trim(postal_code)) between 1 and 20),
  country           text not null check (length(trim(country))     between 1 and 100),
  description       text not null check (length(trim(description)) between 1 and 500),
  created_at        timestamptz not null default now()
);

create index meetings_creator_starts_at_idx
  on public.meetings (creator_id, starts_at);

-- meeting_invitations table
create table public.meeting_invitations (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meetings(id) on delete cascade,
  invitee_id  uuid not null references public.parents(id) on delete cascade,
  status      public.meeting_invitation_status not null default 'pending',
  invited_at  timestamptz not null default now(),
  constraint meeting_invitations_unique_pair unique (meeting_id, invitee_id)
);

create index meeting_invitations_meeting_idx
  on public.meeting_invitations (meeting_id);
create index meeting_invitations_invitee_pending_idx
  on public.meeting_invitations (invitee_id) where status = 'pending';
create index meeting_invitations_invitee_accepted_idx
  on public.meeting_invitations (invitee_id) where status = 'accepted';

-- RLS on meetings
alter table public.meetings enable row level security;

create policy meetings_select on public.meetings
  for select to authenticated
  using (
    auth.uid() = creator_id
    or exists (
      select 1
      from public.meeting_invitations mi
      where mi.meeting_id = public.meetings.id
        and mi.invitee_id = auth.uid()
    )
  );

create policy meetings_insert on public.meetings
  for insert to authenticated
  with check (auth.uid() = creator_id);

create policy meetings_delete on public.meetings
  for delete to authenticated
  using (auth.uid() = creator_id);

-- no UPDATE policy in S-02 (meetings are immutable after create)
grant select, insert, delete on public.meetings to authenticated;
revoke update on public.meetings from authenticated;

-- RLS on meeting_invitations
alter table public.meeting_invitations enable row level security;

create policy meeting_invitations_select on public.meeting_invitations
  for select to authenticated
  using (
    auth.uid() = invitee_id
    or exists (
      select 1
      from public.meetings m
      where m.id = public.meeting_invitations.meeting_id
        and m.creator_id = auth.uid()
    )
  );

create policy meeting_invitations_insert on public.meeting_invitations
  for insert to authenticated
  with check (
    status = 'pending'
    and exists (
      select 1
      from public.meetings m
      where m.id = meeting_id
        and m.creator_id = auth.uid()
    )
    and public.is_connected(auth.uid(), invitee_id)
  );

-- no UPDATE policy in S-02 (S-03 lands accept/decline); no DELETE policy (cascade via FK)
grant select, insert on public.meeting_invitations to authenticated;
revoke update, delete on public.meeting_invitations from authenticated;

-- atomic create RPC
create or replace function public.create_meeting_with_invitations(
  p_starts_at        timestamptz,
  p_duration_minutes int,
  p_street           text,
  p_city             text,
  p_postal_code      text,
  p_country          text,
  p_description      text,
  p_invitee_ids      uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_meeting_id uuid;
  v_invitee    uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_invitee_ids is null or cardinality(p_invitee_ids) = 0 then
    raise exception 'at least one invitee required' using errcode = '22023';
  end if;

  -- every invitee must be an accepted-connected friend of the caller
  foreach v_invitee in array p_invitee_ids loop
    if not public.is_connected(auth.uid(), v_invitee) then
      raise exception 'invitee not connected' using errcode = '42501';
    end if;
  end loop;

  insert into public.meetings (
    creator_id, starts_at, duration_minutes,
    street, city, postal_code, country, description
  )
  values (
    auth.uid(), p_starts_at, p_duration_minutes,
    p_street, p_city, p_postal_code, p_country, p_description
  )
  returning id into v_meeting_id;

  insert into public.meeting_invitations (meeting_id, invitee_id)
  select v_meeting_id, invitee_id
  from unnest(p_invitee_ids) as invitee_id;

  return v_meeting_id;
end;
$$;

comment on function public.create_meeting_with_invitations(
  timestamptz, int, text, text, text, text, text, uuid[]
) is
  'S-02: atomically inserts a meeting (creator = auth.uid()) plus one pending invitation per invitee. Validates every invitee is an accepted-connected friend of the caller; raises 42501 on failure.';

grant execute on function public.create_meeting_with_invitations(
  timestamptz, int, text, text, text, text, text, uuid[]
) to authenticated;
```

#### 2. Regenerated database types

**File**: `src/db/database.types.ts` (regenerated)

**Intent**: Pick up the two new tables, the enum, and the RPC signature so Phase 2's API code and Phase 3's SSR queries are type-checked against the schema from day one.

**Contract**: The verbatim output of `npm run db:types` after Phase 1's migration applies. Exports a `Database` whose `public.meetings` and `public.meeting_invitations` Row/Insert/Update shapes, `meeting_invitation_status` enum union, and `create_meeting_with_invitations` function signature are all present. **Do not hand-edit.**

#### 3. New meetings RLS doc

**File**: `supabase/tests/meetings-rls.md` (new)

**Intent**: Document the cross-table SELECT model (creator-OR-invitee on meetings, invitee-OR-creator on invitations), the creator-only INSERT/DELETE on meetings, the creator-only INSERT on invitations, and the RPC's connected-friend enforcement, with copy-pasteable SQL blocks proving each holds under impersonation. This is the verification surface for the privacy NFR on this slice.

**Contract**: Markdown file mirroring the structure of [friend-connections-rls.md](../../../supabase/tests/friend-connections-rls.md). Fixture: Alice (a01), Bob (b01) — already connected via the S-01 seed — plus inline test-only `auth.users` inserts for Carol (c01, friend of Alice) and Dave (d01, no FC) when needed. At minimum **six** numbered blocks, each wrapped in `begin; … rollback;`:

1. **Creator-only INSERT on meetings** — impersonate Alice → INSERT a meeting with `creator_id = a01` succeeds; INSERT with `creator_id = b01` fails (WITH CHECK).
2. **Cross-table SELECT visibility** — Alice creates a meeting, INSERT one invitation for Bob. Impersonate Alice → SELECT from meetings returns 1 row; impersonate Bob → SELECT from meetings returns 1 row (via invitee branch); impersonate Dave (uninvolved) → SELECT returns 0 rows.
3. **Invitation visibility** — same fixture. Impersonate Alice → SELECT from meeting_invitations returns 1 row (creator branch); impersonate Bob → SELECT returns 1 row (invitee branch); impersonate Dave → SELECT returns 0 rows.
4. **RPC happy path** — impersonate Alice → `select public.create_meeting_with_invitations('2026-06-15 14:00+00', 60, 'Test St', 'Warsaw', '00-001', 'PL', 'desc', ARRAY[b01::uuid])` returns a UUID; `select count(*) from meetings where id = <returned>` is 1; `select count(*) from meeting_invitations where meeting_id = <returned>` is 1 with `status = 'pending'`.
5. **RPC rejects unconnected invitee** — impersonate Alice → call RPC with `ARRAY[d01::uuid]` (no FC) raises `'invitee not connected'` (42501); no row inserted in either table.
6. **RPC rejects empty invitee array** — impersonate Alice → call RPC with `ARRAY[]::uuid[]` raises `'at least one invitee required'` (22023).
7. **Creator-only DELETE cascades to invitations** — Alice creates a meeting with Bob invited (use block-4 fixture). Impersonate Alice → `delete from meetings where id = <id>` succeeds; `select count(*) from meeting_invitations where meeting_id = <id>` returns 0 (cascade). Impersonate Bob attempting the same delete → 0 rows affected (RLS USING fails silently).
8. **No UPDATE on meetings** — impersonate Alice → `update meetings set description = 'new' where id = <id>` raises a permission error (the REVOKE strips the GRANT entirely).

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes (Windows posture: touched-set is `.sql`/`.md`/`.ts`; lint only touched paths via `npx eslint <files>` on Windows; full-tree run trips the pre-existing CRLF debt)
- `npm run build` passes (proves the regenerated `Database` type is consumed correctly by the typed Supabase client)
- `npm run db:reset` applies the migration cleanly
- `npm run db:types` regenerates `src/db/database.types.ts` idempotently (no diff if run twice)
- `select count(*) from public.meetings` returns 0 after `db:reset` (no seed change)
- `select count(*) from public.meeting_invitations` returns 0 after `db:reset`
- `select to_regtype('public.meeting_invitation_status')` returns the enum name (proves the enum was created)
- `select pg_get_function_arguments('public.create_meeting_with_invitations'::regproc)` returns the 8-arg signature

#### Manual Verification:

- All eight SQL blocks in the new `supabase/tests/meetings-rls.md` produce their documented results
- The `\dp public.meetings` output shows `authenticated` carrying `a` (insert), `r` (select), `d` (delete), and NOT `w` (update); column-level UPDATE grants are absent
- The `\dp public.meeting_invitations` output shows `authenticated=ar/postgres` (a=insert, r=select), absence of `w` and `d` (S-03 lands UPDATE, no DELETE ever — cascade only)
- `\df+ public.create_meeting_with_invitations` shows `Security: definer`, `Config: search_path=public, pg_temp`, `Owner: postgres`, ACL `authenticated=X/postgres`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the SQL fixtures demonstrate cross-table RLS correctness and RPC enforcement before proceeding to Phase 2.

---

## Phase 2: Server-side wiring — meeting create + delete API

### Overview

Add two zod-validated JSON API routes under `src/pages/api/meetings/`: `POST` to create a meeting + invitations via the RPC, and `DELETE /[id]` for creator-only meeting deletion. After this phase the full create + delete loop is exercisable with `curl` against `npm run dev`.

### Changes Required:

#### 1. POST /api/meetings

**File**: `src/pages/api/meetings/index.ts` (new)

**Intent**: A single endpoint backed by the `create_meeting_with_invitations` RPC. Validates the JSON body with zod (datetime ISO, address text, description text, invitee UUID array), then forwards to the RPC. Maps the RPC's typed exceptions to specific HTTP statuses. The RPC owns the atomicity and the connected-friend enforcement; this handler is glue plus error-shape mapping.

**Contract**: `POST /api/meetings` with JSON body:

```ts
{
  starts_at: string,           // strict ISO with timezone, e.g. "2026-06-15T14:00:00.000Z"
  duration_minutes?: number,   // optional, default 60, must be 1..1440
  street: string,              // 1..200, trimmed non-empty
  city: string,                // 1..100, trimmed non-empty
  postal_code: string,         // 1..20, trimmed non-empty
  country: string,             // 1..100, trimmed non-empty
  description: string,         // 1..500, trimmed non-empty
  invitee_ids: string[]        // length >= 1, each UUID-shaped, deduped client-side (Set)
}
```

zod-validated with the existing `UUID_SHAPE` regex for `invitee_ids`. On unauthenticated: `401`. On validation failure: `400 { error: string }`. On success: `201 { meeting_id: uuid }`.

Error mapping from the RPC:

- `code = '42501'` with message `'invitee not connected'` → `403 { error: "one or more invitees are not connected friends" }`
- `code = '42501'` with message `'authentication required'` → `401` (defence-in-depth; the handler already 401s before calling)
- `code = '22023'` with message `'at least one invitee required'` → `400 { error: "at least one invitee required" }`
- Postgres `23505` (unique violation on `(meeting_id, invitee_id)` — duplicate invitee in the array) → `422 { error: "duplicate invitee in request" }`
- Postgres `23514` (CHECK violation — bad length, bad duration) → `400 { error: "invalid field shape" }` (zod should catch first; this is defence-in-depth)
- Any other DB error → `500 { error: "create failed" }`

#### 2. DELETE /api/meetings/[id]

**File**: `src/pages/api/meetings/[id].ts` (new — Astro dynamic API route)

**Intent**: The creator deletes their own meeting; FK cascade removes all invitations. RLS enforces creator == self. Map zero-row-deleted to 404 (not the creator, or already deleted).

**Contract**: `DELETE /api/meetings/[id]` where `[id]` is a UUID path param. The handler validates the param shape with the existing `UUID_SHAPE` regex (mirror [requests/[id].ts](../../../src/pages/api/friends/requests/[id].ts)), then issues `supabase.from('meetings').delete().eq('id', id).select('id').maybeSingle()`. On success: `204` (no content). On RLS USING failure or not-found: `404 { error: "not found" }`. On validation failure: `400`. On unauthenticated: `401`. On other DB errors: `500`.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes (Windows posture as in Phase 1)
- `npm run build` passes (proves the zod schemas are well-typed and the typed Supabase client accepts the RPC call shape)

#### Manual Verification:

- `npm run db:reset` then sign in as Alice (cookies captured), then sign up a fresh user "Carol" and connect Alice ↔ Carol via the existing /friends flow.
- `curl -X POST http://localhost:4321/api/meetings -H 'Content-Type: application/json' -b '<alice cookies>' -d '{"starts_at":"2026-06-15T14:00:00.000Z","street":"Test St","city":"Warsaw","postal_code":"00-001","country":"PL","description":"co-care Saturday","invitee_ids":["<bob-uuid>"]}'` returns `201 { meeting_id: "<uuid>" }`.
- Same call with `invitee_ids = []` returns `400 { error: "..." }` (zod catches first).
- Same call with `invitee_ids` containing Dave's UUID (not connected to Alice) returns `403 { error: "...not connected..." }`.
- Same call with `description = ""` returns `400`.
- Same call with `starts_at = "2026-06-15T14:00"` (no timezone) returns `400` (strict ISO required).
- Same call with `duration_minutes = 0` returns `400`; with `duration_minutes = 2000` returns `400`; omitting `duration_minutes` succeeds and DB row shows 60.
- Same call with duplicate UUIDs in `invitee_ids` returns `422`.
- `curl -X DELETE http://localhost:4321/api/meetings/<meeting-uuid> -b '<alice cookies>'` returns `204`; the meeting is gone; all invitation rows for that meeting are gone (cascade).
- Same DELETE with `<meeting-uuid>` from a meeting Bob created (impersonate Alice trying to delete Bob's meeting) returns `404`.
- Unauthenticated POST/DELETE returns `401`.

**Implementation Note**: After all automated verification passes, pause for manual confirmation that the two API endpoints work end-to-end with curl before proceeding to Phase 3.

---

## Phase 3: UI + integration — /meetings page, middleware, dashboard link, AGENTS.md refresh

### Overview

Wire the API + RPC into a working `/meetings` page with two sections (Create + My created meetings), each a React island that calls the Phase 2 endpoints and triggers a page reload on success. Add `/meetings` to `PROTECTED_ROUTES`. Add a link from `/dashboard` to `/meetings`. Refresh AGENTS.md so the next agent reads the new landmarks. After this phase the creator-side loop works in a browser; the invitee-side data is present in the DB awaiting S-03's UI.

### Changes Required:

#### 1. Meetings page

**File**: `src/pages/meetings.astro` (new)

**Intent**: The Astro shell that SSR-fetches the creator's friends (for the picker) and the creator's meetings (with nested invitations + invitee display_names), then renders the two sections as React islands. Mirrors the structure of [friends.astro](../../../src/pages/friends.astro).

**Contract**: Page-level frontmatter reads `Astro.locals.user`, refuses if null (middleware already redirects, this is belt-and-braces), instantiates `createClient(...)`, then issues two queries:

- `friendsRpc = await supabase.rpc('list_my_friends')` — array of `{ id, display_name }` for the picker. Using the RPC rather than a bare `parents` select avoids the pending-FC widening leak in `parents_select`.
- `meetingsQuery = await supabase.from('meetings').select(\`id, starts_at, duration_minutes, street, city, postal_code, country, description, created_at, invitations:meeting_invitations(id, status, invited_at, invitee:parents!invitee_id(id, display_name))\`).eq('creator_id', user.id).order('starts_at', { ascending: true })`— typed via the regenerated Database; the nested invitee select resolves via the`parents_select` is_connected branch (every invitee is an accepted-connected friend, so the row is visible).

The page renders `<Layout>` wrapping two sections, each a React island:

- `<MeetingCreateForm friends={friendsRpc.data ?? []} client:load />` — interactive immediately
- `<MyMeetingsList meetings={meetingsQuery.data ?? []} client:visible />` — list re-hydrates on viewport

Empty state for the picker (zero friends): the form renders a disabled state with a message "Connect with a friend on /friends before creating a meeting." This avoids a creator hitting submit and getting a 400 because invitee_ids is empty.

#### 2. MeetingCreateForm component

**File**: `src/components/meetings/MeetingCreateForm.tsx` (new)

**Intent**: A controlled form combining datetime + 4 address fields + description textarea + friend-picker checkbox list + Submit button. On submit, validates client-side (mirrors S-01 `FriendSearch`'s pattern), converts the wall-clock datetime to UTC ISO, POSTs to `/api/meetings`, then `window.location.reload()` on 201. Surfaces inline errors below the field on validation failure and below the form on server errors.

**Contract**: Props: `{ friends: Array<{ id: string; display_name: string | null }> }`. Internal state: `startsAtLocal` (string), `durationMinutes` (number — hidden field defaulting to 60, exposed only as a comment; no UI input in S-02), `street`/`city`/`postalCode`/`country`/`description` (strings), `selectedInvitees` (`Set<string>`), `submitting` (boolean), `error` (string | null), `fieldErrors` (Record<string, string | undefined>).

Structure:

- `<FormField icon={CalendarClock} type="datetime-local" id="starts_at" label="Date & time" ...>` for the datetime (FormField's `type` is loose enough to pass through)
- Four `<FormField>` instances for street/city/postal_code/country (icons: `MapPin` for street, `Building2` for city, `Hash` for postal, `Globe` for country)
- A raw `<textarea>` styled inline with Tailwind to match FormField's input look — wrapped in a label container with the same icon + error/hint pattern (icon: `FileText`). Resize disabled (`resize-y`), 4 rows visible.
- A friend-picker section: heading "Invite friends", followed by a `<ul>` of `<li>` rows. Each row: a `<label className="flex items-center gap-3 cursor-pointer">` wrapping `<input type="checkbox">` and the display_name (fallback "Unnamed friend"). Toggling updates `selectedInvitees`. If `friends.length === 0`, render the disabled-state empty message and hide the submit button.
- `<SubmitButton pendingText="Creating..." icon={CalendarPlus}>Create meeting</SubmitButton>` at the bottom. Disabled if `selectedInvitees.size === 0`.
- Inline `<ServerError message={error} />` above the submit button (reuse [ServerError.tsx](../../../src/components/auth/ServerError.tsx) from auth — its API is generic).

Submit handler:

1. Run client validation: trim every text field, length checks matching the zod schema; collect `fieldErrors`.
2. If any error, set `fieldErrors`, return.
3. Convert datetime: `const startsAtIso = new Date(startsAtLocal).toISOString();` — if `isNaN(...)`, set field error "invalid date/time" and return.
4. POST JSON body to `/api/meetings`.
5. On 201, `window.location.reload()`.
6. On 4xx, parse `{ error }` and set `error` state.
7. Always clear `submitting` in a `finally`.

#### 3. MyMeetingsList component

**File**: `src/components/meetings/MyMeetingsList.tsx` (new)

**Intent**: Render the creator's flat date-ascending meetings list. Each row shows starts_at (humanised via `toLocaleString()`), the address (concatenated `street, city postal_code, country`), the description, the duration as a short suffix (e.g., "60 min"), the per-invitee status rows (display_name + status badge), and a Delete button that calls `window.confirm()` then `DELETE /api/meetings/[id]`.

**Contract**: Props:

```ts
{
  meetings: Array<{
    id: string;
    starts_at: string;
    duration_minutes: number;
    street: string;
    city: string;
    postal_code: string;
    country: string;
    description: string;
    created_at: string;
    invitations: Array<{
      id: string;
      status: "pending" | "accepted" | "declined" | "expired";
      invited_at: string;
      invitee: { id: string; display_name: string | null } | null;
    }>;
  }>;
}
```

Empty state: "You haven't created any meetings yet. Use the form above to schedule one with a connected friend."

Each row:

- A `<details>` element with `<summary>` showing starts_at (toLocaleString) + duration + a count chip ("3 invited · 1 accepted")
- Inside: full address, description (`<p className="whitespace-pre-line">`), then `<ul>` of invitations with a status badge per row. Badge styling per status: `pending` (slate), `accepted` (emerald), `declined` (rose), `expired` (zinc/grey). Use small inline Tailwind classes; no new component.
- Footer: `<button onClick={() => handleDelete(meeting.id)} className="...destructive...">Delete</button>` — `handleDelete` calls `window.confirm("Delete this meeting? Everyone invited will lose it.")`, then DELETE, then `window.location.reload()` on 204.

Internal state per-row: a `deleting` set keyed by meeting.id to disable the button mid-call.

#### 4. Middleware: protect /meetings

**File**: `src/middleware.ts` (modify)

**Intent**: Extend `PROTECTED_ROUTES` so unauthenticated visitors to `/meetings` are redirected to `/auth/signin`, same as `/friends`.

**Contract**: One-line change: `PROTECTED_ROUTES = ["/dashboard", "/friends", "/meetings"]`. No other middleware logic changes.

#### 5. Dashboard link to /meetings

**File**: `src/pages/dashboard.astro` (modify)

**Intent**: Add a visible navigation link to `/meetings` so a signed-in parent can reach the new surface without typing the URL. Mirror the existing Friends link shape.

**Contract**: Add one anchor `<a href="/meetings">` styled identically to the existing Friends link (same className), placed next to or below the Friends link. Label: "Meetings".

#### 6. AGENTS.md refresh

**File**: `AGENTS.md` (modify)

**Intent**: Surface the new data-layer landmarks S-02 introduces so the next agent picking up the codebase reads them once and stays unblocked — the same hand-off pattern F-01 / S-01 established. Two small edits.

**Contract**:

- **§Current state**: replace the S-01 closing sentence so it acknowledges the new tables, the cross-table SELECT model (meeting visible to creator OR any invitee; invitation visible to invitee OR meeting's creator), and the atomic-create RPC. State that meetings are immutable after create in S-02 (no UPDATE policy on either table); creator can delete a meeting (cascade); invitee accept/decline + conflict warning are S-03 territory; cron expiry is S-04. Mention that the `meeting_invitation_status` enum carries all four values from day one even though S-02 only writes `pending`.
- **§Key conventions**: add two new bullets right after the existing **Search/list RPCs** bullet:
  - **Cross-table visibility via RLS — wrap cross-table EXISTS in a SECURITY DEFINER helper.** When two tables' SELECT policies reference each other (e.g., `meetings_select` needs to know "is the viewer invited?" and `meeting_invitations_select` needs to know "is the viewer the meeting's creator?"), inline EXISTS subqueries trip Postgres's infinite-recursion guard (`ERROR: infinite recursion detected in policy for relation "..."`) on every SELECT. Fix: wrap each cross-table check in a `SECURITY DEFINER` helper with `set search_path = public, pg_temp`, returning `boolean`. The definer call bypasses RLS during the lookup, breaking the cycle. Canonical examples: `public.user_is_meeting_invitee(p_meeting_id, p_user_id)` and `public.user_is_meeting_creator(p_meeting_id, p_user_id)` in `supabase/migrations/<S-02 timestamp>_meetings_foundation.sql`, consumed by `meetings_select` and `meeting_invitations_select`. For a one-directional cross-table check (no recursion partner), a bare inline EXISTS is still fine — but qualify the outer-table column (e.g., `ot.<fk> = public.<this_table>.id`, not bare `<fk> = id`) per the S-01 `parents_select` lesson, or the inner alias silently shadows.
  - **Cross-table mutation via SECURITY DEFINER RPC** — when a single user action must mutate two or more tables atomically (e.g., create a meeting AND insert N invitation rows in one transaction), implement it as a `SECURITY DEFINER` plpgsql function rather than chaining supabase-js calls (supabase-js does not expose multi-statement transactions). Required shape: `set search_path = public, pg_temp`; first statement validates `auth.uid() is not null` (raise `42501` if null); then validate inputs explicitly (cardinality, ranges, cross-row preconditions like `is_connected`) and raise typed exceptions with specific `errcode` values the API layer maps to HTTP statuses (e.g., `42501` → 403, `22023` → 400, Postgres native `23505` → 422). `grant execute … to authenticated`. Canonical example: `public.create_meeting_with_invitations(timestamptz, int, text, text, text, text, text, uuid[])` in `supabase/migrations/<S-02 timestamp>_meetings_foundation.sql`. Reach for this pattern instead of two supabase-js calls whenever the second call's failure would leave the first call's row stranded in a useless state.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes (Windows posture)
- `npm run build` passes (proves the new pages and components type-check against the regenerated `Database`)
- `grep -n '/meetings' src/middleware.ts` returns a hit confirming the route was added

#### Manual Verification:

- Visiting `/meetings` while signed out redirects to `/auth/signin`.
- Signed in as Alice (cookies via the seed fixture or manual signup-and-connect), `/meetings` renders the two sections: the create form is populated with Bob as a friend in the picker; the My created meetings list is empty.
- Submit the form with valid inputs (e.g., 2026-06-15 14:00, address Test St / Warsaw / 00-001 / PL, description "co-care Saturday", invitee = Bob) → page reloads; My created meetings shows one row with Bob as a pending invitee.
- Submit with no invitees selected → submit button is disabled.
- Submit with empty description → inline field error appears, no API call.
- Sign in as Bob → visit `/meetings` (or run a SQL probe to verify visibility); SQL probe `select count(*) from meetings` returns 1 (the meeting Alice just created — Bob sees it via the invitee branch). No UI for the invitee side yet (that's S-03).
- Click Delete on Alice's meeting → browser confirm() prompt appears; confirming triggers DELETE; page reloads; the meeting is gone from both Alice's list and (via SQL) Bob's view. Invitation rows for that meeting are gone (cascade).
- Cancel the confirm() → no DELETE call fires.
- Sign in as a parent with zero friends → `/meetings` renders the disabled-state empty message in the picker; no submit button.
- `/dashboard` shows the new "Meetings" link, clicking it lands on `/meetings`.
- AGENTS.md diff reads cleanly: §Current state acknowledges the new tables + cross-table SELECT model + atomic create RPC + immutability posture + S-02 boundary; §Key conventions has both new bullets — **Cross-table visibility via RLS** and **Cross-table mutation via SECURITY DEFINER RPC** — placed next to the existing Search/list-RPCs bullet.

**Implementation Note**: After all automated verification passes, pause for manual confirmation that the end-to-end browser flow works (signup → connect → create meeting → see it in My created meetings → delete it) before declaring S-02 done.

---

## Testing Strategy

### Unit Tests

None for S-02. Same posture as F-01 and S-01: the data layer is exercised by the SQL test doc; the API handlers are thin glue over zod + Supabase RPC/queries; the UI components are exercised by manual walkthroughs. Defer a unit-test framework until S-03's accept-with-conflict logic surfaces something genuinely worth isolating.

### Integration Tests

- `npm run db:reset` applying cleanly **is** the migration integration test.
- Phase 1's RLS test doc + the manual SQL block walkthroughs collectively form a one-shot integration test of the cross-table visibility + RPC enforcement surface.
- Phase 2's curl walkthrough is the API integration test.
- Phase 3's browser walkthrough is the end-to-end integration test.

### Manual Testing Steps

1. Start Docker if not running; `npx supabase start`.
2. `npm run db:reset` — confirm migration applies, 2 parents + 1 FC, 0 meetings, 0 invitations.
3. `npm run db:types` — confirm idempotency.
4. Walk through the eight SQL blocks in new `supabase/tests/meetings-rls.md`.
5. `npm run dev` — sign in as Alice (or sign up afresh + connect with a second account).
6. Walk through the Phase 2 curl scenarios for POST + DELETE.
7. Walk through the Phase 3 browser scenarios: protected redirect, create form happy path, validation errors, invitee-side visibility (via SQL probe), delete + cascade, empty-friends disabled state.

## Performance Considerations

The three partial indexes (`meeting_invitations_meeting_idx`, `meeting_invitations_invitee_pending_idx`, `meeting_invitations_invitee_accepted_idx`) keep S-02's and S-03's primary access patterns index-only at MVP scale. `meetings_creator_starts_at_idx` covers the creator's date-ascending list query. The cross-table EXISTS in `meetings_select` is index-backed by `meeting_invitations_meeting_idx`. The RPC's `foreach … is_connected` loop is O(invitees) per create; at MVP scale (PRD `target_scale.users: medium`, expected invitee count per meeting in single digits) this is fine. The unique constraint `(meeting_id, invitee_id)` is also a usable index. Revisit if a future slice surfaces query latency.

## Migration Notes

- This is the third domain migration; the pattern set by F-01 and S-01 (one atomic migration per slice, idempotent SQL, named via `supabase migration new`) continues.
- The migration is forward-additive: two new tables + one enum + one RPC. No data is destroyed; no column is dropped; no existing function body changes. If rollback ever becomes necessary, drop in reverse order: RPC → invitations table → meetings table → enum. No rollback script is shipped.
- S-03 will land an UPDATE policy on `meeting_invitations` (accept/decline) with the column-level grant restricting mutability to `status`. The REVOKE-then-GRANT pattern documented in AGENTS.md applies — S-02 ships only the broad REVOKE on UPDATE; S-03's migration will add the narrow GRANT.
- S-04 will land a Cloudflare Cron Trigger that sweeps `meeting_invitations` where `status = 'pending' AND invited_at < now() - interval '24 hours'`, setting `status = 'expired'`. The enum value already exists from S-02, so S-04's migration is the cron handler + maybe a `responded_at` audit column added by S-03 first.
- Cloudflare Workers (production) and the local Supabase Docker stack share schema but are managed independently. Local migrations apply via `supabase db reset`. Pushing this migration to a remote Supabase project is out of S-02 scope.

## References

- Roadmap entry: `context/foundation/roadmap.md` §S-02
- PRD: `context/foundation/prd.md` §US-01, §FR-006, §FR-007, §NFR Privacy boundary, §Business Logic, §Access Control
- F-01 archive: `context/archive/2026-05-26-parents-profile-and-rls-foundation/plan.md` — `is_connected` helper, RLS template, trigger pattern
- S-01 archive: `context/archive/2026-05-27-friend-connection-handshake/plan.md` — column-level GRANT pattern, cross-table SELECT lesson (parents_select pending-OR), `list_my_friends()`, manual SQL test-doc template, four-API-routes-with-zod pattern
- S-01 impl-review lessons: `context/archive/2026-05-27-friend-connection-handshake/reviews/` — qualified outer-table refs inside EXISTS, REVOKE-first column grants
- Lessons: `context/foundation/lessons.md` — lint-validate impl-review type-system findings before applying
- AGENTS.md: §Key conventions → RLS template, `zod` validation, migration naming, column-level GRANT, Search/list RPCs
- Existing typed-client touchpoint: [src/lib/supabase.ts:10](../../../src/lib/supabase.ts#L10)
- Existing middleware: [src/middleware.ts:4](../../../src/middleware.ts#L4)
- Existing form/page patterns: [src/pages/friends.astro](../../../src/pages/friends.astro), [src/components/friends/FriendSearch.tsx](../../../src/components/friends/FriendSearch.tsx), [src/components/auth/FormField.tsx](../../../src/components/auth/FormField.tsx), [src/components/auth/SubmitButton.tsx](../../../src/components/auth/SubmitButton.tsx)
- Existing API pattern: [src/pages/api/friends/request.ts](../../../src/pages/api/friends/request.ts), [src/pages/api/friends/requests/[id].ts](../../../src/pages/api/friends/requests/[id].ts)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data layer — meetings + meeting_invitations tables, cross-table RLS, RPC

#### Automated

- [x] 1.1 `npm run lint` passes — cc61bb2
- [x] 1.2 `npm run build` passes — cc61bb2
- [x] 1.3 `npm run db:reset` applies the migration cleanly — cc61bb2
- [x] 1.4 `npm run db:types` regenerates `src/db/database.types.ts` idempotently — cc61bb2
- [x] 1.5 `select count(*) from public.meetings` returns 0 after `db:reset` — cc61bb2
- [x] 1.6 `select count(*) from public.meeting_invitations` returns 0 after `db:reset` — cc61bb2
- [x] 1.7 `select to_regtype('public.meeting_invitation_status')` returns the enum name — cc61bb2
- [x] 1.8 `select pg_get_function_arguments('public.create_meeting_with_invitations'::regproc)` returns the 8-arg signature — cc61bb2

#### Manual

- [x] 1.9 All eight SQL blocks in `supabase/tests/meetings-rls.md` produce their documented results — cc61bb2
- [x] 1.10 `\dp public.meetings` shows the expected ACL (insert, select, delete present; update absent) — cc61bb2
- [x] 1.11 `\dp public.meeting_invitations` shows the expected ACL (insert, select present; update, delete absent) — cc61bb2
- [x] 1.12 `\df+ public.create_meeting_with_invitations` shows `Security: definer`, `Config: search_path=public, pg_temp`, and ACL grant to authenticated — cc61bb2

### Phase 2: Server-side wiring — meeting create + delete API

#### Automated

- [x] 2.1 `npm run lint` passes — 81df3f1
- [x] 2.2 `npm run build` passes — 81df3f1

#### Manual

- [x] 2.3 `POST /api/meetings` with valid body (Bob as invitee, Alice as caller) returns 201 + meeting_id — 81df3f1
- [x] 2.4 `POST /api/meetings` with empty `invitee_ids` returns 400 — 81df3f1
- [x] 2.5 `POST /api/meetings` with an unconnected invitee returns 403 — 81df3f1
- [x] 2.6 `POST /api/meetings` with empty `description` returns 400 — 81df3f1
- [x] 2.7 `POST /api/meetings` with non-ISO `starts_at` (no timezone) returns 400 — 81df3f1
- [x] 2.8 `POST /api/meetings` with `duration_minutes = 0` or `> 1440` returns 400; omitted defaults to 60 — 81df3f1
- [x] 2.9 `POST /api/meetings` with duplicate UUIDs in `invitee_ids` returns 422 — 81df3f1
- [x] 2.10 `DELETE /api/meetings/[id]` as the creator returns 204; cascade removes invitations — 81df3f1
- [x] 2.11 `DELETE /api/meetings/[id]` as a non-creator returns 404 — 81df3f1
- [x] 2.12 Unauthenticated POST/DELETE returns 401 — 81df3f1

### Phase 3: UI + integration — /meetings page, middleware, dashboard link, AGENTS.md refresh

#### Automated

- [x] 3.1 `npm run lint` passes — cec47b6
- [x] 3.2 `npm run build` passes — cec47b6
- [x] 3.3 `/meetings` is in `PROTECTED_ROUTES` in `src/middleware.ts` — cec47b6

#### Manual

- [ ] 3.4 `/meetings` while signed out redirects to `/auth/signin`
- [ ] 3.5 Signed-in `/meetings` renders the create form (with friend picker populated from `list_my_friends`) and the My created meetings list (initially empty)
- [ ] 3.6 Submitting the form with valid inputs creates the meeting; page reloads; the new meeting appears in My created meetings with the invitee row + pending status badge
- [ ] 3.7 Submit button is disabled when zero invitees are selected; inline field errors appear for invalid inputs (empty description, malformed datetime)
- [ ] 3.8 The invitee can see the meeting via SQL probe (`select count(*) from meetings` impersonated as the invitee returns 1)
- [ ] 3.9 Clicking Delete shows the native confirm() prompt; confirming removes the meeting + cascades invitations; cancelling does nothing
- [ ] 3.10 A signed-in parent with zero connected friends sees the disabled-state empty message in the picker and no submit button
- [ ] 3.11 `/dashboard` shows the new "Meetings" link, clicking it lands on `/meetings`
- [ ] 3.12 AGENTS.md diff reads cleanly: §Current state acknowledges meetings + meeting_invitations + cross-table SELECT model + `create_meeting_with_invitations` RPC + immutability posture; §Key conventions has both new bullets (Cross-table visibility via RLS, Cross-table mutation via SECURITY DEFINER RPC)
