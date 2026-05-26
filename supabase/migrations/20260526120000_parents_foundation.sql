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
