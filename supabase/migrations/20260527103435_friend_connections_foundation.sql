-- ============================================================================
-- S-01: Friend connection handshake foundation
--   - public.friend_connections: directional rows + status enum
--   - public.is_connected(viewer, owner): extended to consult accepted FC rows
--     in either direction (F-01 stub becomes a full template helper)
--   - public.parents_select policy: widened so a parent involved in a PENDING
--     FC with the viewer is visible too (without leaking outside that pair)
--   - public.handle_new_user(): reads display_name + phone from raw_user_meta_data
--   - public.find_parent_by_handle(text): SECURITY DEFINER search RPC
--   - public.list_my_friends(): SECURITY DEFINER list-of-accepted-friends RPC
-- ============================================================================

-- ----------------------------------------------------------------------------
-- enum + table
-- ----------------------------------------------------------------------------
create type public.friend_connection_status as enum ('pending', 'accepted', 'declined');

create table public.friend_connections (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.parents(id) on delete cascade,
  addressee_id uuid not null references public.parents(id) on delete cascade,
  status       public.friend_connection_status not null default 'pending',
  requested_at timestamptz not null default now(),
  constraint friend_connections_no_self check (requester_id <> addressee_id),
  constraint friend_connections_unique_pair unique (requester_id, addressee_id)
);

comment on table public.friend_connections is
  'Directional friend-request rows. UNIQUE(requester_id, addressee_id) is per-direction; the reverse direction is a separate tuple by design (see S-01 plan).';

-- ----------------------------------------------------------------------------
-- partial indexes
-- ----------------------------------------------------------------------------
create index friend_connections_addressee_pending_idx
  on public.friend_connections(addressee_id) where status = 'pending';

create index friend_connections_requester_pending_idx
  on public.friend_connections(requester_id) where status = 'pending';

create index friend_connections_accepted_addressee_idx
  on public.friend_connections(addressee_id) where status = 'accepted';

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
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

-- Column-level grants: only `status` is mutable via UPDATE. RLS WITH CHECK
-- validates the resulting row, not which columns were written; the partial
-- UPDATE grant is what actually pins the mutable surface to `status`.
--
-- IMPORTANT: Supabase's default schema setup pre-grants ALL privileges on
-- every public-schema table to authenticated (see `\dp`). A bare `grant
-- update (status) … to authenticated` would therefore be ADDITIVE to that
-- broad grant — Postgres column GRANTs only restrict when the role does not
-- already hold table-level UPDATE. The REVOKE below strips the default
-- broad-UPDATE; the column GRANT then pins the writeable surface to `status`
-- alone. Plan adaptation discovered during Phase 1 verification (block 4).
grant select, insert, delete on public.friend_connections to authenticated;
revoke update on public.friend_connections from authenticated;
grant update (status) on public.friend_connections to authenticated;

-- ----------------------------------------------------------------------------
-- extend is_connected
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- extend parents_select: also expose parents involved in a PENDING FC with the
-- viewer. Scope is exactly the two parties (no leak to outsiders). F1 from
-- plan-review.
-- ----------------------------------------------------------------------------
alter policy parents_select on public.parents
  using (
    public.is_connected(auth.uid(), public.parents.id)
    or exists (
      select 1
      from public.friend_connections fc
      where fc.status = 'pending'
        and (
          (fc.requester_id = auth.uid() and fc.addressee_id = public.parents.id)
          or (fc.addressee_id = auth.uid() and fc.requester_id = public.parents.id)
        )
    )
  );

-- ----------------------------------------------------------------------------
-- supersede handle_new_user: read display_name + phone from raw_user_meta_data
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- find_parent_by_handle RPC: exact match on email or phone with light
-- normalisation, excludes the caller (silent zero for self-search).
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- list_my_friends RPC: SECURITY DEFINER list of accepted-connected parents,
-- excluding self. Phase 3's Connected friends list calls this. The bare
-- parents_select policy now also exposes pending-FC parents, which would
-- otherwise leak into the list. F1 from plan-review.
-- ----------------------------------------------------------------------------
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
