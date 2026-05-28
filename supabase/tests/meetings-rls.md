# meetings + meeting_invitations RLS check (S-02)

Eight copy-pasteable SQL blocks that prove the meetings + meeting_invitations RLS surface — including the cross-table SELECT model and the atomic-create RPC's validation — holds end-to-end after S-02. Run each in Supabase Studio (`http://127.0.0.1:54323` → SQL editor) after `npm run db:reset`. Every block is wrapped in `begin; ... rollback;` so the local DB stays clean.

The seed fixture (`supabase/seed.sql`) provides one accepted FC between Alice and Bob:

- **Alice** — `00000000-0000-0000-0000-000000000a01`
- **Bob** — `00000000-0000-0000-0000-000000000b01`
- **Dave** (uninvolved UUID, no fixture row, no FC with Alice) — `00000000-0000-0000-0000-000000000d01`

> **`set local role` + `set local request.jwt.claims` pairing.** Same rule as `parents-rls.md` and `friend-connections-rls.md`: `set local role authenticated` switches the role so RLS applies; the claims line is what makes `auth.uid()` return the impersonated UUID. Both are required.

## 1. Creator-only INSERT on meetings

The WITH CHECK pins `auth.uid() = creator_id`. Alice can insert a row with her own UUID as creator; she cannot insert one impersonating Bob.

```sql
-- Alice inserts a meeting with herself as creator → 1 row
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  insert into public.meetings (creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  -- expect: INSERT 0 1
rollback;

-- Alice attempts to insert a meeting with Bob as creator → fails WITH CHECK
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  -- This must FAIL with: ERROR: new row violates row-level security policy
  insert into public.meetings (creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000b01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
rollback;
```

## 2. Cross-table SELECT visibility — meeting

After Alice creates a meeting + invites Bob, Alice sees the meeting (creator branch), Bob sees it (invitee branch via the EXISTS subquery on meeting_invitations), and Dave (uninvolved) sees nothing.

```sql
-- Alice's view: 1 row (creator branch)
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  select count(*) from public.meetings;
  -- expect: 1
rollback;

-- Bob's view: 1 row (invitee branch — meeting visible because he has an invitation)
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  select count(*) from public.meetings;
  -- expect: 1
rollback;

-- Dave's view: 0 rows (uninvolved)
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000d01"}';
  select count(*) from public.meetings;
  -- expect: 0
rollback;
```

A non-zero result from Dave's block means the `meetings_select` policy's EXISTS subquery is over-broad — likely the outer-table qualification (`mi.meeting_id = public.meetings.id`) was missed and the inner alias is shadowing.

## 3. Cross-table SELECT visibility — invitation

Same fixture as block 2. Alice sees the invitation (creator branch via EXISTS on meetings), Bob sees it (invitee branch), Dave sees nothing.

```sql
-- Alice's view: 1 row (creator branch)
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  select count(*) from public.meeting_invitations;
  -- expect: 1
rollback;

-- Bob's view: 1 row (invitee branch)
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  select count(*) from public.meeting_invitations;
  -- expect: 1
rollback;

-- Dave's view: 0 rows
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000111',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000d01"}';
  select count(*) from public.meeting_invitations;
  -- expect: 0
rollback;
```

## 4. RPC happy path — atomic create

Alice calls `create_meeting_with_invitations` with Bob's UUID; the RPC returns the new meeting_id, and verification queries inside the same transaction confirm both tables now have one row. The RPC call and the verification SELECTs must be **separate statements** (not folded into a single WITH...) because Postgres uses one snapshot per statement — sub-queries inside the same statement that called the RPC won't see the just-inserted rows.

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';

  -- Statement 1: run the RPC (returns the new meeting_id)
  select public.create_meeting_with_invitations(
    '2026-06-15 14:00+00'::timestamptz,
    60,
    'Test St 1',
    'Warsaw',
    '00-001',
    'PL',
    'co-care Saturday',
    array['00000000-0000-0000-0000-000000000b01'::uuid]
  ) as new_meeting_id;

  -- Statement 2: verify the meeting row exists (RLS lets Alice see her own meeting)
  select count(*) as meetings_count from public.meetings;
  -- expect: 1

  -- Statement 3: verify the invitation row exists with status='pending'
  select count(*) as invitations_count, status::text as invitation_status
    from public.meeting_invitations
    group by status;
  -- expect: invitations_count=1, invitation_status='pending'
rollback;
```

## 5. RPC rejects unconnected invitee

Alice calls the RPC with Dave's UUID (no FC). The foreach loop in the RPC body raises `'invitee not connected'` (errcode 42501); the transaction aborts and no rows are inserted in either table.

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';

  -- This must FAIL with: ERROR: invitee not connected (SQLSTATE 42501)
  select public.create_meeting_with_invitations(
    '2026-06-15 14:00+00'::timestamptz,
    60,
    'Test St 1',
    'Warsaw',
    '00-001',
    'PL',
    'co-care Saturday',
    array['00000000-0000-0000-0000-000000000d01'::uuid]
  );
rollback;
```

After running, verify outside any transaction that nothing was inserted: `select count(*) from public.meetings;` should still return 0.

## 6. RPC rejects empty invitee array

The cardinality guard fires before any insert.

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';

  -- This must FAIL with: ERROR: at least one invitee required (SQLSTATE 22023)
  select public.create_meeting_with_invitations(
    '2026-06-15 14:00+00'::timestamptz,
    60,
    'Test St 1',
    'Warsaw',
    '00-001',
    'PL',
    'co-care Saturday',
    array[]::uuid[]
  );
rollback;
```

## 7. Creator-only DELETE cascades to invitations

Alice creates a meeting + invites Bob, then DELETEs the meeting. The FK `meeting_invitations.meeting_id REFERENCES meetings(id) ON DELETE CASCADE` removes the invitation row automatically. Bob attempting the same DELETE affects 0 rows (USING fails silently).

```sql
-- Alice (creator) deletes her own meeting → 1 row deleted; cascade removes the invitation
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000222',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000222',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  delete from public.meetings where id = '00000000-0000-0000-0000-000000000222';
  -- expect: DELETE 1

  -- Reset role to bypass RLS for the cascade verification (cascade ran as table owner)
  reset role;
  select count(*) from public.meeting_invitations
   where meeting_id = '00000000-0000-0000-0000-000000000222';
  -- expect: 0  (cascade removed the invitation row)
rollback;

-- Bob (non-creator) attempts to delete Alice's meeting → 0 rows affected
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000222',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000222',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  delete from public.meetings where id = '00000000-0000-0000-0000-000000000222';
  -- expect: DELETE 0  (USING auth.uid() = creator_id filters Bob out silently)

  -- Confirm the meeting is still there
  reset role;
  select count(*) from public.meetings where id = '00000000-0000-0000-0000-000000000222';
  -- expect: 1
rollback;
```

## 8. No UPDATE on meetings (immutability invariant)

The migration ships no UPDATE policy AND `revokes update … from authenticated`. Any UPDATE attempt is rejected at the GRANT layer, regardless of whether the WHERE clause would match a row Alice owns.

> **Why "permission denied for table" rather than "for column".** Same as the friend_connections column-grant note: Postgres reports the missing privilege at the table level (with a `HINT:` suggesting the privilege), not as a column-level error. The semantics are clear — `authenticated` holds no UPDATE privilege on `public.meetings` at all.

```sql
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000333',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  -- This must FAIL with: ERROR: permission denied for table meetings
  update public.meetings
     set description = 'amended description'
   where id = '00000000-0000-0000-0000-000000000333';
rollback;
```

A successful UPDATE here means the REVOKE was missed and Supabase's default broad UPDATE grant is still in effect — stop and re-check the migration's grant section before shipping the API.
