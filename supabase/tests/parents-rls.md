# parents RLS check (F-01 baseline + S-01 extension)

Three copy-pasteable SQL blocks that prove the `parents_select` policy behaves correctly after both F-01 and S-01 have landed. Run each in Supabase Studio (`http://127.0.0.1:54323` → SQL editor) after `npm run db:reset`. Each block is wrapped in `begin; ... rollback;` so the local DB stays clean.

The fixture (`supabase/seed.sql`) inserts two parents plus one accepted friend_connection from Alice to Bob:

- **Alice** — `00000000-0000-0000-0000-000000000a01` / `alice@example.com`
- **Bob** — `00000000-0000-0000-0000-000000000b01` / `bob@example.com`
- **FC** — Alice → Bob, status: `accepted`

> **What changed in S-01.** F-01 shipped this doc with expectations 1 / 1 / 0 — each parent saw only themselves, the cross-check returned zero. S-01 extends `is_connected(viewer, owner)` to also return true for accepted FCs in either direction, so Alice and Bob now mutually appear in each other's view. The numbers below (2 / 2 / 1) reflect the desired behaviour after S-01, not a regression. The third block was renamed from "Cross-isolation" to "Mutual visibility through the connection" because that's what it now proves.

> **Why both `set local role` and `set local request.jwt.claims` are needed.** The SELECT policy is `using ( public.is_connected(auth.uid(), id) OR <pending-FC branch> )`. `set local role authenticated` switches the role so RLS applies; `set local request.jwt.claims to '{"sub": "<uuid>"}'` is what makes `auth.uid()` return that UUID. Without the claims line `auth.uid()` is `null`, every policy branch returns false, and every row is filtered out — the check silently looks like it passed.

## 1. Alice's view — expect 2 rows (Alice + Bob)

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  select id, email from public.parents order by email;
rollback;
```

## 2. Bob's view — expect 2 rows (Alice + Bob)

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  select id, email from public.parents order by email;
rollback;
```

## 3. Mutual visibility through the connection — expect 1 row (Bob)

Alice reads Bob's row by id, and the accepted FC between them is what makes it visible:

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  select id, email
    from public.parents
   where id = '00000000-0000-0000-0000-000000000b01';
rollback;
```

An empty result here means the S-01 `is_connected` extension is broken — stop and investigate the function body and the `parents_select` policy before shipping anything else that depends on the connected-friends visibility.
