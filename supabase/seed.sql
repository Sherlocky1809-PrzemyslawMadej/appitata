-- ============================================================================
-- Verification + integration-test fixture (F-01 + S-01, extended in Phase 2 of
-- testing-privacy-rls-isolation):
--   - Four parents whose raw_user_meta_data carries display_name + phone, so
--     the S-01 handle_new_user trigger writes both columns non-null.
--   - One accepted friend_connection (Alice -> Bob)   → connected arm.
--   - One pending  friend_connection (Alice -> Carol)  → pending arm.
--   - Dave has no FC with Alice                        → unconnected arm.
--   - A constant bcrypt password stamped on all four so `signInWithPassword`
--     works from the Vitest integration suite (local-only test convenience).
--
--   Alice:  00000000-0000-0000-0000-000000000a01  alice@example.com  +48111111111
--   Bob:    00000000-0000-0000-0000-000000000b01  bob@example.com    +48222222222
--   Carol:  00000000-0000-0000-0000-000000000c01  carol@example.com  +48333333333
--   Dave:   00000000-0000-0000-0000-000000000d01  dave@example.com   +48444444444
--
-- The on_auth_user_created trigger backfills public.parents from these rows.
-- Idempotent against repeated `supabase db reset` via ON CONFLICT … DO NOTHING.
-- The password constant (`test1234`) is a LOCAL test fixture and never ships to
-- any deployed environment.
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
   '{"display_name":"Bob","phone":"+48222222222"}'),
  ('00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'carol@example.com', '',
   now(), now(), now(), '{"provider":"email","providers":["email"]}',
   '{"display_name":"Carol","phone":"+48333333333"}'),
  ('00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dave@example.com', '',
   now(), now(), now(), '{"provider":"email","providers":["email"]}',
   '{"display_name":"Dave","phone":"+48444444444"}')
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

-- Phase 2: one PENDING FC (Alice -> Carol) so the isolation suite can prove the
-- two-faces-of-connected behaviour — Carol is visible via `parents_select`'s
-- pending branch but is NOT returned by `list_my_friends()` (accepted-only).
insert into public.friend_connections (requester_id, addressee_id, status)
values
  ('00000000-0000-0000-0000-000000000a01',
   '00000000-0000-0000-0000-000000000c01',
   'pending')
on conflict (requester_id, addressee_id) do nothing;

-- Phase 2: stamp a constant bcrypt password on every seeded test identity so
-- the Vitest suite can `signInWithPassword` over the full HTTP + RLS path.
-- pgcrypto is pre-enabled on the local stack; re-stamping on each reset is
-- idempotent (a fresh salt every run is harmless). LOCAL FIXTURE ONLY.
--
-- The token columns must be coerced to '' (not left NULL): GoTrue's user-lookup
-- query scans these character columns into Go strings, and a NULL fails with
-- "Database error querying schema" at signInWithPassword time — even though a
-- service_role read (which bypasses GoTrue) is unaffected. The raw INSERT above
-- leaves them NULL, so this UPDATE backfills them alongside the password.
update auth.users
   set encrypted_password      = crypt('test1234', gen_salt('bf')),
       confirmation_token       = coalesce(confirmation_token, ''),
       recovery_token           = coalesce(recovery_token, ''),
       email_change             = coalesce(email_change, ''),
       email_change_token_new   = coalesce(email_change_token_new, ''),
       email_change_token_current = coalesce(email_change_token_current, ''),
       phone_change             = coalesce(phone_change, ''),
       phone_change_token       = coalesce(phone_change_token, ''),
       reauthentication_token   = coalesce(reauthentication_token, '')
 where id in ('00000000-0000-0000-0000-000000000a01',
              '00000000-0000-0000-0000-000000000b01',
              '00000000-0000-0000-0000-000000000c01',
              '00000000-0000-0000-0000-000000000d01');
