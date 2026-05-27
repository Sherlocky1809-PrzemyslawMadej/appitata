-- ============================================================================
-- F-01 verification fixture: two parents for the manual RLS isolation check
-- documented in supabase/tests/parents-rls.md.
--
--   Alice:  00000000-0000-0000-0000-000000000a01  alice@example.com
--   Bob:    00000000-0000-0000-0000-000000000b01  bob@example.com
--
-- The on_auth_user_created trigger backfills public.parents from these rows.
-- Idempotent against repeated `supabase db reset` via ON CONFLICT (id) DO NOTHING.
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
