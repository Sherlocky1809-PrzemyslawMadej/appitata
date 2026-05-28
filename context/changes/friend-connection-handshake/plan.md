# Friend Connection Handshake Implementation Plan

## Overview

Ship S-01 — the friend-request handshake between two parents — as the second foundation slice that S-02 (`meeting-creation-and-invite`) depends on. Land the `friend_connections` table with directional pending/accepted/declined rows, extend F-01's `public.is_connected(viewer, owner)` helper so the RLS template now covers connected friends (not just self), add a `SECURITY DEFINER` lookup RPC that lets a non-connected parent find another parent by exact email or phone, and ship a `/friends` page with the four sections that make FR-002 through FR-005 a working loop: search → request → accept/decline + cancel, and a connected-friends list.

## Current State Analysis

- **`public.is_connected(viewer, owner)`** is currently a self-only stub (`select viewer = owner`) — F-01's migration ([archived plan](../../archive/2026-05-26-parents-profile-and-rls-foundation/plan.md) §"Critical Implementation Details") explicitly committed to extending it here, and the function comment says so on disk.
- **`public.parents.phone`** and **`public.parents.display_name`** are nullable columns that are never populated. The current signup form ([src/components/auth/SignUpForm.tsx:14-19](../../../src/components/auth/SignUpForm.tsx#L14-L19)) collects only email + password; the trigger ([archived migration](../../archive/2026-05-26-parents-profile-and-rls-foundation/plan.md) §Phase 1) writes whatever's on `new.email` / `new.phone`, and `auth.users.phone` is never set by `signUp({ email, password })`.
- **No `friend_connections` table** exists — nothing in `supabase/migrations/`, nothing referenced from `src/`.
- **API surface** is auth-only ([src/pages/api/auth/](../../../src/pages/api/auth/)). Three handlers use raw `formData()` + redirect with `?error=`, no `zod` despite AGENTS.md naming it as a convention. New friend-handshake endpoints get the zod posture right from day one.
- **No `/friends` page** exists. `src/middleware.ts` ([:4](../../../src/middleware.ts#L4)) has `PROTECTED_ROUTES = ["/dashboard"]` — needs `/friends` added.
- **`src/db/database.types.ts`** is regenerated via `npm run db:types` and `createServerClient<Database>` is already wired ([src/lib/supabase.ts:10](../../../src/lib/supabase.ts#L10)) — the new RPC + table will become typed automatically after Phase 1's migration lands.
- **Seed fixture** ([supabase/seed.sql](../../../supabase/seed.sql)) inserts Alice + Bob with empty `raw_user_meta_data`. Their `parents` rows currently have null `display_name` and `phone` — neither is searchable.
- **Manual RLS verification** lives at [supabase/tests/parents-rls.md](../../../supabase/tests/parents-rls.md) with three SQL blocks expecting 1/1/0 row counts. After S-01 the extension makes Alice and Bob mutually visible via an accepted FC row, so those counts will change (Alice's view = 2 / Bob's view = 2 / cross-isolation by an uninvolved third party still = 0, but we only have two parents — the doc needs updating).

## Desired End State

- `public.friend_connections` exists, RLS-protected, with directional rows + the `friend_connection_status` enum.
- `public.is_connected(viewer, owner)` returns true when viewer = owner OR an accepted `friend_connections` row exists in either direction.
- `public.find_parent_by_handle(handle text)` exists as a `SECURITY DEFINER` RPC that returns at most one `(id, display_name)` row matching email (case-insensitive) or phone (digits + leading `+`), excluding `auth.uid()`.
- `handle_new_user()` reads `display_name` and `phone` from `new.raw_user_meta_data` so every new signup populates the searchable columns.
- The signup form collects `display_name` (required) + `phone` (optional, E.164-shaped); the signup API zod-parses input and forwards the metadata via `supabase.auth.signUp({ ..., options: { data: { display_name, phone } } })`.
- Four new JSON API routes under `src/pages/api/friends/`, all zod-validated: `search`, `request`, `respond`, and `requests/[id]` (DELETE).
- `/friends` is a protected page with four sections (Search, Incoming requests, Outgoing pending, Connected friends), each rendered via a React island that calls the API and reloads on mutation.
- `/dashboard` has a visible link to `/friends`.
- `supabase/tests/parents-rls.md` is updated to reflect S-01 expectations; a new `supabase/tests/friend-connections-rls.md` covers the new RLS surface.

### Key Discoveries

- `auth.users.raw_user_meta_data` is the JSONB column where `signUp({ options: { data } })` lands user-supplied metadata; trigger functions read it via `new.raw_user_meta_data->>'key'`. This is the canonical Supabase pattern, not a column on `auth.users`.
- The roadmap risk hint ("pick a shape compatible with 'given parent A, list all B such that A and B are connected' in one query") is satisfied by the directional row + `UNION` query; the chosen directional shape does not violate it.
- F-01's `is_connected` was deliberately written with the right signature so this slice only needs to swap the body. The function's grant set (`execute … to authenticated`) is unchanged.
- The PROTECTED_ROUTES array in middleware is a hard-coded string list — adding `/friends` is a one-line change.
- The existing auth API handlers use `formData()` + redirect because they're driven by `<form action="/api/...">`. New JSON endpoints (called from React islands via `fetch`) follow a different pattern: JSON body + JSON response + status codes. Both conventions coexist — pick by call site.

## What We're NOT Doing

- **Meetings, invitations, conflict checks** — all of S-02 and S-03. Friend-connection state is the only thing this slice unlocks.
- **Unfriend / disconnect** — once accepted, the connection is terminal for MVP. Not in any PRD FR.
- **Profile editing UI** — a parent cannot change their `display_name` or `phone` after signup in this slice. Add later if a real user complains.
- **Blocking a parent** — PRD FR-004 chose accept/decline without block; declined-row-blocks-re-request is the harassment-vector mitigation, no separate block surface needed.
- **Real-time updates / WebSockets** — page reload after mutation is enough for MVP scale (`target_scale.qps: low`).
- **Avatars / profile pictures** — `display_name` is the only identity-confirming field the search returns.
- **Phone verification / SMS** — phone is collected as a free-text optional field; we trust the user to type their own number.
- **Email verification** — `enable_confirmations = false` stays as-is in `supabase/config.toml`; PRD doesn't require it.
- **Profile-completion forced redirect for Alice / Bob / pre-S-01 accounts** — the seed update backfills the test fixture; the one dev account (`przemyslawmadej2@gmail.com`) stays null until that user re-signs-up or backfills manually. Not gating.
- **A `friend_connections.responded_at` audit column** — `requested_at` + status is enough; FR-008's 24h expiry is for meeting invitations, not friend requests.
- **Pushing migrations to a remote Supabase project** — local Docker is the verification surface for S-01, same as F-01.
- **pgTAP / automated SQL tests** — manual RLS walkthroughs in `supabase/tests/*.md` remain the verification surface.

## Implementation Approach

Three phases mapping to three layers: **data → server → UI**. Each phase lands one atomic commit and can be reviewed independently. The phase boundaries are chosen so each leaves the working tree consistent — never a half-migrated trigger reading metadata that nothing sends.

- **Phase 1** is one atomic migration (table + enum + indexes + RLS + extended `is_connected` + updated `handle_new_user` + new `find_parent_by_handle` RPC) plus the seed update (display_name + phone + one accepted FC between Alice/Bob) plus the regenerated types plus the updated RLS test docs. After Phase 1 the database is fully usable from psql / Studio; no application code calls it yet.
- **Phase 2** wires the server side: signup form extension, new zod-validated API routes for the four operations. After Phase 2 the full flow is exercisable with `curl`; no UI yet.
- **Phase 3** wires the UI: `/friends` page with four sections, middleware update, dashboard link. After Phase 3 the end-to-end loop works in a browser.

## Critical Implementation Details

- **RLS UPDATE does not restrict mutable columns on its own.** A WITH CHECK clause only validates the resulting row — a misbehaving client could update `requester_id`, `requested_at`, anything not pinned by the clause. The fix is column-level GRANT — BUT it requires a REVOKE first on Supabase: the default schema setup pre-grants ALL privileges (including table-level UPDATE) on every `public` table to `authenticated`, so a bare `grant update (status) … to authenticated` is ADDITIVE to the broad grant and doesn't restrict anything. The correct pair is `revoke update on public.friend_connections from authenticated; grant update (status) on public.friend_connections to authenticated;` — the REVOKE strips the default, the column GRANT pins the writable surface. (Discovered during Phase 1 verification — block 4 of the test doc silently returned UPDATE 0 instead of erroring until the REVOKE landed.) Verify via `\dp <table>`: post-fix, `authenticated=ardDxtm/postgres` (no `w`), and the Column privileges row shows `status: authenticated=w/postgres`.
- **`is_connected` body must OR both directions.** Because rows are directional, the helper must check `(requester = viewer AND addressee = owner) OR (requester = owner AND addressee = viewer)` for the accepted-FC branch. Forgetting the reverse half silently breaks RLS for half of every connected pair — the half who didn't initiate.

- **Qualify outer-table references inside EXISTS subqueries in RLS USING clauses.** The `parents_select` pending-OR branch from the F1 fix uses an EXISTS subquery scoped to `friend_connections fc`. A bare `id` inside that subquery resolves to `fc.id` (the friend_connections row UUID), NOT the outer `parents.id` being filtered — because the inner `fc` alias shadows the lookup. Write `public.parents.id` (or `parents.id`) explicitly when referring to the outer row. Discovered during Phase 1 block 6a verification, which returned 0 rows where 1 was expected; `pg_get_expr(polqual, polrelid)` made the shadowing visible.
- **The RPC must exclude `auth.uid()`.** Silent self-search means the searcher gets zero rows when typing their own email/phone — this is the privacy posture from Q5's "silent zero" choice, and it must be inside the RPC (not the API layer) because the RPC is the security boundary. A naive RPC that doesn't exclude self lets the UI render "Send request to yourself" buttons.
- **Trigger reads metadata, not columns.** `supabase.auth.signUp({ options: { data: { display_name, phone } } })` lands the values in `auth.users.raw_user_meta_data` as JSONB, NOT in `auth.users.phone` (which is a separate column Supabase reserves for phone-auth, not for user data). The trigger reads via `new.raw_user_meta_data->>'phone'`. Putting the value in the wrong place reads as null and silently breaks search.
- **Seed ordering matters.** The friend_connections INSERT must follow the auth.users INSERT in `seed.sql`, because the `on_auth_user_created` trigger needs to fire and materialise the parents rows before any FC row can FK to them. The current seed already inserts auth.users at the top; just append the FC INSERT.

## Phase 1: Data layer — table, helper extension, RPC, seed

### Overview

Land one atomic migration that adds `friend_connections` + the supporting indexes + RLS + the column-level UPDATE grant, extends the `is_connected` body to consult the new table, supersedes `handle_new_user` so it reads `display_name` + `phone` from metadata, and adds the `find_parent_by_handle` RPC. Update the seed to make Alice and Bob mutually searchable + connected. Regenerate types. Refresh the RLS test docs.

### Changes Required:

#### 1. New foundation migration for friend_connections

**File**: `supabase/migrations/<timestamp>_friend_connections_foundation.sql` (new — generate via `npx supabase migration new friend_connections_foundation`)

**Intent**: Add the directional `friend_connections` table + enum, the partial indexes that make incoming/outgoing/accepted lookups index-only, RLS policies that pin each operation to the right role (requester INSERT/DELETE, addressee UPDATE-status-only, both SELECT), the column-level UPDATE grant that restricts mutability to `status`, and the in-lockstep updates to `is_connected` and `handle_new_user` plus the new `find_parent_by_handle` RPC. Single migration so the database never lives in a half-state.

**Contract**: One SQL file. The directional shape, status transitions, column-level GRANT, and RPC signature are load-bearing — Phase 2's API routes and Phase 3's UI both depend on them. The `is_connected` body must OR both directions of an accepted FC row (see Critical Implementation Details). The RPC must filter out `auth.uid()`. The RPC and both trigger functions all carry `set search_path = public, pg_temp` and `security definer`, matching F-01's hardening.

```sql
-- enum
create type public.friend_connection_status as enum ('pending', 'accepted', 'declined');

-- table
create table public.friend_connections (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.parents(id) on delete cascade,
  addressee_id uuid not null references public.parents(id) on delete cascade,
  status       public.friend_connection_status not null default 'pending',
  requested_at timestamptz not null default now(),
  constraint friend_connections_no_self check (requester_id <> addressee_id),
  constraint friend_connections_unique_pair unique (requester_id, addressee_id)
);

-- partial indexes (incoming pending / outgoing pending / reverse-half of is_connected)
create index friend_connections_addressee_pending_idx
  on public.friend_connections(addressee_id) where status = 'pending';
create index friend_connections_requester_pending_idx
  on public.friend_connections(requester_id) where status = 'pending';
create index friend_connections_accepted_addressee_idx
  on public.friend_connections(addressee_id) where status = 'accepted';

-- RLS
alter table public.friend_connections enable row level security;

create policy friend_connections_select on public.friend_connections
  for select to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

create policy friend_connections_insert on public.friend_connections
  for insert to authenticated
  with check (auth.uid() = requester_id and status = 'pending');

create policy friend_connections_update on public.friend_connections
  for update to authenticated
  using      (auth.uid() = addressee_id and status = 'pending')
  with check (auth.uid() = addressee_id and status in ('accepted', 'declined'));

create policy friend_connections_delete on public.friend_connections
  for delete to authenticated
  using (auth.uid() = requester_id and status = 'pending');

-- column-level grants: only `status` is mutable via UPDATE
grant select, insert, delete on public.friend_connections to authenticated;
grant update (status) on public.friend_connections to authenticated;

-- extend is_connected
create or replace function public.is_connected(viewer uuid, owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    viewer = owner
    or exists (
      select 1
      from public.friend_connections fc
      where fc.status = 'accepted'
        and (
          (fc.requester_id = viewer and fc.addressee_id = owner)
          or (fc.requester_id = owner and fc.addressee_id = viewer)
        )
    );
$$;

comment on function public.is_connected(uuid, uuid) is
  'S-01: returns viewer = owner OR an accepted friend_connection in either direction.';

-- extend parents_select to ALSO allow SELECT when a pending FC exists in either
-- direction. Keeping is_connected pure ("accepted or self") means the Connected
-- friends list semantics stay clean; the pending-visibility branch is scoped
-- exactly to the two parties involved so a non-connected outsider still can't
-- read the row. (F1 from plan-review.)
alter policy parents_select on public.parents
  using (
    public.is_connected(auth.uid(), id)
    or exists (
      select 1
      from public.friend_connections fc
      where fc.status = 'pending'
        and (
          (fc.requester_id = auth.uid() and fc.addressee_id = id)
          or (fc.addressee_id = auth.uid() and fc.requester_id = id)
        )
    )
  );

-- supersede handle_new_user to read display_name + phone from raw_user_meta_data
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.parents (id, email, phone, display_name)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'display_name'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- new RPC: handle lookup
create or replace function public.find_parent_by_handle(handle text)
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with norm as (
    select
      lower(trim(handle))                          as email_norm,
      regexp_replace(handle, '[^0-9+]', '', 'g')   as phone_norm
  )
  select p.id, p.display_name
  from public.parents p, norm n
  where p.id <> auth.uid()
    and (
      p.email = n.email_norm
      or (n.phone_norm <> '' and p.phone = n.phone_norm)
    )
  limit 1;
$$;

comment on function public.find_parent_by_handle(text) is
  'S-01 search RPC: returns at most one (id, display_name) for an exact email or phone match, excluding the caller.';

grant execute on function public.find_parent_by_handle(text) to authenticated;

-- new RPC: list the caller's accepted-friends (id, display_name).
-- SECURITY DEFINER so it bypasses parents_select's pending-OR branch and
-- returns only accepted-connected parents (excluding self). Phase 3's
-- Connected friends list calls this. (F1 from plan-review.)
create or replace function public.list_my_friends()
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.display_name
  from public.parents p
  where p.id <> auth.uid()
    and public.is_connected(auth.uid(), p.id)
  order by p.display_name asc nulls last;
$$;

comment on function public.list_my_friends() is
  'S-01: returns (id, display_name) for every parent the caller is accepted-connected to, excluding self. Ordered display_name ASC NULLS LAST.';

grant execute on function public.list_my_friends() to authenticated;
```

#### 2. Seed fixture update

**File**: `supabase/seed.sql` (modify)

**Intent**: Populate Alice and Bob's `raw_user_meta_data` so the updated trigger writes non-null `display_name` and `phone` on `db:reset`, then add one accepted `friend_connections` row so the RLS extension is exercisable end-to-end and the search RPC has a known good case.

**Contract**: The two `auth.users` rows for Alice and Bob get a non-empty `raw_user_meta_data` JSON object (`display_name` + `phone`). A new INSERT below the auth.users block adds an accepted FC row from Alice to Bob, idempotent via `ON CONFLICT (requester_id, addressee_id) DO NOTHING`. Phones are fixed test values (`+48111111111` / `+48222222222`).

#### 3. Regenerated database types

**File**: `src/db/database.types.ts` (regenerated)

**Intent**: Pick up the new table, enum, and RPC signatures so Phase 2's API code is type-checked against the schema from day one.

**Contract**: The verbatim output of `npm run db:types` after Phase 1's migration applies. Exports a `Database` type whose `public.friend_connections` Row/Insert/Update shapes, `friend_connection_status` enum union, and `find_parent_by_handle` function signature are all present. **Do not hand-edit.**

#### 4. Updated parents RLS doc

**File**: `supabase/tests/parents-rls.md` (modify)

**Intent**: The pre-S-01 expectations (1 / 1 / 0 rows) no longer hold once Alice and Bob are connected via the seed-loaded FC row. Refresh the row-count expectations and add one sentence explaining the change so a future reader doesn't think the test broke.

**Contract**: Three SQL blocks remain, with the same impersonation pattern. The expected counts become **Alice's view = 2** (Alice + Bob), **Bob's view = 2** (Alice + Bob), **Cross-isolation block = 1** (Alice can now read Bob's row by id because they're connected — this is the desired behaviour, not a regression). Add a paragraph above the blocks that names S-01 as the source of the change.

#### 5. New friend_connections RLS doc

**File**: `supabase/tests/friend-connections-rls.md` (new)

**Intent**: Document the four-policy RLS surface (SELECT / INSERT / UPDATE / DELETE) on `friend_connections` plus the `find_parent_by_handle` RPC behaviour, with copy-pasteable SQL blocks that prove each policy holds under impersonation. This is the verification surface for the privacy NFR on this slice.

**Contract**: Markdown file mirroring the structure of `parents-rls.md`. At minimum **six** numbered blocks, each wrapped in `begin; … rollback;`:

1. **Both sides see the FC row** — impersonate Alice → SELECT from friend_connections, expect 1 row; impersonate Bob → same, 1 row.
2. **Outsider blindness** — impersonate a third UUID with no FC → SELECT from friend_connections, expect 0 rows.
3. **RPC happy path** — impersonate Alice → `select * from public.find_parent_by_handle('bob@example.com')` returns 1 row; `select * from public.find_parent_by_handle('alice@example.com')` (self) returns 0 rows; `select * from public.find_parent_by_handle('nobody@example.com')` returns 0 rows.
4. **Column-level write isolation** — impersonate Bob → `update public.friend_connections set requester_id = '00…b01' where addressee_id = '00…b01';` fails with a "permission denied for column requester_id" error, proving only `status` is mutable.
5. **Pending-state UPDATE policy (added per F1)** — INSERT a pending FC from Alice to a third UUID (Carol-like fixture), impersonate the addressee → `update friend_connections set status = 'accepted' where id = $1` succeeds and the row count becomes 1; impersonate an uninvolved 4th UUID → the same UPDATE affects 0 rows (USING fails silently).
6. **Pending-FC widens parents_select correctly (added per F1)** — with the pending FC from block 5 still in place: impersonate the addressee → `select id from public.parents where id = '<alice-uuid>'` returns 1 row (the new OR-branch grants pending-visibility); impersonate the uninvolved 4th UUID → the same query returns 0 rows (scope is exactly the two parties).

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes (Windows posture: touched-set is `.sql`/`.md`/`.ts`/`.astro`; lint only touched paths via `npx eslint <files>` on Windows; full-tree run still trips the pre-existing CRLF debt)
- `npm run build` passes (proves the regenerated `Database` type is consumed correctly by the typed Supabase client)
- `npm run db:reset` applies the migration AND seed cleanly
- `npm run db:types` regenerates `src/db/database.types.ts` idempotently (no diff if run twice)
- `select count(*) from public.parents` returns 2 after `db:reset` (unchanged from F-01)
- `select count(*) from public.friend_connections` returns 1 after `db:reset`
- `select public.is_connected('00000000-0000-0000-0000-000000000a01'::uuid, '00000000-0000-0000-0000-000000000b01'::uuid)` returns true

#### Manual Verification:

- The three SQL blocks in the updated `supabase/tests/parents-rls.md` produce the documented row counts (2 / 2 / 1)
- All six SQL blocks in the new `supabase/tests/friend-connections-rls.md` produce their documented results
- `select * from public.find_parent_by_handle('bob@example.com')` impersonated as Alice returns one row whose `display_name` is `Bob`; impersonated as Alice with input `'alice@example.com'` returns zero rows; with input `'+48 222 222 222'` returns one row (Bob, via phone normalisation)

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation that the SQL fixtures demonstrate RLS extension correctness before proceeding to Phase 2.

---

## Phase 2: Server-side wiring — signup extension and friend-handshake API

### Overview

Extend the signup form to collect `display_name` (required) + `phone` (optional), zod-parse the signup endpoint, and add four new JSON API routes under `src/pages/api/friends/` for search, request, respond, and cancel. After this phase the full friend-handshake loop is exercisable with `curl` against `npm run dev`.

### Changes Required:

#### 1. SignUpForm with display_name and phone

**File**: `src/components/auth/SignUpForm.tsx` (modify)

**Intent**: Add two new fields above the password input — `display_name` (required, 1–80 chars) and `phone` (optional, light E.164 hint placeholder). Mirror the existing `validate()` pattern for client-side feedback. The form still POSTs as `formData` to `/api/auth/signup` to match the existing pattern; the new fields ride along under `display_name` and `phone` keys.

**Contract**: Two new `FormField` children inserted between the email field and the password field. Validation rules: `display_name` is required and rejects whitespace-only input; `phone` is optional, but if non-empty must start with `+` and contain only `+` plus digits and spaces. The submit handler's client-side `validate()` extends to cover both. No other behaviour changes — `noValidate`, server-error display, password-confirm logic are all unchanged.

#### 2. Signup API: zod parse + metadata forwarding

**File**: `src/pages/api/auth/signup.ts` (modify)

**Intent**: Replace the raw `formData()` reads with a zod-parsed schema, then forward `display_name` and `phone` to Supabase as user metadata so the updated trigger picks them up. This also closes the AGENTS.md "validate API payloads with zod" baseline gap for this handler.

**Contract**: One zod schema (defined inline or in `src/lib/validation/auth.ts`) covering email (string + .email), password (string, min 6), display_name (string, 1..80, trimmed), and phone (optional string, regex `^\+[0-9 ]+$` allowing internal spaces — normalisation happens DB-side). The handler parses `Object.fromEntries(form.entries())` through the schema, redirects with `?error=` on failure with a sanitised message, and on success calls `supabase.auth.signUp({ email, password, options: { data: { display_name, phone: normalised || null } } })`. The phone is stripped of spaces here (or in the trigger via `regexp_replace`); pick one and document the choice in the handler. Recommended: strip in the handler to keep the trigger body identical to the RPC's normalisation.

#### 3. POST /api/friends/search

**File**: `src/pages/api/friends/search.ts` (new)

**Intent**: A single endpoint backed by the `find_parent_by_handle` RPC. Returns at most one matching parent's `(id, display_name)` for an exact email or phone, or `{ found: false }` when no match exists. The RPC owns the security boundary (search across all parents, exclude self); this handler is glue.

**Contract**: `POST /api/friends/search` with JSON body `{ handle: string (1..256 chars) }`. zod-validated. On success: `200 { found: true, id: uuid, display_name: string | null }` or `200 { found: false }`. On validation failure: `400 { error: string }`. On unauthenticated request: `401`. The handler reads `context.locals.user`, refuses if null, otherwise calls `supabase.rpc('find_parent_by_handle', { handle })` and maps the result.

#### 4. POST /api/friends/request

**File**: `src/pages/api/friends/request.ts` (new)

**Intent**: Insert a `pending` row with `requester_id = auth.uid()`. RLS enforces requester == self; the UNIQUE constraint blocks duplicate sends (including re-sends after decline); the CHECK blocks self-requests. Map the DB errors to clean HTTP responses.

**Contract**: `POST /api/friends/request` with body `{ addressee_id: uuid }`. zod-validated. **Pre-INSERT guard (F2 from plan-review):** the handler first calls `supabase.rpc('is_connected', { viewer: user.id, owner: addressee_id })`; if true, return `409 { error: "already connected" }` and skip the INSERT — this prevents the reverse-direction-after-accepted dangling-pending pathology that UNIQUE alone cannot catch. After the guard passes, attempt the INSERT. On success: `201 { id: uuid, status: "pending" }`. On unique violation (already pending/accepted/declined from this direction): `409 { error: "already requested" }`. On CHECK violation (self-request): `422 { error: "cannot request self" }`. On unauthenticated: `401`. On other DB errors: `500`.

#### 5. POST /api/friends/respond

**File**: `src/pages/api/friends/respond.ts` (new)

**Intent**: The addressee accepts or declines a pending request. RLS enforces addressee == self AND current status == pending; the column-level grant prevents anything other than `status` from being written; the WITH CHECK pins the new status to `accepted` or `declined`. Map zero-row-updated to 404 (request not found / not yours / not pending).

**Contract**: `POST /api/friends/respond` with body `{ request_id: uuid, action: "accept"|"decline" }`. zod-validated. The handler issues `update public.friend_connections set status = $action where id = $request_id` via the typed Supabase client. On success: `200 { id, status }`. On RLS USING failure or already-responded: `404 { error: "not found" }`. On validation failure: `400`. On unauthenticated: `401`.

#### 6. DELETE /api/friends/requests/[id]

**File**: `src/pages/api/friends/requests/[id].ts` (new — Astro dynamic API route)

**Intent**: The requester cancels their own pending request. RLS enforces requester == self AND current status == pending. Map zero-row-deleted to 404.

**Contract**: `DELETE /api/friends/requests/[id]` where `[id]` is a uuid path param. The handler validates the param shape with zod (`z.string().uuid()`), then issues `delete from public.friend_connections where id = $1`. On success: `204` (no content). On RLS USING failure or not-pending: `404 { error: "not found" }`. On validation failure: `400`. On unauthenticated: `401`.

#### 7. Optional: shared zod schemas

**File**: `src/lib/validation/friends.ts` (new, optional)

**Intent**: Centralise the four zod schemas (`searchSchema`, `requestSchema`, `respondSchema`, `cancelParamSchema`) so they're importable by both the API handlers and any client-side mirror validation. Defer this until at least two handlers want the same shape — for S-01, define schemas inline in each handler and revisit during Phase 3 if duplication appears.

**Contract**: If created, one file exporting four named schemas + their inferred types. No runtime logic, just zod schemas and `z.infer<…>` exports.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes (Windows posture as in Phase 1)
- `npm run build` passes (proves zod schemas are well-typed and the typed Supabase client accepts the RPC + table queries)

#### Manual Verification:

- Sign up a fresh user with display_name = `"Carol"` and phone = `"+48333333333"`. Confirm in Studio that `parents` has a row with non-null `display_name` and `phone` matching what was typed.
- Sign up a user with display_name only (no phone). Confirm the row has non-null `display_name` and null `phone`.
- Sign up attempt with empty display_name shows the validation error, no row created.
- `curl -X POST http://localhost:4321/api/friends/search -H 'Content-Type: application/json' -d '{"handle":"bob@example.com"}'` (with Alice's cookies) returns `{ "found": true, "id": "...b01", "display_name": "Bob" }`.
- Same search with own email returns `{ "found": false }`.
- Same search with a non-existent handle returns `{ "found": false }`.
- `POST /api/friends/request` with Bob's id (as Alice) returns 409 (already connected); with Carol's id returns 201.
- `POST /api/friends/respond` (as Carol) with `request_id` + `action: accept` returns 200 + status accepted; same request again returns 404.
- `DELETE /api/friends/requests/[some-pending-id]` (as the requester) returns 204; the same as a non-requester returns 404.

**Implementation Note**: After all automated verification passes, pause for manual confirmation that signup + the four API endpoints work end-to-end with curl before proceeding to Phase 3.

---

## Phase 3: UI + integration — /friends page, middleware, dashboard link

### Overview

Wire the API surface into a working `/friends` page with four sections (Search / Incoming / Outgoing pending / Connected friends), each a React island that calls the Phase 2 endpoints and triggers a page reload on success. Add `/friends` to `PROTECTED_ROUTES`. Add a link from `/dashboard` to `/friends`. After this phase the end-to-end loop works in a browser.

### Changes Required:

#### 1. Friends page

**File**: `src/pages/friends.astro` (new)

**Intent**: The Astro shell that SSR-fetches the three list datasets (incoming pending, outgoing pending, connected friends) via the typed Supabase client (RLS does the filtering automatically) and renders the four sections as React islands. The Search section has no initial data; the three list sections receive their data as props.

**Contract**: Page-level frontmatter reads `Astro.locals.user`, refuses if null (middleware already redirects, this is belt-and-braces), then issues three queries:

- `incoming = supabase.from('friend_connections').select('id, requester_id, requested_at, requester:parents!requester_id(id, display_name, email)').eq('addressee_id', user.id).eq('status', 'pending').order('requested_at', { ascending: false })`
- `outgoing = supabase.from('friend_connections').select('id, addressee_id, requested_at, addressee:parents!addressee_id(id, display_name, email)').eq('requester_id', user.id).eq('status', 'pending').order('requested_at', { ascending: false })`
- `friends = supabase.from('parents').select('id, display_name').filter('id', 'neq', user.id)` is NOT sufficient on its own — the Phase 1 fix to `parents_select` (F1 from plan-review) widens the policy to also expose parents who have a PENDING FC with the viewer, so a bare `parents` query would leak pending-only parents into the Connected friends list. Use `supabase.rpc('list_my_friends')` backed by a small SECURITY DEFINER function that returns `(id, display_name)` for parents `p` where `public.is_connected(auth.uid(), p.id) AND p.id <> auth.uid()`. Add that RPC to Phase 1's migration alongside `find_parent_by_handle`. (Alternative: write the explicit `is_connected` filter directly in the supabase-js query via a SQL-string filter; the RPC is cleaner and the database.types.ts regeneration picks up the signature.)

The page renders a Layout wrapping four sections, each a React island via `client:load` (search) and `client:visible` (the three lists, which need re-render after mutation).

#### 2. FriendSearch component

**File**: `src/components/friends/FriendSearch.tsx` (new)

**Intent**: A controlled input with a "Search" button that calls `POST /api/friends/search`, displays the result card (display_name + "Send request" button), or a "No parent found" empty state. On "Send request", calls `POST /api/friends/request`, then triggers `window.location.reload()` on success to refresh the outgoing-pending list. On 409 (already requested), surfaces an inline message.

**Contract**: Self-contained React component. No props. Internal state: `handle`, `loading`, `result: { found: false } | { found: true, id, display_name } | null`. Renders a `FormField` for `handle`, a submit `SubmitButton`, and conditionally the result card. Errors surface inline (no toast system in the codebase yet).

#### 3. IncomingRequestsList component

**File**: `src/components/friends/IncomingRequestsList.tsx` (new)

**Intent**: Render the incoming-pending list. Each row shows requester display_name (fallback to email if null), requested-at humanised, plus two buttons: Accept / Decline. Both call `POST /api/friends/respond` and reload on success.

**Contract**: Props: `requests: { id, requester: { id, display_name, email }, requested_at }[]`. Empty state: "No incoming requests." Each row has stable React keys (`request.id`).

#### 4. OutgoingPendingList component

**File**: `src/components/friends/OutgoingPendingList.tsx` (new)

**Intent**: Render the outgoing-pending list. Each row shows addressee display_name (fallback to email), requested-at humanised, plus a "Cancel" button calling `DELETE /api/friends/requests/[id]` and reloading on success.

**Contract**: Props: `requests: { id, addressee: { id, display_name, email }, requested_at }[]`. Empty state: "No pending requests sent." Same key strategy as IncomingRequestsList.

#### 5. ConnectedFriendsList component

**File**: `src/components/friends/ConnectedFriendsList.tsx` (new — or .astro if no interactivity)

**Intent**: Render the connected-friends list. Each row shows display_name (fallback to email). No actions in S-01 (no unfriend, no invite — that's S-02).

**Contract**: Props: `friends: { id, display_name, email }[]`. Empty state: "No connected friends yet — use Search above to find someone." Order: display_name ASC (NULL last). This component has no interactivity and could be implemented as `.astro` instead of `.tsx`; prefer `.astro` to keep React bundle minimal. Lift `.tsx` if a future slice needs hover/click behaviour.

#### 6. Middleware: protect /friends

**File**: `src/middleware.ts` (modify)

**Intent**: Extend `PROTECTED_ROUTES` so unauthenticated visitors to `/friends` are redirected to `/auth/signin`, same as `/dashboard`.

**Contract**: One-line change: `PROTECTED_ROUTES = ["/dashboard", "/friends"]`. No other middleware logic changes.

#### 7. Dashboard link to /friends

**File**: `src/pages/dashboard.astro` (modify)

**Intent**: Add a visible navigation link to `/friends` so a signed-in parent can reach the new surface without typing the URL. Smallest possible change consistent with the existing card-style design.

**Contract**: Add one anchor `<a href="/friends">` styled to match the existing Sign-out button shape, placed above or beside the Sign-out form. Label: "Friends".

#### 8. AGENTS.md refresh (F3 from plan-review)

**File**: `AGENTS.md` (modify)

**Intent**: Surface the new data-layer landmarks and conventions S-01 introduces so the next agent picking up the codebase reads them once and stays unblocked — the same hand-off pattern F-01 established. Three small edits.

**Contract**:

- **§Current state**: replace the F-01 sentence so it acknowledges that `friend_connections` now exists, that `public.is_connected(viewer, owner)` returns true for accepted connections in either direction (not just self), and that two RPCs are available: `public.find_parent_by_handle(handle)` for searching parents by email/phone (excludes the caller, normalises input) and `public.list_my_friends()` for listing accepted-connected parents. Mention that the `parents_select` policy now also exposes parents involved in pending FCs with the viewer. State that meetings / invitations / conflict check are still TBD.
- **§Key conventions**: add two new bullets right after the **RLS template** bullet:
  - **Search/list RPCs**: when a domain query needs to bypass `parents_select` (e.g., finding a not-yet-connected parent or listing accepted-only when the policy also exposes pending), implement it as a `SECURITY DEFINER` SQL/PLPGSQL function with `set search_path = public, pg_temp`, exclude `auth.uid()` inside the function where appropriate, and `grant execute … to authenticated`. Canonical examples: `public.find_parent_by_handle(text)`, `public.list_my_friends()` (see `supabase/migrations/<S-01 timestamp>_friend_connections_foundation.sql`).
  - **Column-level partial-UPDATE GRANT (REVOKE-first on Supabase)**: RLS `WITH CHECK` only validates the resulting row, not which columns were written. When a policy must restrict _which_ columns are mutable, pair the UPDATE policy with `revoke update on <table> from authenticated; grant update (<col>, …) on <table> to authenticated;`. The REVOKE is load-bearing — Supabase pre-grants ALL on every public table to `authenticated`, so without the REVOKE the column GRANT is additive (and the partial restriction silently breaks). Canonical example: `friend_connections` revokes the broad UPDATE and grants UPDATE only on `status`. Verify via `\dp <table>`: post-fix, `authenticated` shows `ardDxtm` at the table level (no `w`), with `status: authenticated=w` in the Column privileges column.
- **§Commands** (optional, only if room): no change needed — `db:reset` and `db:types` already cover the new migration.

#### Automated Verification:

- `npm run lint` passes (Windows posture)
- `npm run build` passes (proves the new pages and components type-check against the regenerated `Database`)
- `grep -n '/friends' src/middleware.ts` returns a hit confirming the route was added

#### Manual Verification:

- Visiting `/friends` while signed out redirects to `/auth/signin`
- Signed in as Alice (impersonated via the seed fixture or by setting cookies), `/friends` renders four sections; Connected friends shows Bob; Incoming and Outgoing are empty; Search input is present.
- Searching for `bob@example.com` (as Alice) renders the Bob card with "Send request" — clicking it (since they're already connected) surfaces the 409 error inline. Searching for `alice@example.com` (own email) shows the empty-state.
- Sign up a fresh test user (e.g., `dave@example.com`, display_name "Dave"). As Alice, search for `dave@example.com`, send the request → it appears in Alice's Outgoing pending. As Dave, sign in, visit `/friends`, see the request in Incoming, accept it → Alice and Dave now appear in each other's Connected friends list. The accept also removes the entry from the respective pending lists.
- Send another request (Alice → Eve), then cancel from Outgoing pending → row disappears, Eve never sees it.
- Send Alice → Frank, sign in as Frank, decline → row disappears from Frank's Incoming. Verify in Studio that the declined row persists. Attempt Alice → Frank again from the API → returns 409 (the block-forever policy holds).
- `/dashboard` shows the new "Friends" link, clicking it lands on `/friends`.
- AGENTS.md diff reads cleanly: §Current state acknowledges `friend_connections` + extended `is_connected` + the two RPCs + the parents_select pending-OR branch; §Key conventions has the "Search/list RPCs" bullet and the "Column-level partial-UPDATE GRANT" bullet next to the existing RLS-template bullet.

**Implementation Note**: After all automated verification passes, pause for manual confirmation that the end-to-end browser flow works (signup → search → request → accept → connected-list visibility) before declaring S-01 done.

---

## Testing Strategy

### Unit Tests

None for S-01. The data layer is exercised by the SQL test docs; the API handlers are thin glue over zod + Supabase RPC/queries; the UI components are exercised by manual walkthroughs. Investing in a unit-test framework for one slice is premature — defer until a slice has logic worth isolating (likely S-03's conflict-check).

### Integration Tests

- `npm run db:reset` applying cleanly **is** the migration integration test — a syntactically invalid migration, a misspelled column, or a broken RLS policy expression fails here.
- Phase 1's two RLS test docs + the manual SQL block walkthroughs collectively form a one-shot integration test of the privacy + state-machine surface.
- Phase 2's curl walkthrough is the API integration test.
- Phase 3's browser walkthrough is the end-to-end integration test.

### Manual Testing Steps

1. Start Docker if not running; `npx supabase start`.
2. `npm run db:reset` — confirm migrations + seed apply, 2 parents + 1 friend_connection row.
3. `npm run db:types` — confirm idempotency.
4. `npm run dev` — sign up a fresh user (display_name + phone), confirm parents row has both populated.
5. Walk through the three SQL blocks in updated `parents-rls.md` and the four blocks in new `friend-connections-rls.md`.
6. Walk through the Phase 2 curl scenarios for search / request / respond / cancel.
7. Walk through the Phase 3 browser scenarios: protected redirect, search / request / accept / cancel / decline-then-re-request loops.

## Performance Considerations

The three partial indexes (`friend_connections_addressee_pending_idx`, `friend_connections_requester_pending_idx`, `friend_connections_accepted_addressee_idx`) keep all three primary access patterns (incoming pending, outgoing pending, "am I connected to X") index-only at MVP scale. `is_connected` is `stable` and inline-able; the RPC is `stable` and uses partial indexes for its exists-check. The friend_connections table will hold O(friends²) rows worst-case, but MVP target_scale is `users: medium`, so even a 100-parent network with ~10 friends each is ~1000 rows — index scans dominate, sequential scans are fine where the planner picks them. Revisit if a future slice surfaces query latency.

## Migration Notes

- This is the second migration; the pattern set by F-01 (one atomic migration per slice, idempotent SQL, named via `supabase migration new`) continues.
- The migration is forward-additive: it adds a table + indexes + RLS + an enum, and supersedes two function bodies. No data is destroyed; no column is dropped. If rollback ever becomes necessary, drop in reverse order: policies → table → enum → restore F-01 function bodies. No rollback script is shipped.
- The supersede of `handle_new_user` is non-destructive for existing parents (Alice / Bob get backfilled via the seed update; any production parents would stay null until they next sign in — but there are no production parents until the user pushes to remote, which is out of S-01 scope).
- Cloudflare Workers (production) and the local Supabase Docker stack share schema but are managed independently. Local migrations apply via `supabase db reset`. Pushing this migration to a remote Supabase project is out of S-01 scope — it lands when the user wires the production Supabase URL into Cloudflare Workers Secrets.

## References

- Roadmap entry: `context/foundation/roadmap.md` §S-01
- PRD: `context/foundation/prd.md` §US-02, §FR-001..005, §NFR Privacy boundary, §Access Control
- F-01 archive: `context/archive/2026-05-26-parents-profile-and-rls-foundation/plan.md` — migration template, `is_connected` stub, signup pattern
- AGENTS.md: §Key conventions → RLS template, `zod` validation, migration naming
- F-01 impl-review (notes phone/display_name null state): `context/archive/2026-05-26-parents-profile-and-rls-foundation/reviews/impl-review.md`
- Supabase auth metadata pattern: <https://supabase.com/docs/reference/javascript/auth-signup>
- Existing typed-client touchpoint: [src/lib/supabase.ts:10](../../../src/lib/supabase.ts#L10)
- Existing middleware: [src/middleware.ts:4](../../../src/middleware.ts#L4)
- Existing form pattern: [src/components/auth/SignUpForm.tsx:65-132](../../../src/components/auth/SignUpForm.tsx#L65-L132)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data layer — table, helper extension, RPC, seed

#### Automated

- [x] 1.1 `npm run lint` passes — 03ce3a9
- [x] 1.2 `npm run build` passes — 03ce3a9
- [x] 1.3 `npm run db:reset` applies migration AND seed cleanly — 03ce3a9
- [x] 1.4 `npm run db:types` regenerates `src/db/database.types.ts` idempotently — 03ce3a9
- [x] 1.5 `select count(*) from public.parents` returns 2 after `db:reset` — 03ce3a9
- [x] 1.6 `select count(*) from public.friend_connections` returns 1 after `db:reset` — 03ce3a9
- [x] 1.7 `select public.is_connected('00000000-0000-0000-0000-000000000a01'::uuid, '00000000-0000-0000-0000-000000000b01'::uuid)` returns true — 03ce3a9

#### Manual

- [x] 1.8 The three SQL blocks in updated `supabase/tests/parents-rls.md` produce the documented row counts (2, 2, 1) — 03ce3a9
- [x] 1.9 The six SQL blocks in new `supabase/tests/friend-connections-rls.md` produce their documented results — 03ce3a9
- [x] 1.10 `find_parent_by_handle` returns Bob for `'bob@example.com'`, zero rows for `'alice@example.com'` (self), one row for `'+48 222 222 222'` (phone normalisation) — 03ce3a9

### Phase 2: Server-side wiring — signup extension and friend-handshake API

#### Automated

- [x] 2.1 `npm run lint` passes — 6ce3504
- [x] 2.2 `npm run build` passes — 6ce3504

#### Manual

- [x] 2.3 Signing up with display_name + phone populates both columns on `parents`; signing up with display_name only leaves phone null — 6ce3504
- [x] 2.4 Empty display_name submission shows the validation error and creates no row — 6ce3504
- [x] 2.5 `POST /api/friends/search` returns the expected payloads for known handle, self, non-existent handle — 6ce3504
- [x] 2.6 `POST /api/friends/request` returns 201 on first send, 409 on duplicate from same direction, 409 (with `"already connected"`) on reverse direction after accepted, 422 on self — 6ce3504
- [x] 2.7 `POST /api/friends/respond` returns 200 + accepted on first accept; 404 on replay (RLS USING fails after status flips) — 6ce3504
- [x] 2.8 `DELETE /api/friends/requests/[id]` returns 204 for the requester, 404 for a non-requester — 6ce3504

### Phase 3: UI + integration — /friends page, middleware, dashboard link

#### Automated

- [x] 3.1 `npm run lint` passes
- [x] 3.2 `npm run build` passes
- [x] 3.3 `/friends` is in `PROTECTED_ROUTES` in `src/middleware.ts`

#### Manual

- [x] 3.4 `/friends` while signed out redirects to `/auth/signin`
- [x] 3.5 Signed-in `/friends` renders all four sections; Alice's Connected list shows Bob; Search returns Bob for his email and empty-state for self
- [x] 3.6 Full happy-path loop works: fresh signup → search → request → other user accepts → both see each other in Connected list
- [x] 3.7 Cancel from Outgoing pending removes the row; the addressee never sees it
- [x] 3.8 Decline removes the row from Incoming; the row persists in Studio; re-request from the same direction returns 409 (block-forever holds)
- [x] 3.9 `/dashboard` shows the "Friends" link, clicking it lands on `/friends`
- [x] 3.10 AGENTS.md diff reads cleanly: §Current state acknowledges `friend_connections` + extended `is_connected` + the two RPCs + parents_select pending-OR branch; §Key conventions has the Search/list-RPCs bullet and the Column-level GRANT bullet
