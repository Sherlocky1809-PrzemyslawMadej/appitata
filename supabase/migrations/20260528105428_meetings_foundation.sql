-- S-02: meetings + meeting_invitations foundation.
--
-- Adds the domain tables for the meeting-creation-and-invite slice plus the
-- atomic-create RPC that wraps "insert meeting + insert N invitations" in one
-- transaction with eager is_connected validation. Meetings are immutable after
-- create in S-02 (no UPDATE policy on either table); creator can delete a
-- meeting (cascade via FK). The meeting_invitation_status enum carries all four
-- values from day one; S-02 only writes 'pending' (S-03 transitions to
-- accepted / declined, S-04 to expired).

-- enum (all 4 values upfront so S-03/S-04 don't need ALTER TYPE)
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

-- Cross-table RLS helpers (SECURITY DEFINER, break mutual recursion).
--
-- meetings_select needs to check "is the viewer invited to this meeting?" and
-- meeting_invitations_select needs to check "is the viewer the creator of the
-- meeting this invitation belongs to?". If both policies reference each other
-- via bare EXISTS subqueries, Postgres detects infinite recursion and aborts
-- every SELECT with `ERROR: infinite recursion detected in policy`. The fix
-- is to wrap each cross-table EXISTS in a SECURITY DEFINER function — the
-- definer call bypasses RLS during the lookup, so the cycle is broken. Same
-- shape as is_connected from F-01 / S-01.
create or replace function public.user_is_meeting_invitee(p_meeting_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.meeting_invitations mi
    where mi.meeting_id = p_meeting_id
      and mi.invitee_id = p_user_id
  );
$$;

comment on function public.user_is_meeting_invitee(uuid, uuid) is
  'S-02: returns true iff p_user_id has an invitation row for p_meeting_id. SECURITY DEFINER to break the meetings_select <-> meeting_invitations_select recursion.';

grant execute on function public.user_is_meeting_invitee(uuid, uuid) to authenticated;

create or replace function public.user_is_meeting_creator(p_meeting_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.meetings m
    where m.id = p_meeting_id
      and m.creator_id = p_user_id
  );
$$;

comment on function public.user_is_meeting_creator(uuid, uuid) is
  'S-02: returns true iff p_user_id is the creator of p_meeting_id. SECURITY DEFINER to break the meetings_select <-> meeting_invitations_select recursion.';

grant execute on function public.user_is_meeting_creator(uuid, uuid) to authenticated;

-- RLS on meetings
alter table public.meetings enable row level security;

create policy meetings_select on public.meetings
  for select to authenticated
  using (
    auth.uid() = creator_id
    or public.user_is_meeting_invitee(id, auth.uid())
  );

create policy meetings_insert on public.meetings
  for insert to authenticated
  with check (auth.uid() = creator_id);

create policy meetings_delete on public.meetings
  for delete to authenticated
  using (auth.uid() = creator_id);

-- No UPDATE policy in S-02 (meetings are immutable after create). The REVOKE
-- below is load-bearing: Supabase pre-grants ALL on public.* to authenticated,
-- so without it the broad table-level UPDATE grant would still allow writes.
grant select, insert, delete on public.meetings to authenticated;
revoke update on public.meetings from authenticated;

-- RLS on meeting_invitations
alter table public.meeting_invitations enable row level security;

create policy meeting_invitations_select on public.meeting_invitations
  for select to authenticated
  using (
    auth.uid() = invitee_id
    or public.user_is_meeting_creator(meeting_id, auth.uid())
  );

create policy meeting_invitations_insert on public.meeting_invitations
  for insert to authenticated
  with check (
    status = 'pending'
    and public.user_is_meeting_creator(meeting_id, auth.uid())
    and public.is_connected(auth.uid(), invitee_id)
  );

-- No UPDATE policy in S-02 (S-03 lands accept/decline). No DELETE policy ever
-- on invitations: they only disappear via FK cascade when their meeting is
-- deleted. REVOKE is required for the same reason as on meetings above.
grant select, insert on public.meeting_invitations to authenticated;
revoke update, delete on public.meeting_invitations from authenticated;

-- Atomic create RPC: wraps meeting INSERT + N invitation INSERTs in one
-- transaction. SECURITY DEFINER bypasses RLS but the function enforces the
-- equivalent posture explicitly: requires auth.uid(), requires >= 1 invitee,
-- and requires every invitee to be is_connected to the caller. Raises typed
-- exceptions the API layer maps to specific HTTP statuses.
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

  -- Defense-in-depth cap (Phase 2 zod should mirror this). PRD's secondary
  -- success target is ~3 connected friends; 50 is a generous ceiling that
  -- still blocks pathological array sizes from running 10k is_connected
  -- calls inside a single transaction.
  if cardinality(p_invitee_ids) > 50 then
    raise exception 'too many invitees (max 50)' using errcode = '22023';
  end if;

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
