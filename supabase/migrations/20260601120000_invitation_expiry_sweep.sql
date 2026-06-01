-- ============================================================================
-- S-04: invitation expiry cron backstop — DB foundation.
--
--   - public.expire_stale_invitations(): SECURITY DEFINER sweep that flips every
--     pending invitation older than 24h to 'expired'. Cron-only — execute is
--     revoked from public/anon/authenticated and granted to service_role, the
--     role the Cloudflare scheduled() handler authenticates as. Idempotent:
--     a second run over the same data expires nothing and returns 0.
--
--   - Tightened meeting_invitations_update RLS policy: the S-03 policy gated
--     accept/decline on `status = 'pending'` only, so a stale-but-unswept invite
--     was still acceptable in the window before the cron ran. Adding
--     `invited_at > now() - interval '24 hours'` to the USING clause closes that
--     hole — a stale row is invisible to the update path, so respond.ts's
--     .maybeSingle() returns null and the existing 404 mapping covers it with no
--     endpoint change. WITH CHECK is unchanged (terminal states accepted/declined).
--
--   No changes to meetings or to the create/list RPCs.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Sweep function (cron-only, SECURITY DEFINER, idempotent)
-- ----------------------------------------------------------------------------
create or replace function public.expire_stale_invitations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.meeting_invitations
     set status = 'expired'
   where status = 'pending'
     and invited_at < now() - interval '24 hours';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.expire_stale_invitations() is
  'S-04: cron-only sweep. Flips pending invitations older than 24h to expired and returns the count. SECURITY DEFINER so it bypasses RLS for the cross-user sweep; execute granted to service_role only (the role the Cloudflare scheduled handler uses). Does not stamp responded_at — expiry is not a user response. Idempotent.';

-- Postgres grants EXECUTE on new functions to PUBLIC by default. Revoke that
-- broad grant and hand execute to service_role only, so neither anonymous nor
-- authenticated clients can trigger the sweep.
revoke execute on function public.expire_stale_invitations() from public, anon, authenticated;
grant execute on function public.expire_stale_invitations() to service_role;

-- ----------------------------------------------------------------------------
-- Tighten the accept/decline RLS policy with a 24h freshness predicate
-- ----------------------------------------------------------------------------
drop policy meeting_invitations_update on public.meeting_invitations;

create policy meeting_invitations_update on public.meeting_invitations
  for update to authenticated
  using      (auth.uid() = invitee_id and status = 'pending' and invited_at > now() - interval '24 hours')
  with check (auth.uid() = invitee_id and status in ('accepted', 'declined'));
