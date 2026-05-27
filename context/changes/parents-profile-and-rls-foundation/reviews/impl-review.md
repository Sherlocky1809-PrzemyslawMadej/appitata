---
change_id: parents-profile-and-rls-foundation
reviewer: Claude Opus 4.7
reviewed_at: 2026-05-27
scope: full-plan
verdict: pass
phase_commits:
  - 9fdf527 # Phase 1: foundation migration + dev-loop tooling
  - 41ffbb4 # Phase 2: verification fixture + agent docs
  - 3cd2e04 # epilogue: SHA write-back + status flip
---

# F-01 implementation review

Full-plan conformance review against `context/changes/parents-profile-and-rls-foundation/plan.md`. Written inline during the session because the `/10x-impl-review` skill wasn't installed; preserved here as the durable artefact.

## Verdict: **PASS — ships exactly what the plan promised**

## Phase 1 conformance

| Contract item                                                                                                                                                       | Status | Notes                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parents` table shape (id FK + on delete cascade, email NOT NULL UNIQUE, phone UNIQUE, display_name, created_at, updated_at)                                        | ✓      | [supabase/migrations/20260526120000_parents_foundation.sql:9-16](../../../../supabase/migrations/20260526120000_parents_foundation.sql#L9-L16) — verbatim match |
| `is_connected` helper (`stable security definer`, locked `search_path`, body `select viewer = owner`, grant to `authenticated`)                                     | ✓      | [supabase/migrations/20260526120000_parents_foundation.sql:27-40](../../../../supabase/migrations/20260526120000_parents_foundation.sql#L27-L40)                |
| `handle_new_user` (`security definer`, locked `search_path`, `on conflict do nothing`, REVOKEd from public/anon/authenticated)                                      | ✓      | [supabase/migrations/20260526120000_parents_foundation.sql:45-59](../../../../supabase/migrations/20260526120000_parents_foundation.sql#L45-L59)                |
| `on_auth_user_created` trigger on `auth.users` AFTER INSERT                                                                                                         | ✓      | [supabase/migrations/20260526120000_parents_foundation.sql:61-63](../../../../supabase/migrations/20260526120000_parents_foundation.sql#L61-L63)                |
| RLS enabled; `parents_select` uses `is_connected(auth.uid(), id)`; `parents_update` is self-only; no INSERT/DELETE policy; grants `select, update` to authenticated | ✓      | [supabase/migrations/20260526120000_parents_foundation.sql:72-83](../../../../supabase/migrations/20260526120000_parents_foundation.sql#L72-L83)                |
| `createServerClient<Database>` with `@/db/database.types` import                                                                                                    | ✓      | [src/lib/supabase.ts:4](../../../../src/lib/supabase.ts#L4), [src/lib/supabase.ts:10](../../../../src/lib/supabase.ts#L10)                                      |
| npm scripts `db:reset` + `db:types`                                                                                                                                 | ✓      | [package.json:13-14](../../../../package.json#L13-L14)                                                                                                          |

## Phase 2 conformance

| Contract item                                                                                                                                                                                  | Status       | Notes                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seed inserts Alice + Bob into `auth.users` with fixed UUIDs `…0a01`/`…0b01`, `ON CONFLICT (id) DO NOTHING`, idempotent; trigger backfills `public.parents`                                     | ✓            | [supabase/seed.sql:12-22](../../../../supabase/seed.sql#L12-L22); count check 2.4 confirmed = 2                                                                                                                                               |
| Three SQL blocks in `parents-rls.md`, each in `begin; … rollback;`, Alice/Bob/cross with row-count expectations 1/1/0                                                                          | ✓            | [supabase/tests/parents-rls.md:14-44](../../../../supabase/tests/parents-rls.md#L14-L44); 2.5 confirmed in Studio                                                                                                                             |
| One-sentence rationale for `set local role` + `set local request.jwt.claims` pairing                                                                                                           | ✓ — exceeded | The blockquote at [supabase/tests/parents-rls.md:10](../../../../supabase/tests/parents-rls.md#L10) spells out the exact failure mode (claims null → `is_connected(null, id)` false → silent zero), which is stronger than the plan asked for |
| AGENTS.md §Commands names `db:reset`/`db:types` + Docker prereq                                                                                                                                | ✓            | [AGENTS.md:34-37](../../../../AGENTS.md#L34-L37)                                                                                                                                                                                              |
| AGENTS.md §Key conventions has RLS-template bullet after Supabase migrations bullet, with `using ( public.is_connected(auth.uid(), owner_column) )` example and cross-ref to canonical example | ✓            | [AGENTS.md:67](../../../../AGENTS.md#L67)                                                                                                                                                                                                     |
| AGENTS.md §Current state acknowledges `parents` exists; friends/meetings/invitations still TBD                                                                                                 | ✓            | [AGENTS.md:28](../../../../AGENTS.md#L28)                                                                                                                                                                                                     |

## "What we're NOT doing" sanity check — all 9 exclusions honoured

`friend_connections` not added; UI untouched; no anonymous-role grants; no `/api/parents/me` endpoint; signup handler + zod validation untouched; email confirmation still off; no `supabase db diff` in CI; no pgTAP; no remote DB push. ✓

## Adaptations beyond the plan (both pre-accepted by user, documented in change.md)

1. **`eslint.config.js` override block (Phase 1 / 9fdf527).** Added a `dbTypesConfig` exempting `src/db/database.types.ts` from three rules. Not in the plan, but load-bearing — every future `db:types` regeneration would re-break lint without it. Recorded in change.md Session 1 notes. **Defensible.**
2. **AGENTS.md Windows / CRLF note (Phase 2 / 41ffbb4).** Plan's §Commands contract was a single sentence about the DB workflow; the implementation added a second paragraph documenting the Windows lint posture. Carried-forward decision from Session 1; matches stored `feedback_windows_crlf_lint.md` memory; user reviewed the diff and confirmed clean. **Defensible.**

## Quality signals worth calling out

- **Hardening is consistent**: every `security definer` function has `set search_path = public, pg_temp`; `handle_new_user` is REVOKEd from all roles so it can only fire via the trigger; the trigger function uses `on conflict do nothing` for idempotency against seed re-runs.
- **Migration is forward-additive only** — drop order is documented in plan §Migration Notes; no rollback script needed.
- **Cascade safety**: `parents.id references auth.users(id) on delete cascade` means a Supabase-side user delete will clean up the `parents` row automatically. Important once account deletion is wired.
- **The verification doc's blockquote** is the kind of "non-obvious gotcha pinned to the artefact that catches it" that pays off the next time someone has to debug an apparently-passing RLS check.

## Minor observations (no action required)

- The migration writes `phone` directly from `new.phone` in the trigger, but the auth signup flow doesn't currently populate phone — so every parent will start with `phone = null`. Fine for F-01 (column is nullable + UNIQUE allows multiple NULLs in Postgres); flagging for when the friends-by-phone lookup slice (S-01) needs to write phone, that'll need either a profile-completion step or extending signup.
- `display_name` is similarly unpopulated — same comment.
- `supabase/snippets/` (carried-forward dirty path) is Studio's auto-saved query history. Worth a `.gitignore` entry in a follow-up housekeeping commit since it's now been carried forward across three sessions.

## Bottom line

F-01 is implementation-complete and plan-conformant. The privacy-boundary NFR (PRD §NFR) is now enforced at the database layer by the RLS policy that every later domain table will pattern-match against `is_connected`. Ready for `/10x-archive parents-profile-and-rls-foundation`.
