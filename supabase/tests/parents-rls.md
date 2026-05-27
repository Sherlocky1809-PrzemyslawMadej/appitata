# F-01 parents RLS isolation check

Three copy-pasteable SQL blocks that prove the `parents_select` policy isolates parent rows end-to-end. Run each in Supabase Studio (`http://127.0.0.1:54323` → SQL editor) after `npm run db:reset`. Each block is wrapped in `begin; ... rollback;` so the local DB stays clean.

The fixture (`supabase/seed.sql`) inserts:

- **Alice** — `00000000-0000-0000-0000-000000000a01` / `alice@example.com`
- **Bob** — `00000000-0000-0000-0000-000000000b01` / `bob@example.com`

> **Why both `set local role` and `set local request.jwt.claims` are needed.** The SELECT policy is `using ( public.is_connected(auth.uid(), id) )`. `set local role authenticated` switches the role so RLS applies; `set local request.jwt.claims to '{"sub": "<uuid>"}'` is what makes `auth.uid()` return that UUID. Without the claims line `auth.uid()` is `null`, `is_connected(null, id)` returns false, and every row is filtered out — the check silently looks like it passed.

## 1. Alice's view — expect 1 row (Alice)

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  select id, email from public.parents;
rollback;
```

## 2. Bob's view — expect 1 row (Bob)

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000b01"}';
  select id, email from public.parents;
rollback;
```

## 3. Cross-isolation — expect 0 rows

Alice tries to read Bob's row directly:

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-000000000a01"}';
  select id, email
    from public.parents
   where id = '00000000-0000-0000-0000-000000000b01';
rollback;
```

A non-empty result here means RLS is broken — stop and investigate the `parents_select` policy and the `is_connected` helper before shipping anything else that depends on the privacy boundary.
