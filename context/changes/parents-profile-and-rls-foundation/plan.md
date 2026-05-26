# Parents Profile + RLS Foundation Implementation Plan

## Overview

Lay AppiTata's data foundation: a `public.parents` table linked 1:1 to `auth.users` via a Postgres trigger, plus a reusable `is_connected(viewer, owner)` SQL helper that every later domain table's RLS policy calls. F-01 ships the helper with a self-only stub body (`select viewer = owner`); S-01 will extend it once `friend_connections` exists. This is foundation work — no UI, no new API surface — and it carries the PRD's privacy-boundary NFR end-to-end.

## Current State Analysis

- `supabase/migrations/` does not exist. This is the project's first migration.
- `supabase/config.toml` is present; `enable_confirmations = false` ([supabase/config.toml:209](supabase/config.toml#L209)); Postgres major version 17.
- Supabase clients (`@supabase/ssr` 0.10.3 + `@supabase/supabase-js` 2.99.1) are wired via [src/lib/supabase.ts:9](src/lib/supabase.ts#L9); `createServerClient` is currently un-typed (no `Database` generic).
- [src/middleware.ts:6](src/middleware.ts#L6) populates `context.locals.user`; the Locals type is in [src/env.d.ts](src/env.d.ts).
- Three auth endpoints under `src/pages/api/auth/{signin,signup,signout}.ts`; signup uses raw `formData()` with no `zod` validation (a known baseline gap — out of F-01 scope per the roadmap).
- No `src/types.ts`, no `src/db/`, no `supabase/seed.sql`, no `supabase/tests/`.
- AGENTS.md already documents the migration naming convention (`YYYYMMDDHHmmss_short_description.sql`) and the `npx supabase start` Docker dependency.

## Desired End State

- `public.parents` exists; every `auth.users` row has a corresponding `public.parents` row, created atomically by a Postgres trigger on `auth.users` INSERT.
- `public.is_connected(viewer uuid, owner uuid) returns boolean` exists as a SECURITY DEFINER function with locked `search_path`; F-01 body is `select viewer = owner;`.
- RLS is enabled on `parents`. The `authenticated` role can SELECT via `is_connected(auth.uid(), id)` and UPDATE only when `id = auth.uid()`. No INSERT or DELETE policies — the trigger owns INSERT, DELETE is not exposed at MVP.
- `src/db/database.types.ts` is generated, checked in, and consumed via `createServerClient<Database>` in `src/lib/supabase.ts`.
- `npm run db:reset` and `npm run db:types` work and are documented in AGENTS.md.
- A documented, copy-pasteable SQL fixture proves that parent A cannot SELECT parent B's row.

### Key Discoveries

- Migration naming convention from AGENTS.md: `YYYYMMDDHHmmss_short_description.sql`. Use `npx supabase migration new parents_foundation` to generate the timestamped filename rather than hardcoding it.
- `@supabase/ssr`'s `createServerClient` accepts a `Database` type parameter — wiring the generated type once at the factory pays off for every later query.
- `enable_confirmations = false` means the `auth.users` row exists the moment signup completes; the trigger fires there, not on email-confirm.
- `auth.uid()` returns the JWT subject claim and equals `parents.id` directly — no extra mapping table needed.
- The infrastructure doc's risk register flags "Supabase via Hyperdrive misconfigured" as a deploy concern — that's downstream of F-01 and not gated by it.

## What We're NOT Doing

- `friend_connections` table (deferred to S-01; F-01 ships the helper stub so the function shape is committed even though the body will change).
- UI changes — no profile page, no friends-list, no shadcn additions, no `/api/parents/*` endpoints.
- Anonymous-user policies — none of the MVP is public; only the `authenticated` role gets grants on `parents`.
- A `PATCH /api/parents/me` endpoint to exercise the UPDATE policy — verified via manual SQL instead.
- Touching the signup handler or adding `zod` validation there — known baseline gap, addressed when a slice actually needs it.
- Enabling email confirmation — PRD does not require it; revisit post-MVP.
- `supabase db diff` in CI — overinvestment for a solo MVP.
- pgTAP automated tests — introducing a new test framework for one migration is unwarranted.
- Pushing the migration to a remote (production) Supabase project — local Docker is the verification surface; the production deploy step belongs to the next change.

## Implementation Approach

Pack the entire foundation into **one atomic migration**: parents table + `is_connected` helper + RLS policies + auth.users trigger. Splitting the migration would leave the table half-locked at intermediate states (RLS enabled with no policies = all rows invisible to authenticated role). Two phases of work flow around that one migration:

- **Phase 1** wires the migration into a usable dev loop — npm scripts, type generation, typed Supabase client — and proves end-to-end signup creates a parents row.
- **Phase 2** lands the verification fixture and updates AGENTS.md so the convention is durable for future agents.

The migration uses the standard Supabase auth-user-trigger pattern (`handle_new_user` function + `on_auth_user_created` trigger on `auth.users`), with the SECURITY DEFINER hardening (locked `search_path`) the Supabase docs recommend.

## Critical Implementation Details

- **SECURITY DEFINER + `search_path`.** Both `is_connected` and `handle_new_user` must `set search_path = public, pg_temp` (or `= ''` if fully qualifying every identifier). Without this, a malicious search_path could hijack function resolution. Standard Supabase hardening; non-negotiable.
- **Trigger function is not callable by anyone but the trigger.** After defining `handle_new_user`, `revoke execute on function public.handle_new_user() from public, anon, authenticated` so the function is only invokable in the trigger context.
- **Trigger idempotency.** Use `insert ... on conflict (id) do nothing` inside `handle_new_user`. This is defensive against re-fires and against seed fixtures that pre-insert.
- **Verifying RLS via SQL — order of `set local` matters.** `set local role authenticated;` then `set local request.jwt.claims to '{"sub": "<uuid>"}';` — both, in that order. Setting role without claims gives `auth.uid() = null` and every policy fails. The verification doc must spell this out.
- **Type generation requires a running local DB.** `supabase gen types typescript --local` connects to the running Docker stack — `npx supabase start` must be active. Document this in a code comment near the `db:types` script entry in `package.json` only if the failure mode isn't obvious from the Supabase CLI error message.

## Phase 1: Foundation Migration + Dev-Loop Tooling

### Overview

Apply the single atomic migration; bring up the dev loop (npm scripts, type generation, typed Supabase client); prove signup creates a `parents` row.

### Changes Required:

#### 1. Foundation migration

**File**: `supabase/migrations/<timestamp>_parents_foundation.sql` (new — generate the timestamp with `npx supabase migration new parents_foundation`)

**Intent**: Land the `parents` table, the `is_connected` helper, RLS policies, and the `auth.users` trigger as one atomic unit. RLS-without-policies is a footgun, so the table, its policies, and the trigger that populates it must ship together.

**Contract**: One migration file containing the SQL below. The schema, function signatures, and grant set are load-bearing — every later domain table will mimic this template.

```sql
-- ============================================================================
-- F-01: Parents profile + RLS foundation
--   - public.parents: 1:1 with auth.users, materialised by a trigger.
--   - public.is_connected(viewer, owner): RLS template helper. F-01 body is
--     self-only (viewer = owner); S-01 will extend it to consult
--     friend_connections.
-- ============================================================================

create table public.parents (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null unique,
  phone         text unique,
  display_name  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.parents is
  'Domain mirror of auth.users. Every auth user has exactly one parents row, created by the on_auth_user_created trigger.';

-- ----------------------------------------------------------------------------
-- RLS template helper. F-01 ships a self-only stub; S-01 will UPDATE the body
-- to also return true when (viewer, owner) are in an accepted friend_connection.
-- Every later domain table writes its SELECT policy as:
--   using ( public.is_connected(auth.uid(), <owner_column>) )
-- ----------------------------------------------------------------------------
create or replace function public.is_connected(viewer uuid, owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select viewer = owner;
$$;

comment on function public.is_connected(uuid, uuid) is
  'F-01 stub: returns viewer = owner. S-01 will extend to include accepted friend_connections.';

grant execute on function public.is_connected(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- auth.users -> public.parents trigger
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.parents (id, email, phone)
  values (new.id, new.email, new.phone)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- RLS on parents.
--   SELECT: visible when viewer is connected (F-01: viewer = self).
--   UPDATE: only the parent can edit their own row.
--   No INSERT policy: trigger owns inserts.
--   No DELETE policy: not exposed in MVP.
-- ----------------------------------------------------------------------------
alter table public.parents enable row level security;

create policy parents_select on public.parents
  for select to authenticated
  using ( public.is_connected(auth.uid(), id) );

create policy parents_update on public.parents
  for update to authenticated
  using      ( id = auth.uid() )
  with check ( id = auth.uid() );

grant select, update on public.parents to authenticated;
```

#### 2. Generated database types

**File**: `src/db/database.types.ts` (new — generated)

**Intent**: Provide a canonical typed schema for every Supabase client call. Regenerated by `npm run db:types` whenever the schema changes.

**Contract**: The verbatim output of `npx supabase gen types typescript --local > src/db/database.types.ts` after the migration is applied. Exports the `Database` type with `public.parents` Row/Insert/Update shapes and the `is_connected` function signature. **Do not hand-edit** — regenerate via the npm script.

#### 3. Typed Supabase client

**File**: `src/lib/supabase.ts` (modify)

**Intent**: Thread the generated `Database` type through `createServerClient` so every query is type-checked against the schema from day one.

**Contract**: Add `import type { Database } from "@/db/database.types"` at the top; change `createServerClient(SUPABASE_URL, SUPABASE_KEY, {...})` to `createServerClient<Database>(SUPABASE_URL, SUPABASE_KEY, {...})`. No other behavior change.

#### 4. npm scripts for the DB dev loop

**File**: `package.json` (modify)

**Intent**: Make `supabase db reset` and type regeneration one-command operations that future agents and humans both reach for.

**Contract**: Add to the `"scripts"` object:

- `"db:reset": "supabase db reset"` — applies all migrations + seed against the local Supabase Docker stack.
- `"db:types": "supabase gen types typescript --local > src/db/database.types.ts"` — regenerates `src/db/database.types.ts` from the running local schema.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes
- `npm run build` passes (proves `createServerClient<Database>` is well-typed against the generated schema)
- `npx supabase db reset` applies the migration without error
- `npm run db:types` regenerates `src/db/database.types.ts` idempotently (no diff if run twice in a row)
- `npm run db:reset` is recognized by npm (resolves to the documented script)

#### Manual Verification:

- After `npx supabase start && npm run db:reset`, signing up a new user via `/auth/signup` creates exactly one row in `public.parents` with id/email matching the new `auth.users` row and `created_at` within seconds of now
- A second signup with the same email is rejected at the auth layer (existing uniqueness preserved)
- In Studio SQL editor, `select * from public.parents` as the `authenticated` role with **no** JWT (`auth.uid() = null`) returns **zero** rows (the SELECT policy fails when `is_connected(null, id)` returns false)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that signup → parents row creation works end-to-end before proceeding to Phase 2.

---

## Phase 2: Verification Fixture + Agent Docs

### Overview

Make F-01 verifiable in isolation (the RLS isolation check needs two parents; one fixture file gets us there reliably). Update AGENTS.md so the dev-loop commands and the RLS template convention are durable for future agents.

### Changes Required:

#### 1. Seed fixture

**File**: `supabase/seed.sql` (new)

**Intent**: Insert two parents via the auth path so the trigger fires and produces matching `public.parents` rows. Provides the fixture the manual RLS check below operates against. Idempotent against repeated `supabase db reset`.

**Contract**: Two `INSERT INTO auth.users (...) ON CONFLICT (id) DO NOTHING` statements with fixed UUIDs and emails (Alice + Bob). The trigger backfills `public.parents`. A leading comment block names the two fixed UUIDs by role so `supabase/tests/parents-rls.md` can reference them. No real password — fixtures aren't sign-in test users; the SQL verification uses `set local request.jwt.claims` to impersonate, not the login flow.

```sql
-- ============================================================================
-- F-01 verification fixture: two parents for the manual RLS isolation check
-- documented in supabase/tests/parents-rls.md.
--
--   Alice:  00000000-0000-0000-0000-000000000a01  alice@example.com
--   Bob:    00000000-0000-0000-0000-000000000b01  bob@example.com
--
-- The on_auth_user_created trigger backfills public.parents from these rows.
-- ============================================================================

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'alice@example.com', '',
   now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('00000000-0000-0000-0000-000000000b01', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bob@example.com', '',
   now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}')
on conflict (id) do nothing;
```

#### 2. Manual RLS verification doc

**File**: `supabase/tests/parents-rls.md` (new)

**Intent**: The 30-second copy-pasteable SQL check that proves parent A cannot SELECT parent B's row, and that parent A CAN SELECT their own. This IS the verification of the privacy NFR for F-01.

**Contract**: Markdown file with a short intro and three numbered SQL blocks, each wrapped in `begin; ... rollback;` to keep the local DB clean:

1. **"Alice's view"** — impersonate Alice (`set local role authenticated; set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}'`); `select id, email from public.parents` → expect 1 row (Alice).
2. **"Bob's view"** — same pattern with Bob's UUID → expect 1 row (Bob).
3. **"Cross-isolation"** — impersonate Alice; `select * from public.parents where id = '00000000-0000-0000-0000-000000000b01'` → expect 0 rows.

The doc includes one sentence on _why_ `set local role` must be paired with `set local request.jwt.claims` (without claims, `auth.uid()` returns null) — this is the most common way the check is run wrong.

#### 3. AGENTS.md updates

**File**: `AGENTS.md` (modify)

**Intent**: Surface the new dev-loop commands where agents look first (§Commands), capture the RLS template as a project convention (§Architecture → Key conventions), and update §Current state so a fresh agent knows the data layer has begun.

**Contract**: Three small edits:

- **§Commands**: add a sentence about the DB workflow naming the two npm scripts (`npm run db:reset`, `npm run db:types`) and the Docker dependency.
- **§Key conventions**: directly after the "Supabase migrations" bullet, add an "**RLS template**" bullet pointing to `public.is_connected(viewer, owner)` as the SECURITY DEFINER helper every domain table's SELECT policy must call, with a one-line example: `using (public.is_connected(auth.uid(), owner_id))`. Cross-ref the foundation migration file for the canonical example.
- **§Current state**: replace the sentence "The AppiTata domain — friends, meetings, invitations, conflict checking — does not exist yet, so expect to add Supabase tables, migrations, pages, and API routes." with one acknowledging that the `parents` table and RLS template now exist, and that friends / meetings / invitations are still TBD.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes
- `npm run build` passes
- `npm run db:reset` applies the migration AND seed cleanly (no SQL syntax errors)
- `select count(*) from public.parents` returns 2 after `npm run db:reset`

#### Manual Verification:

- Running each of the three SQL blocks from `supabase/tests/parents-rls.md` in Supabase Studio produces the documented row counts (1, 1, 0) — proves the SELECT policy isolates parents end-to-end
- The AGENTS.md diff reads cleanly: §Commands surfaces `db:reset`/`db:types`; §Key conventions has an RLS template bullet next to the existing Supabase migrations bullet; §Current state no longer claims the domain doesn't exist

**Implementation Note**: After all automated verification passes, pause for manual confirmation that the SQL fixture demonstrates RLS isolation (the 1/1/0 result) before declaring F-01 done.

---

## Testing Strategy

### Unit Tests

None. F-01 is pure data layer; the only TypeScript change is the `<Database>` generic on `createServerClient`, which is exercised by `npm run build`.

### Integration Tests

- `npm run db:reset` applying cleanly **is** the migration integration test — a syntactically invalid migration fails here.
- Phase 2's seed + manual SQL doc collectively form a one-shot integration test of the RLS policy.

### Manual Testing Steps

1. Start Docker if it isn't running.
2. `npx supabase start`
3. `npm run db:reset` — confirm migrations + seed apply, and 2 rows land in `public.parents`.
4. Open Supabase Studio (default `http://127.0.0.1:54323`), open SQL editor, run each of the three blocks from `supabase/tests/parents-rls.md` — verify row counts.
5. `npm run dev`; sign up a fresh email via `/auth/signup`; confirm a third row appears in `public.parents` (via Studio).
6. (Optional) `npx supabase stop && npx supabase start && npm run db:reset` to confirm full re-creation from a cold start.

## Performance Considerations

None for MVP. The trigger fires once per signup (latency dominated by Supabase auth itself); `is_connected` is `stable` and inline-able; the SELECT policy adds one function call per row, and the stub returns immediately on equality. When S-01 extends the helper body to consult `friend_connections`, that's when an index on `friend_connections(requester_id, addressee_id, status)` becomes load-bearing — not in F-01.

## Migration Notes

- This is the project's **first** migration. The pattern set here (one atomic migration per slice, idempotent SQL, named via `supabase migration new`) is the template every later slice follows.
- Cloudflare Workers (production) and the local Supabase Docker stack share schema but are managed independently. Local migrations apply via `supabase db reset`. Pushing the migration to a remote Supabase project (`supabase db push`) is out of F-01 scope — that step lands when the user wires the production Supabase URL and key into Cloudflare Workers Secrets.
- The migration is forward-compatible (purely additive). No rollback script needed. If a rollback ever becomes necessary, drop in reverse order: trigger → trigger function → policies → table → helper function.

## References

- Roadmap entry: `context/foundation/roadmap.md` §F-01
- PRD: `context/foundation/prd.md` §FR-001, §NFR Privacy boundary, §Access Control
- Infrastructure: `context/foundation/infrastructure.md` (Supabase via Hyperdrive risk is downstream of F-01)
- Supabase auth-user trigger pattern: <https://supabase.com/docs/guides/auth/managing-user-data>
- AGENTS.md migration naming convention
- Existing typed-client touchpoint: [src/lib/supabase.ts:9](../../../src/lib/supabase.ts#L9)
- Existing middleware Locals shape: [src/env.d.ts:3](../../../src/env.d.ts#L3)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Foundation migration + dev-loop tooling

#### Automated

- [x] 1.1 `npm run lint` passes
- [x] 1.2 `npm run build` passes (proves `createServerClient<Database>` is well-typed)
- [x] 1.3 `npx supabase db reset` applies the migration without error
- [x] 1.4 `npm run db:types` regenerates `src/db/database.types.ts` idempotently
- [x] 1.5 `npm run db:reset` is recognized by npm (resolves to the documented script)

#### Manual

- [x] 1.6 Signing up via `/auth/signup` creates exactly one `public.parents` row with matching id/email
- [x] 1.7 Second signup with the same email is rejected at the auth layer
- [x] 1.8 `select * from public.parents` as `authenticated` with no JWT returns zero rows

### Phase 2: Verification fixture + agent docs

#### Automated

- [ ] 2.1 `npm run lint` passes
- [ ] 2.2 `npm run build` passes
- [ ] 2.3 `npm run db:reset` applies migration AND seed cleanly
- [ ] 2.4 `select count(*) from public.parents` returns 2 after `db:reset`

#### Manual

- [ ] 2.5 The three SQL blocks from `supabase/tests/parents-rls.md` produce 1, 1, 0 rows respectively
- [ ] 2.6 AGENTS.md diff reads cleanly: §Commands names `db:reset`/`db:types`; §Key conventions has an RLS-template bullet; §Current state acknowledges parents exists
