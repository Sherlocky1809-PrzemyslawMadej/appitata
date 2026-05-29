-- ============================================================================
-- S-03: meeting invitation respond (accept / decline) + responded_at audit
--
--   - responded_at timestamptz column on meeting_invitations (nullable; null
--     while pending, stamped by the API on the first response).
--   - meeting_invitations_update RLS policy: one-shot transition
--     pending -> (accepted | declined), invitee-only.
--   - Column-level GRANT on (status, responded_at) — the REVOKE half is
--     already in place from the S-02 migration (revoke update, delete on
--     public.meeting_invitations from authenticated), so this migration only
--     needs to GRANT the writeable surface. See AGENTS.md §Key conventions:
--     "Column-level partial-UPDATE GRANT (REVOKE-first on Supabase)".
--
--   No changes to meetings; meetings remain immutable in this slice.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- responded_at column
-- ----------------------------------------------------------------------------
alter table public.meeting_invitations
  add column responded_at timestamptz;

comment on column public.meeting_invitations.responded_at is
  'S-03: stamped by the respond endpoint when the invitee accepts or declines. Null while pending.';

-- ----------------------------------------------------------------------------
-- RLS UPDATE policy (one-shot, invitee-only, terminal target states)
--
-- USING `status = 'pending'` ensures already-responded rows are filtered out
-- (the API maps the resulting null from .maybeSingle() to 404). WITH CHECK
-- restricts the target status to ('accepted', 'declined') — a misbehaving
-- client cannot set status to 'expired' (reserved for S-04's cron writer,
-- which bypasses RLS) nor back to 'pending'.
-- ----------------------------------------------------------------------------
create policy meeting_invitations_update on public.meeting_invitations
  for update to authenticated
  using      (auth.uid() = invitee_id and status = 'pending')
  with check (auth.uid() = invitee_id and status in ('accepted', 'declined'));

-- ----------------------------------------------------------------------------
-- Column-level GRANT
--
-- The S-02 migration already ran `revoke update on public.meeting_invitations
-- from authenticated`. Per the friend_connections precedent, RLS WITH CHECK
-- validates the resulting row but not which columns were written; the
-- partial GRANT below is what actually pins the writeable surface to
-- (status, responded_at). Listing only `status` here would block the API's
-- two-field UPDATE with a permission-denied error.
-- ----------------------------------------------------------------------------
grant update (status, responded_at) on public.meeting_invitations to authenticated;
