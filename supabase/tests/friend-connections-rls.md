# friend_connections RLS check (S-01)

Six copy-pasteable SQL blocks that prove the `friend_connections` RLS surface holds end-to-end after S-01. Run each in Supabase Studio (`http://127.0.0.1:54323` → SQL editor) after `npm run db:reset`. Each block is wrapped in `begin; ... rollback;` so the local DB stays clean.

The seed fixture (`supabase/seed.sql`) now seeds four parents, one accepted FC (Alice → Bob), and one pending FC (Alice → Carol):

- **Alice** — `00000000-0000-0000-0000-000000000a01`
- **Bob** — `00000000-0000-0000-0000-000000000b01`
- **Carol** (seeded parent; pending FC with Alice) — `00000000-0000-0000-0000-000000000c01`
- **Dave** (seeded parent; **no** FC with anyone — the true outsider) — `00000000-0000-0000-0000-000000000d01`

> **What changed in Phase 2 of `testing-privacy-rls-isolation`.** Carol and Dave are now seeded parents and the Alice → Carol pending FC is part of the seed. Two consequences below: Alice's FC count (Block 1) moves 1 → 2 (accepted Bob + pending Carol), and the "outsider sees 0 FC" check (Block 2) **must impersonate Dave** — Carol is no longer uninvolved, since she is the addressee of Alice's pending FC.

Blocks 5 and 6 still INSERT Carol + the pending Alice → Carol FC inline; those inserts are now idempotent no-ops against the seed (`on conflict … do nothing`), so the blocks behave identically whether or not the seed already provided them.

> **`set local role` + `set local request.jwt.claims` pairing.** Same rule as `parents-rls.md`: `set local role authenticated` switches the role so RLS applies; the claims line is what makes `auth.uid()` return the impersonated UUID. Both are required.

## 1. Both sides see their FC rows — expect Alice 2, Bob 1

Alice is party to two FCs (accepted Bob + pending Carol); Bob to one (accepted Alice).

```sql
-- Alice → expect 2 rows (accepted Alice→Bob + pending Alice→Carol)
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  select id, requester_id, addressee_id, status from public.friend_connections;
rollback;

-- Bob → expect 1 row (accepted Alice→Bob)
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  select id, requester_id, addressee_id, status from public.friend_connections;
rollback;
```

## 2. Outsider blindness — expect 0 rows

A parent uninvolved in any FC sees nothing. **Dave** (`…d01`) is the true outsider now that Carol is the addressee of Alice's pending FC:

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000d01"}';
  select id, requester_id, addressee_id, status from public.friend_connections;
rollback;
```

## 3. find_parent_by_handle — match / self / nonexistent

```sql
-- Alice searches for Bob's email → 1 row
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  select * from public.find_parent_by_handle('bob@example.com');
rollback;

-- Alice searches for her own email → 0 rows (silent self-exclusion)
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  select * from public.find_parent_by_handle('alice@example.com');
rollback;

-- Alice searches for a non-existent handle → 0 rows
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  select * from public.find_parent_by_handle('nobody@example.com');
rollback;

-- Alice searches for Bob's phone with friendly formatting → 1 row (normalisation strips spaces)
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  select * from public.find_parent_by_handle('+48 222 222 222');
rollback;
```

## 4. Column-level write isolation — only `status` is mutable

The migration's `revoke update … from authenticated` + `grant update (status) … to authenticated` pair means UPDATEs targeting any column other than `status` are rejected at parse time, regardless of which rows the WHERE clause would match.

> **Why "permission denied for table" rather than "for column".** Postgres reports a partial-column-grant violation as `ERROR: permission denied for table <name>` (with a `HINT:` suggesting the missing privilege), not "permission denied for column". The semantics are identical — `authenticated` does not hold the table-level UPDATE privilege, only the column-level `UPDATE(status)` — but the error text is at the table level. Don't be misled by the wording: the column GRANT _is_ enforcing.

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  -- This must FAIL with: ERROR: permission denied for table friend_connections
  update public.friend_connections
     set requester_id = '00000000-0000-0000-0000-000000000c01'
   where addressee_id = '00000000-0000-0000-0000-000000000b01';
rollback;
```

For completeness, confirm the legitimate path still works — impersonate Bob with a pending FC he's the addressee of and flip its status:

```sql
begin;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000c01',
          '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'carol@example.com', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}',
          '{"display_name":"Carol","phone":"+48333333333"}')
  on conflict (id) do nothing;
  insert into public.friend_connections (requester_id, addressee_id, status)
  values ('00000000-0000-0000-0000-000000000c01',
          '00000000-0000-0000-0000-000000000b01',
          'pending')
  on conflict (requester_id, addressee_id) do nothing;

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  update public.friend_connections
     set status = 'accepted'
   where requester_id = '00000000-0000-0000-0000-000000000c01'
     and addressee_id = '00000000-0000-0000-0000-000000000b01';
  -- expect: UPDATE 1  (column GRANT allows `status`, RLS USING + WITH CHECK both pass)
rollback;
```

## 5. Pending-state UPDATE policy — addressee can accept; outsider can't

Build a pending FC inline (Alice → Carol), then test the UPDATE policy from both Carol's and Dave's POVs:

```sql
-- First, materialise Carol as an auth.users + parents row (trigger fires) and a pending FC from Alice.
begin;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000c01',
          '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'carol@example.com', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}',
          '{"display_name":"Carol","phone":"+48333333333"}')
  on conflict (id) do nothing;

  insert into public.friend_connections (requester_id, addressee_id, status)
  values ('00000000-0000-0000-0000-000000000a01',
          '00000000-0000-0000-0000-000000000c01',
          'pending')
  on conflict (requester_id, addressee_id) do nothing;

  -- Carol (addressee) accepts: 1 row affected
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000c01"}';
  update public.friend_connections
     set status = 'accepted'
   where requester_id = '00000000-0000-0000-0000-000000000a01'
     and addressee_id = '00000000-0000-0000-0000-000000000c01';
  -- expect: UPDATE 1
rollback;

-- And the outsider variant: Dave can't accept on Carol's behalf
begin;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000c01',
          '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'carol@example.com', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}',
          '{"display_name":"Carol","phone":"+48333333333"}')
  on conflict (id) do nothing;

  insert into public.friend_connections (requester_id, addressee_id, status)
  values ('00000000-0000-0000-0000-000000000a01',
          '00000000-0000-0000-0000-000000000c01',
          'pending')
  on conflict (requester_id, addressee_id) do nothing;

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000d01"}';
  update public.friend_connections
     set status = 'accepted'
   where requester_id = '00000000-0000-0000-0000-000000000a01'
     and addressee_id = '00000000-0000-0000-0000-000000000c01';
  -- expect: UPDATE 0  (USING clause filters Dave out, no row visible to update)
rollback;
```

## 6. Pending-FC widens parents_select correctly

With a pending FC between Alice and Carol, Carol must be able to SELECT Alice's `parents` row even though they aren't accepted-connected — that's what makes the Phase 3 Incoming list renderable. Conversely, an uninvolved outsider (Dave) must NOT see Alice's row.

```sql
-- Carol can see Alice via the pending FC
begin;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000c01',
          '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'carol@example.com', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}',
          '{"display_name":"Carol","phone":"+48333333333"}')
  on conflict (id) do nothing;

  insert into public.friend_connections (requester_id, addressee_id, status)
  values ('00000000-0000-0000-0000-000000000a01',
          '00000000-0000-0000-0000-000000000c01',
          'pending')
  on conflict (requester_id, addressee_id) do nothing;

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000c01"}';
  select id, email, display_name
    from public.parents
   where id = '00000000-0000-0000-0000-000000000a01';
  -- expect: 1 row (Alice)
rollback;

-- Dave, uninvolved, cannot
begin;
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000c01',
          '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'carol@example.com', '',
          now(), now(), now(),
          '{"provider":"email","providers":["email"]}',
          '{"display_name":"Carol","phone":"+48333333333"}')
  on conflict (id) do nothing;

  insert into public.friend_connections (requester_id, addressee_id, status)
  values ('00000000-0000-0000-0000-000000000a01',
          '00000000-0000-0000-0000-000000000c01',
          'pending')
  on conflict (requester_id, addressee_id) do nothing;

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000d01"}';
  select id, email, display_name
    from public.parents
   where id = '00000000-0000-0000-0000-000000000a01';
  -- expect: 0 rows
rollback;
```

A non-empty result from Dave's block means the pending-OR branch of `parents_select` is over-broad — stop and re-check the subquery's `auth.uid()` conditions before shipping the friends UI.
