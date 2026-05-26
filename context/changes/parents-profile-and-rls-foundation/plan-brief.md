# Parents Profile + RLS Foundation — Plan Brief

> Full plan: `context/changes/parents-profile-and-rls-foundation/plan.md`

## What & Why

Lay AppiTata's data foundation: a `public.parents` table 1:1 with `auth.users`, plus a reusable `is_connected(viewer, owner)` SQL helper that every later domain table's RLS policy will call. The privacy-boundary NFR — "a parent's data is visible only to friends they have explicitly connected with" — is enforced from this slice forward, in the database, not just in UI filtering.

## Starting Point

The repo has the Astro + Supabase auth scaffold (signup/signin/signout endpoints, SSR cookie sessions, protected-route middleware) but **zero domain data**: no `supabase/migrations/` directory, no `parents` table, no `src/db/`, no typed Supabase client. This is the project's first migration; every convention we set here propagates to S-01 through S-04.

## Desired End State

A new parent's `parents` row is materialised automatically when their `auth.users` row is created (atomic Postgres trigger). The `parents` table has RLS enabled and grants the `authenticated` role SELECT via `is_connected(auth.uid(), id)` and UPDATE only when `id = auth.uid()`. A documented SQL fixture proves that parent A cannot SELECT parent B's row — so the privacy NFR is verifiable end-to-end on the local Supabase Docker stack before any friend-connection slice ships.

## Key Decisions Made

| Decision               | Choice                                                                                           | Why (1 sentence)                                                                                             | Source |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------ |
| Provisioning mechanism | Postgres trigger on `auth.users` INSERT                                                          | Atomic — you can never have an `auth.users` row without a matching `parents` row, regardless of entry point. | Plan   |
| `parents` schema       | `id, email, phone, display_name, created_at, updated_at`                                         | S-01's email/phone search needs columns RLS can protect; bounded denormalisation from `auth.users`.          | Plan   |
| RLS pattern            | SECURITY DEFINER `is_connected(viewer, owner)` helper + one-liner per-table policies             | One place to evolve when `friend_connections` lands; every later table inherits semantics automatically.     | Plan   |
| Email confirmation     | Keep `enable_confirmations = false`                                                              | PRD doesn't require it; matches `mvp_weeks: 3` posture; trigger fires atomically at signup.                  | Plan   |
| Verification           | Seed fixture + manual SQL doc (`supabase/tests/parents-rls.md`)                                  | Real Postgres + real RLS, no test-runner overhead, trivially extended in S-01.                               | Plan   |
| DB types               | Generate now to `src/db/database.types.ts`, add `db:types` npm script, wire `<Database>` generic | Every later slice gets typed queries from day one; type drift surfaces at `npm run build`.                   | Plan   |
| Dev loop               | Add `db:reset` + `db:types` npm scripts; document in AGENTS.md; no CI changes                    | Single canonical commands future agents reach for; documented in the file agents read first.                 | Plan   |

## Scope

**In scope:**

- One atomic migration: `parents` table + `is_connected` helper (stub body) + RLS policies + `auth.users` trigger
- Generated `src/db/database.types.ts` + typed `createServerClient<Database>` in `src/lib/supabase.ts`
- `npm run db:reset` and `npm run db:types` scripts in `package.json`
- `supabase/seed.sql` with two fixture parents
- `supabase/tests/parents-rls.md` with the manual RLS verification SQL
- AGENTS.md updates: §Commands, §Key conventions (RLS template), §Current state

**Out of scope:**

- `friend_connections` table (S-01)
- Any UI — no profile page, no friends-list, no new shadcn components
- Anonymous-role policies (none of the MVP is public)
- `/api/parents/*` endpoints (UPDATE policy verified by manual SQL only)
- Changes to the signup handler / adding `zod` there (known baseline gap, separate work)
- Enabling email confirmation
- Pushing the migration to a remote Supabase project
- `supabase db diff` in CI; pgTAP test framework

## Architecture / Approach

```
                                  ┌──────────────────────────────────┐
  signup.ts → supabase.auth.signUp │  auth.users (INSERT)             │
                                  └─────────────────┬────────────────┘
                                                    │ trigger
                                                    ▼
                                  ┌──────────────────────────────────┐
                                  │  public.parents (1:1 row)        │
                                  │  RLS:                            │
                                  │    SELECT via is_connected()     │
                                  │    UPDATE only when id=auth.uid()│
                                  └──────────────────────────────────┘

  public.is_connected(viewer, owner) returns boolean
    F-01 body: select viewer = owner
    S-01 body: viewer = owner OR exists(friend_connections accepted)
    Every later domain table calls this in its SELECT policy.
```

One atomic migration ships all four pieces (table, helper, policies, trigger). RLS-without-policies would leave the table fully invisible to `authenticated`; splitting would create a half-locked intermediate state. The helper is the single seam future slices extend; nothing else about RLS changes.

## Phases at a Glance

| Phase                                      | What it delivers                                                                                                                         | Key risk                                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Foundation migration + dev-loop tooling | The atomic migration; `db:reset` / `db:types` npm scripts; generated types; typed Supabase client; signup → parents row works end-to-end | SECURITY DEFINER hardening (locked `search_path`) and trigger-function grant revocation — easy to forget, security-relevant                      |
| 2. Verification fixture + agent docs       | `supabase/seed.sql` with two parents; `supabase/tests/parents-rls.md`; AGENTS.md updates                                                 | Future agents skipping the manual SQL check — mitigated by surfacing the test in a `supabase/tests/` directory and referencing it from AGENTS.md |

**Prerequisites:** Docker running locally (Supabase CLI dependency, already documented in AGENTS.md); `@supabase/ssr` and `@supabase/supabase-js` already installed.
**Estimated effort:** One focused session (~2-3h) for both phases combined — single migration, no UI, mostly SQL + tooling.

## Open Risks & Assumptions

- **RLS template is provisional until S-01 ships.** The `is_connected` body is a stub returning `viewer = owner`. The full privacy semantics ("self + connected friends") aren't observable until S-01 extends the function body. Acceptable because the function _shape_ is committed.
- **Seed-fixture inserts into `auth.users` directly.** This is a non-standard pattern (the official "create user" path is `auth.admin.createUser`), but inserting directly is what Supabase docs show for SQL-only seeds. The inserted users have no usable password — they're impersonation targets for the SQL check, not sign-in test accounts.
- **Manual verification step requires discipline.** The 1/1/0 check is run by a human in Studio, not by CI. Documented prominently in `supabase/tests/parents-rls.md` and surfaced in the plan's Manual Verification checklist.

## Success Criteria (Summary)

- After `npm run db:reset`, signing up via `/auth/signup` creates a matching `public.parents` row atomically.
- Two seeded fixture parents exist after `db:reset`, and the documented SQL check produces 1/1/0 row counts — proving parent A cannot see parent B's row through the `authenticated` role.
- `npm run build` passes with `createServerClient<Database>` consuming the generated types — future slices get typed queries for free.
