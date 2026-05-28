-- ----------------------------------------------------------------------------
-- find_parent_by_handle: anchor the phone branch to '+'-prefixed inputs.
--
-- Prior shape stripped everything but digits and '+', then matched p.phone =
-- phone_norm. A handle like '1234@example.com' normalised to '1234' and would
-- match any parent whose phone happens to be literally '1234'. Real parents
-- always have +E.164 phones (signup enforces the '+' prefix), but the function
-- itself did not require it — closing that hole here. (impl-review F4)
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
      or (starts_with(n.phone_norm, '+') and p.phone = n.phone_norm)
    )
  limit 1;
$$;

comment on function public.find_parent_by_handle(text) is
  'S-01 search RPC: returns at most one (id, display_name) for an exact email or +E.164 phone match, excluding the caller.';

grant execute on function public.find_parent_by_handle(text) to authenticated;
