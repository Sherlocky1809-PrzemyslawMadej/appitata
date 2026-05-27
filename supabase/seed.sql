-- ============================================================================
-- Verification fixture for F-01 + S-01:
--   - Two parents whose raw_user_meta_data carries display_name + phone, so
--     the S-01 handle_new_user trigger writes both columns non-null.
--   - One accepted friend_connection (Alice -> Bob) so the S-01 is_connected
--     extension and the parents-rls.md row counts are exercisable.
--
--   Alice:  00000000-0000-0000-0000-000000000a01  alice@example.com  +48111111111
--   Bob:    00000000-0000-0000-0000-000000000b01  bob@example.com    +48222222222
--
-- The on_auth_user_created trigger backfills public.parents from these rows.
-- Idempotent against repeated `supabase db reset` via ON CONFLICT … DO NOTHING.
-- ============================================================================

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'alice@example.com', '',
   now(), now(), now(), '{"provider":"email","providers":["email"]}',
   '{"display_name":"Alice","phone":"+48111111111"}'),
  ('00000000-0000-0000-0000-000000000b01', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bob@example.com', '',
   now(), now(), now(), '{"provider":"email","providers":["email"]}',
   '{"display_name":"Bob","phone":"+48222222222"}')
on conflict (id) do nothing;

-- S-01: one accepted FC between Alice and Bob so the RLS extension is
-- exercisable from a fresh `db:reset`. The on_auth_user_created trigger has
-- already materialised both parents rows above (AFTER INSERT FOR EACH ROW),
-- so the FK references resolve in this same SQL session.
insert into public.friend_connections (requester_id, addressee_id, status)
values
  ('00000000-0000-0000-0000-000000000a01',
   '00000000-0000-0000-0000-000000000b01',
   'accepted')
on conflict (requester_id, addressee_id) do nothing;
