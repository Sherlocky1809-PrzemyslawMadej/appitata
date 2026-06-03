# meetings + meeting_invitations RLS check (S-02)

Eight copy-pasteable SQL blocks that prove the meetings + meeting_invitations RLS surface — including the cross-table SELECT model and the atomic-create RPC's validation — holds end-to-end after S-02. Run each in Supabase Studio (`http://127.0.0.1:54323` → SQL editor) after `npm run db:reset`. Every block is wrapped in `begin; ... rollback;` so the local DB stays clean.

The seed fixture (`supabase/seed.sql`) seeds four parents, an accepted FC (Alice → Bob), and a pending FC (Alice → Carol):

- **Alice** — `00000000-0000-0000-0000-000000000a01`
- **Bob** — `00000000-0000-0000-0000-000000000b01`
- **Dave** (seeded parent; **no** FC with Alice, holds no meetings/invitations) — `00000000-0000-0000-0000-000000000d01`

> **Phase 2 note (`testing-privacy-rls-isolation`).** Dave is now a seeded parent (was an inline-only UUID), but he still holds no meetings, no invitations, and no FC with Alice — so every cross-table count below is **unchanged** (creator 1 / invitee 1 / uninvolved 0), and the RPC's unconnected-invitee rejection (Block 5) still fires for Dave. Carol (pending FC with Alice) is irrelevant to the meetings surface and appears in no block here.

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

A non-zero result from Dave's block means the cross-table visibility helper is over-broad. The shipped policies route through `public.user_is_meeting_invitee(p_meeting_id, p_user_id)` (a SECURITY DEFINER helper) rather than an inline EXISTS — bare inline EXISTS would trip Postgres's infinite-recursion guard because `meetings_select` and `meeting_invitations_select` reference each other. If Dave returns 1, check that the helper's WHERE clause actually narrows on both `p_meeting_id` and `p_user_id` and isn't returning `true` for any (meeting, user) pair.

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

## 9. Invitee can accept a pending invitation (S-03 happy path)

Bob is invited to one of Alice's meetings. With S-03's `meeting_invitations_update` policy plus the `(status, responded_at)` column-level GRANT, Bob can flip the invitation from `pending` to `accepted` and the server-side `responded_at` stamp lands in the same UPDATE.

```sql
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000444',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (id, meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000901',
          '00000000-0000-0000-0000-000000000444',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  update public.meeting_invitations
     set status = 'accepted', responded_at = now()
   where id = '00000000-0000-0000-0000-000000000901';
  -- expect: UPDATE 1

  -- Verify the row reflects the transition and responded_at is non-null
  select status::text, responded_at is not null as has_stamp
    from public.meeting_invitations
    where id = '00000000-0000-0000-0000-000000000901';
  -- expect: status='accepted', has_stamp=t
rollback;
```

## 10. Non-invitee cannot accept someone else's invitation

Dave (no relation to Alice or Bob) attempts to flip Bob's pending invitation. USING `auth.uid() = invitee_id` filters the row out; the UPDATE matches 0 rows.

```sql
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000444',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (id, meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000901',
          '00000000-0000-0000-0000-000000000444',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000d01"}';
  update public.meeting_invitations
     set status = 'accepted', responded_at = now()
   where id = '00000000-0000-0000-0000-000000000901';
  -- expect: UPDATE 0
rollback;
```

A non-zero result here means USING is missing the `auth.uid() = invitee_id` clause — stop and re-check.

## 11. One-shot enforcement: cannot flip an already-accepted row

Bob already accepted his invitation. He then attempts to flip it to `declined`. USING `status = 'pending'` filters the now-`accepted` row out; the UPDATE matches 0 rows. The API maps this to 404 via `.maybeSingle()`.

```sql
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000444',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (id, meeting_id, invitee_id, status, responded_at)
  values ('00000000-0000-0000-0000-000000000901',
          '00000000-0000-0000-0000-000000000444',
          '00000000-0000-0000-0000-000000000b01',
          'accepted',
          now());

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  update public.meeting_invitations
     set status = 'declined', responded_at = now()
   where id = '00000000-0000-0000-0000-000000000901';
  -- expect: UPDATE 0
rollback;
```

A non-zero result here means USING is missing the `status = 'pending'` clause — the one-shot rule has been broken. Stop and re-check.

## 12. WITH CHECK rejects the 'expired' target status

Bob attempts to flip his pending invitation to `expired` (a status reserved for S-04's cron writer, which bypasses RLS). The WITH CHECK clause rejects the write at policy-evaluation time.

```sql
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000444',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (id, meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000901',
          '00000000-0000-0000-0000-000000000444',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  -- This must FAIL with: ERROR: new row violates row-level security policy for table "meeting_invitations"
  update public.meeting_invitations
     set status = 'expired', responded_at = now()
   where id = '00000000-0000-0000-0000-000000000901';
rollback;
```

A successful UPDATE here means WITH CHECK is missing the `status in ('accepted', 'declined')` clause — clients could now write any enum value. Stop and re-check.

## 13. Column-level GRANT blocks writes to non-granted columns

Bob attempts to UPDATE `invited_at` (not in the column-level GRANT). The GRANT layer rejects the write before RLS evaluates.

> **Why "permission denied for table" rather than "for column".** Same as blocks 8 and the friend_connections column-grant note: Postgres reports the missing privilege at the table level (with a `HINT:` suggesting the privilege), not as a column-level error. The semantics are clear — `authenticated` holds no UPDATE privilege on `invited_at`, only on `(status, responded_at)`.

```sql
begin;
  insert into public.meetings (id, creator_id, starts_at, street, city, postal_code, country, description)
  values ('00000000-0000-0000-0000-000000000444',
          '00000000-0000-0000-0000-000000000a01',
          '2026-06-15 14:00+00',
          'Test St 1', 'Warsaw', '00-001', 'PL',
          'co-care Saturday');
  insert into public.meeting_invitations (id, meeting_id, invitee_id)
  values ('00000000-0000-0000-0000-000000000901',
          '00000000-0000-0000-0000-000000000444',
          '00000000-0000-0000-0000-000000000b01');

  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  -- This must FAIL with: ERROR: permission denied for table meeting_invitations
  update public.meeting_invitations
     set invited_at = now()
   where id = '00000000-0000-0000-0000-000000000901';
rollback;
```

A successful UPDATE here means the column-level GRANT was overshot (e.g. `grant update on … to authenticated` instead of the partial `(status, responded_at)`). Stop and re-check the migration's grant section.
