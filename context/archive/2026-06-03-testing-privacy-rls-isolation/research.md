---
date: 2026-06-03T00:00:00+02:00
researcher: Przemek
git_commit: 5681caa087786ab160467a503921eab6e5667bcc
branch: master
repository: 10x-lesson-project (AppiTata)
topic: "Test-runner bootstrap + privacy-boundary RLS isolation (test-plan §3 Phase 1, Risks #1 and #2-read-path)"
tags: [research, codebase, rls, privacy-boundary, supabase, vitest, integration-tests]
status: complete
last_updated: 2026-06-03
last_updated_by: Przemek
---

# Research: Test-runner bootstrap + privacy-boundary RLS isolation

**Date**: 2026-06-03T00:00:00+02:00
**Researcher**: Przemek
**Git Commit**: 5681caa087786ab160467a503921eab6e5667bcc
**Branch**: master
**Repository**: 10x-lesson-project (AppiTata)

## Research Question

This change is **§3 Phase 1** of `context/foundation/test-plan.md`: _Test-runner bootstrap + privacy-boundary RLS isolation_. Goal: stand up the project's first test runner on the highest risk and prove cross-circle reads return nothing. Risks covered: **#1** (a parent reads another circle's meetings or child details — a SELECT policy is wrong or bypassed) and the **read path of #2** (cross-table meeting/invitation visibility). Per the risks-to-verify brief (test-plan §2 Risk Response Guidance), research must ground three things:

1. The viewer/owner check each SELECT policy actually runs, and what "connected" resolves to.
2. The multi-parent fixture shape and the existing manual proofs to automate (without lifting the oracle).
3. How to stand up a test runner that can authenticate as two distinct parents against local Supabase.

This is a **QA spec grounding pass**, not a code audit. No test code is written here (that is `/10x-plan` → `/10x-implement`).

## Summary

**The read-path privacy boundary is enforced entirely at the DB by four RLS SELECT policies, all on `authenticated`.** "Connected" means **accepted-only** (`public.is_connected`), but there is one deliberate, load-bearing exception a test will trip on if naive: **`parents_select` ALSO exposes a parent you have a _pending_ friend-connection with.** Asserting "pending ⇒ invisible" against the `parents` table directly is therefore _wrong_ — pending invisibility only holds through `list_my_friends()` / the `is_connected` path, not a bare `SELECT FROM parents`. The meetings↔invitations pair avoids Postgres's infinite-recursion guard via two `SECURITY DEFINER` helpers; a test must run with RLS actually on (real local Supabase, two real authenticated identities) or it proves nothing.

**The cheapest layer that gives real signal is integration against local Supabase** (test-plan §2 agrees). Two viable identity techniques exist, and they test different things:

- **DB-level JWT-claims** (`set local request.jwt.claims`) — what every existing `supabase/tests/*-rls.md` proof uses. Exercises the _policies_ but bypasses PostgREST + the app's auth stack.
- **HTTP password login** (`signInWithPassword` via two anon-key supabase-js clients) — exercises the full path the app uses. **Blocked today** by one issue: the seed users have empty passwords.

**Two concrete blockers Phase 1 must own before a single assertion can run:**

1. **Seed users can't sign in.** `supabase/seed.sql` inserts Alice + Bob with `encrypted_password = ''`, so `signInWithPassword` is rejected. The fix is pre-documented (one `crypt(...)` line). Until then only the JWT-claims SQL path works.
2. **The fixture is incomplete for isolation tests.** Seed has two _accepted_-connected parents but **no unconnected third parent** and **no pending connection** — exactly the two rows the Risk #1 isolation matrix needs. Every existing proof inlines Carol + a pending FC per-block; Phase 1 should persist them in `seed.sql` instead.

A third, structural blocker: importing `src/lib/supabase.ts` from a plain Vitest run fails on the `astro:env/server` virtual module. **The escape is to not import it** — build a plain supabase-js client exactly like `src/lib/supabase-admin.ts` already does, reading keys from `process.env`.

## Detailed Findings

### Area 1 — RLS SELECT policies & the connection model (grounds Risk #1, Risk #2 read path)

All four domain-table SELECT policies apply to the `authenticated` role.

**`public.parents` → policy `parents_select`** (initial [20260526120000_parents_foundation.sql:74-76](supabase/migrations/20260526120000_parents_foundation.sql#L74-L76); extended [20260527103435_friend_connections_foundation.sql:111-123](supabase/migrations/20260527103435_friend_connections_foundation.sql#L111-L123)). Final USING:

```sql
public.is_connected(auth.uid(), public.parents.id)
or exists (
  select 1 from public.friend_connections fc
  where fc.status = 'pending'
    and ( (fc.requester_id = auth.uid() and fc.addressee_id = public.parents.id)
       or (fc.addressee_id = auth.uid() and fc.requester_id = public.parents.id) )
)
```

Plain English: a viewer reads a parent row if (1) connected (self or **accepted** FC), **OR (2) there is a _pending_ FC between them in either direction.** **This is the #1 test trap** ([20260527103435_friend_connections_foundation.sql:114-122](supabase/migrations/20260527103435_friend_connections_foundation.sql#L114-L122)). Note the explicit `public.parents.id` qualification — written that way precisely because a bare `id` would shadow to `fc.id` (see Historical Context #2).

**`public.friend_connections` → policy `friend_connections_select`** ([20260527103435_friend_connections_foundation.sql:48-50](supabase/migrations/20260527103435_friend_connections_foundation.sql#L48-L50)). USING: `auth.uid() = requester_id or auth.uid() = addressee_id`. Only the two parties see the row; no transitive visibility.

**`public.meetings` → policy `meetings_select`** ([20260528105428_meetings_foundation.sql:99-104](supabase/migrations/20260528105428_meetings_foundation.sql#L99-L104)). USING: `auth.uid() = creator_id or public.user_is_meeting_invitee(id, auth.uid())`. Creator OR anyone holding an invitation row (any status).

**`public.meeting_invitations` → policy `meeting_invitations_select`** ([20260528105428_meetings_foundation.sql:123-128](supabase/migrations/20260528105428_meetings_foundation.sql#L123-L128)). USING: `auth.uid() = invitee_id or public.user_is_meeting_creator(meeting_id, auth.uid())`. The invitee on the row OR the creator of the parent meeting.

**Connection helper — `public.is_connected(viewer, owner)`** (stub [20260526120000_parents_foundation.sql:27-35](supabase/migrations/20260526120000_parents_foundation.sql#L27-L35); full body [20260527103435_friend_connections_foundation.sql:83-101](supabase/migrations/20260527103435_friend_connections_foundation.sql#L83-L101)). SECURITY DEFINER, `search_path = public, pg_temp`. Returns true iff `viewer = owner` OR an **`accepted`** FC exists in either direction. **A `pending` FC does NOT make `is_connected` true** — the pending exposure lives only in the `parents_select` policy clause above.

**Recursion-breaking helpers** ([20260528105428_meetings_foundation.sql:48-57](supabase/migrations/20260528105428_meetings_foundation.sql#L48-L57) explains why):

- `public.user_is_meeting_invitee(p_meeting_id, p_user_id)` ([:58-70](supabase/migrations/20260528105428_meetings_foundation.sql#L58-L70)) — SECURITY DEFINER; true iff an invitation row exists for that (meeting, user), **no status filter**.
- `public.user_is_meeting_creator(p_meeting_id, p_user_id)` ([:77-89](supabase/migrations/20260528105428_meetings_foundation.sql#L77-L89)) — SECURITY DEFINER; true iff the user created that meeting.

Both bypass RLS during the lookup, breaking the `meetings_select` ↔ `meeting_invitations_select` cycle that would otherwise raise `infinite recursion detected in policy`.

**Accepted-only listing — `public.list_my_friends()`** ([20260527103435_friend_connections_foundation.sql:184-196](supabase/migrations/20260527103435_friend_connections_foundation.sql#L184-L196)). SECURITY DEFINER; returns `(id, display_name)` for accepted-connected parents (`is_connected` filter), excluding self. The in-migration comment ([:179-182](supabase/migrations/20260527103435_friend_connections_foundation.sql#L179-L182)) is explicit: this function exists _because_ `parents_select` leaks pending-FC parents, which would otherwise contaminate the friends list. **This is the canonical "use `list_my_friends()` not a bare SELECT" enforcement point** — a privacy-isolation test should treat the difference between the two as a behavioural assertion.

**Handle search — `public.find_parent_by_handle(text)`** (S-01 [20260527103435_friend_connections_foundation.sql:151-171](supabase/migrations/20260527103435_friend_connections_foundation.sql#L151-L171); phone-anchor refinement [20260528120000_find_parent_by_handle_anchor_phone.sql:10-30](supabase/migrations/20260528120000_find_parent_by_handle_anchor_phone.sql#L10-L30)). SECURITY DEFINER; matches any parent by exact email or `+E.164` phone, excluding the caller (`p.id <> auth.uid()`). Out of Phase 1's read-isolation scope but relevant: it is a deliberate RLS-bypass, so a test must not treat "found via handle" as a privacy leak.

### Area 2 — Existing manual proofs & fixture shape (the behavioural spec to automate)

Three manual proof docs, each a set of copy-paste `begin; … rollback;` SQL blocks for Supabase Studio:

- **[supabase/tests/parents-rls.md](supabase/tests/parents-rls.md)** — `parents_select` after F-01+S-01. The impersonation pattern ([:18-22](supabase/tests/parents-rls.md#L18-L22)): `set local role authenticated; set local request.jwt.claims to '{"sub":"<uuid>"}';`. Expected row counts encode isolation (Alice 2 / Bob 2 / cross 1). **Critical note ([:10-13](supabase/tests/parents-rls.md#L10-L13)): without the claims, `auth.uid()` is null, every branch is false, and the check _silently appears to pass_** — the single most important trap for an automated port.
- **[supabase/tests/friend-connections-rls.md](supabase/tests/friend-connections-rls.md)** — six blocks: bidirectional visibility ([:16-31](supabase/tests/friend-connections-rls.md#L16-L31)), outsider sees 0 ([:34-43](supabase/tests/friend-connections-rls.md#L34-L43)), `find_parent_by_handle` isolation ([:46-75](supabase/tests/friend-connections-rls.md#L46-L75)), column-GRANT enforcement ([:78-93](supabase/tests/friend-connections-rls.md#L78-L93)), and **pending-FC visibility in `parents_select`** ([:125-246](supabase/tests/friend-connections-rls.md#L125-L246)).
- **[supabase/tests/meetings-rls.md](supabase/tests/meetings-rls.md)** — thirteen blocks; for Phase 1 read-path the load-bearing one is **Block 2 ([:43-100](supabase/tests/meetings-rls.md#L43-L100)): creator sees 1, invitee sees 1, uninvolved Dave sees 0** — the cross-table isolation proof. The cross-table visibility note ([:103](supabase/tests/meetings-rls.md#L103)) confirms it routes through the SECURITY DEFINER helper.

**Fixture — [supabase/seed.sql](supabase/seed.sql)** seeds exactly two parents and one accepted FC:

- Alice `00000000-0000-0000-0000-000000000a01` / `alice@example.com` / `+48111111111`
- Bob `00000000-0000-0000-0000-000000000b01` / `bob@example.com` / `+48222222222`
- FC Alice→Bob `accepted` ([supabase/seed.sql:33-37](supabase/seed.sql#L33-L37))

**Gap for Risk #1 isolation matrix:**

| Requirement                      | Present? | Evidence                                              |
| -------------------------------- | -------- | ----------------------------------------------------- |
| Two accepted-connected parents   | ✓        | [supabase/seed.sql:33-37](supabase/seed.sql#L33-L37)  |
| Unconnected third parent (Carol) | ✗        | every proof inlines Carol per-block; not in seed      |
| A `pending` friend-connection    | ✗        | the seeded FC is `accepted`; no pending row persisted |

Phase 1 should persist Carol (`…c01`) + a pending FC so the permission matrix (connected / pending / unconnected) is a fixture, not inlined per test.

**Local stack config — [supabase/config.toml](supabase/config.toml):** API `54321` ([:10](supabase/config.toml#L10)), DB `54322` ([:29](supabase/config.toml#L29)), Studio `54323`, Inbucket `54324`. `enable_confirmations = false` ([:209](supabase/config.toml#L209)) so no email-confirm step. Seed enabled, path `./seed.sql` ([:62-65](supabase/config.toml#L62-L65)). anon/service_role keys are not in config — read via `npx supabase status`.

### Area 3 — Test-runner bootstrap feasibility

**No runner exists.** [package.json](package.json) scripts are `dev/build/preview/astro/lint/lint:fix/format/db:reset/db:types` — **no `test`** ([package.json:5-15](package.json#L5-L15)); no `vitest`/`jest`/`@testing-library`/`@playwright` in deps or devDeps. Relevant versions: `astro ^6.3.1`, `@astrojs/cloudflare ^13.5.0`, `@astrojs/react ^5.0.4`, `react ^19.2.6`, `@supabase/ssr ^0.10.3`, `@supabase/supabase-js ^2.99.1`, `zod ^4.4.3`. **`overrides.vite: "^7.3.2"`** ([package.json:61](package.json#L61)) pins Vite 7 → any Vitest must be **≥3.x** (Vite-7-compatible).

**The `astro:env/server` trap.** [src/lib/supabase.ts:3](src/lib/supabase.ts#L3) imports `{ SUPABASE_URL, SUPABASE_KEY } from "astro:env/server"` and builds a cookie-bound SSR client. A plain Vitest test importing this file fails — `astro:env/server` is a virtual module only resolvable inside the Astro/Vite build. **Escape: don't import it.** [src/lib/supabase-admin.ts:18-28](src/lib/supabase-admin.ts#L18-L28) already shows the pattern a test should copy — plain `@supabase/supabase-js` `createClient(url, key, …)` from a plain env object (explicitly _not_ `astro:env`, per its own comment [:11-12](src/lib/supabase-admin.ts#L11-L12)). A test builds its own clients the same way and reads keys from `process.env`. (If a test ever must import an Astro-coupled module, wrap the Vitest config in `getViteConfig` from `astro/config` to inherit virtual-module + `@/*` alias resolution — heavier, not needed for an HTTP-only integration test.)

**Authenticating as two parents — two paths:**

- **HTTP password login (recommended; exercises PostgREST + RLS like the app):** two anon-key clients each `signInWithPassword({email,password})` against `http://127.0.0.1:54321`, carrying distinct JWTs; a service_role client does fixture setup/teardown. **Blocked today** — seed passwords are empty (see below).
- **DB-level JWT-claims (works now; bypasses the app's HTTP/auth layer):** the `set local request.jwt.claims` technique the `*-rls.md` proofs already use; portable via `docker exec -i supabase_db_<project> psql` (the project's known local-SQL probe route).

**Seed-password blocker.** [supabase/seed.sql:15-27](supabase/seed.sql#L15-L27) inserts Alice/Bob with `encrypted_password = ''`. With `enable_confirmations=false` no confirm is needed, but the empty hash makes `signInWithPassword` fail. The fix is **pre-documented** in [context/archive/2026-05-29-meeting-accept-with-conflict-and-list/reviews/plan-review.md:39-40](context/archive/2026-05-29-meeting-accept-with-conflict-and-list/reviews/plan-review.md#L39-L40): append `update auth.users set encrypted_password = crypt('<const>', gen_salt('bf')) where id in (…);` (pgcrypto is pre-enabled locally). Note the ad-hoc `.verify-evidence/verify.mjs:26-27` scripts already assume password `test1234` — but that stamp is **not committed**, so those scripts only worked after a manual stamp. **Phase 1 must own this seed change.**

**Env wiring.** [.dev.vars](.dev.vars) (gitignored, present) holds working local values: `SUPABASE_URL=http://127.0.0.1:54321`, `SUPABASE_KEY=sb_publishable_…` (new-format anon-equivalent), `SUPABASE_SERVICE_ROLE_KEY=eyJ…` (the well-known `supabase-demo` JWT). [.env.example](.env.example) documents all three; service_role local value comes from `npx supabase status`. **No `.env.test`** exists. Vitest runs on plain Node — fine here, because the test talks to Supabase over HTTP and never boots `workerd`.

## Code References

- `supabase/migrations/20260526120000_parents_foundation.sql:27-35,74-76` — `is_connected` stub; initial `parents_select`
- `supabase/migrations/20260527103435_friend_connections_foundation.sql:48-50,83-101,111-123,151-171,184-196` — FC select policy; full `is_connected`; pending-widened `parents_select`; `find_parent_by_handle`; `list_my_friends`
- `supabase/migrations/20260528105428_meetings_foundation.sql:48-104,123-128` — recursion explainer; `user_is_meeting_invitee/creator`; `meetings_select`; `meeting_invitations_select`
- `supabase/migrations/20260528120000_find_parent_by_handle_anchor_phone.sql:10-30` — phone +E.164 anchor refinement
- `supabase/migrations/20260601120000_invitation_expiry_sweep.sql:56-59` — `meeting_invitations_update` USING with 24h freshness (out of read-path scope; context)
- `supabase/tests/parents-rls.md:10-13,18-22` — impersonation pattern + the silent-pass trap
- `supabase/tests/friend-connections-rls.md:34-43,125-246` — outsider-sees-0; pending visibility
- `supabase/tests/meetings-rls.md:43-100,103` — cross-table isolation (1/1/0) + SECURITY DEFINER note
- `supabase/seed.sql:15-37` — Alice/Bob fixture + empty passwords + accepted FC
- `supabase/config.toml:10,29,62-65,209` — ports, seed config, no-confirm
- `package.json:5-15,16-58,61` — no test runner; versions; Vite-7 pin
- `src/lib/supabase.ts:3` — `astro:env/server` import (the trap)
- `src/lib/supabase-admin.ts:11-12,18-28` — the plain-client pattern a test should copy
- `.dev.vars`, `.env.example` — local URL + publishable + service_role keys

## Architecture Insights

- **The privacy boundary is a DB invariant, not a UI one.** Every read-path control is an RLS policy on `authenticated`; UI filtering is downstream. A test that mocks the Supabase client proves nothing about Risk #1 — it must hit real local Supabase with RLS on (test-plan §2 anti-pattern: "asserting privacy via UI filtering"; "over-mocking the client so RLS never runs").
- **"Connected" has two faces by design.** `is_connected` = accepted-only; `parents_select` = accepted **OR pending**. The reconciliation point is `list_my_friends()`. Any isolation assertion must name which surface it queries — the same two parents yield different visibility through `parents` vs `list_my_friends()`.
- **The oracle problem is real here.** test-plan §2 forbids "lifting the expected result from the policy SQL." The `*-rls.md` row-count expectations (1/1/0) are the _behavioural_ spec; the assertion's truth must come from the scenario ("an unconnected parent sees zero"), not from re-deriving the USING clause.
- **`auth.uid() = null` silently passes.** The single highest-value guard for the automated suite: a test running without a real authenticated identity makes every policy branch false and looks like a pass. Both identity techniques must assert the identity is actually set before trusting a zero-row result.
- **No multi-statement transactions in supabase-js.** Cross-table atomic ops are SECURITY DEFINER RPCs (`create_meeting_with_invitations`) — relevant for Phase 2, noted so Phase 1 fixtures use the RPC or service_role inserts, not chained client calls.

## Historical Context (from prior changes)

- **Infinite-recursion in cross-table RLS** — [context/archive/2026-05-28-meeting-creation-and-invite/plan.md:75](context/archive/2026-05-28-meeting-creation-and-invite/plan.md#L75): bare mutual EXISTS triggered `infinite recursion detected in policy`; fixed with the two SECURITY DEFINER helpers. A test must confirm SELECTs on meetings/invitations _succeed_ (don't 500) for both creator and invitee — the recursion bug manifests as a failed SELECT, not a leak.
- **Alias shadowing in EXISTS** — [context/archive/2026-05-27-friend-connection-handshake/plan.md:66](context/archive/2026-05-27-friend-connection-handshake/plan.md#L66): a bare `id` inside the `parents_select` pending branch resolved to `fc.id`, returning 0 rows where 1 was expected; discovered during block-6a verification. Why the policy now writes `public.parents.id` explicitly.
- **Column-level UPDATE GRANT needs REVOKE-first** — [context/archive/2026-05-27-friend-connection-handshake/plan.md:63](context/archive/2026-05-27-friend-connection-handshake/plan.md#L63): Supabase pre-grants ALL to `authenticated`, so a bare column GRANT is additive and silently doesn't restrict; the test (block 4) "silently returned UPDATE 0 instead of erroring" until the REVOKE landed. (Write-path — Phase 2 territory, but the _silent-pass_ shape is the same trap as `auth.uid()=null`.)
- **Pending-FC TOCTOU race** — [context/archive/2026-05-27-friend-connection-handshake/reviews/impl-review.md](context/archive/2026-05-27-friend-connection-handshake/reviews/impl-review.md) F3: two reverse-direction requests can both pass `is_connected=false` and both INSERT; **triaged ACCEPTED-AS-RISK** (bounded, UI-only weirdness). A known-unmitigated gap — do _not_ write a Phase 1 test expecting it to be prevented.
- **Verification method across all slices** — manual `begin; … rollback;` SQL with `set local role authenticated; set local request.jwt.claims`; fixtures Alice/Bob + inline Carol/Dave; isolation proven by row counts (1/1/0). Phase 1 is the automation of exactly this.
- **Seed-password fix already specified** — [context/archive/2026-05-29-meeting-accept-with-conflict-and-list/reviews/plan-review.md:39-40](context/archive/2026-05-29-meeting-accept-with-conflict-and-list/reviews/plan-review.md#L39-L40).

## Related Research

- `context/foundation/test-plan.md` §2 (Risk #1/#2 rows + Risk Response Guidance), §3 Phase 1, §4 Stack, §6.2 / §6.5 cookbook stubs this phase fills.
- `context/foundation/lessons.md` — "24h expiry encoded in three layers" (Phase 3/expiry, not read-path) and the impl-review type-system lint lesson.
- Prior `research.md`/`plan.md` in the four archived domain slices (parents F-01, friend-connection S-01, meeting-creation S-02, expiry-cron S-04) cited inline above.

## Open Questions

These are decisions for `/10x-plan`, surfaced (not resolved) here:

1. **Identity technique for Phase 1** — HTTP `signInWithPassword` (full path, requires the seed-password fix) vs DB-level JWT-claims (works now, bypasses PostgREST). The test-plan's "exercise as two authenticated users" language and the cookbook §6.2/§6.5 intent lean toward HTTP; the JWT-claims path is the lower-effort fallback if the seed fix is deferred. Recommend HTTP + own the seed fix.
2. **Fixture extension scope** — persist Carol + a pending FC in `seed.sql` (shared, but mutates the global fixture other manual proofs read) vs per-test setup via a service_role client (isolated, more code). Persisting matches how the manual proofs are written.
3. **Vitest config surface** — minimal `process.env`-based config (no `getViteConfig`) for HTTP-only tests vs `getViteConfig` wrap for future tests that import Astro modules. Phase 1 needs only the former.
4. **Where keys come from in CI** — `.dev.vars` are local; the GitHub Actions integration job (gate wired "after Phase 1", test-plan §5) will need its own local-Supabase boot + key sourcing. Likely a Phase 1 or Phase 4 concern depending on how far this phase wires CI.
5. **`.env.test` vs reusing `.dev.vars`** — no `.env.test` exists; decide the canonical test env source.
