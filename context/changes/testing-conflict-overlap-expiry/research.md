---
date: 2026-06-09T15:00:30+0200
researcher: Przemek
git_commit: aad67a38ac7a2c3d352115437b29365f5c3399ce
branch: master
repository: 10x-lesson-project
topic: "Conflict-overlap detection & 24h invitation-expiry logic — where the failures live and how to test them (test-plan Phase 3, Risks #3 & #5)"
tags: [research, codebase, testing, conflict-overlap, invitation-expiry, rls, vitest]
status: complete
last_updated: 2026-06-09
last_updated_by: Przemek
---

# Research: Conflict-overlap & 24h invitation-expiry logic (Phase 3, Risks #3 & #5)

**Date**: 2026-06-09T15:00:30+0200
**Researcher**: Przemek
**Git Commit**: aad67a38ac7a2c3d352115437b29365f5c3399ce
**Branch**: master
**Repository**: 10x-lesson-project

## Research Question

For test-plan **Phase 3 — "Conflict-overlap & 24h expiry logic"** (Risks #3 silent double-booking, #5 stale invitation never expires; test types: unit + integration), find **where these failures actually live in code** and **which seams can exercise them**, so `/10x-plan` can write targeted tests. Scope decisions for this research (user-confirmed):

- **Conflict math: test as-is.** Map where the overlap math lives and how to exercise it through existing seams. _No extraction recommendation requested._
- **Expiry: predicate + idempotency.** Focus on the expiry predicate, the sweep RPC's transactional/idempotency behaviour, and who may invoke it. The real Cron→Worker `scheduled()` trigger is **deploy-only and out of scope**.

## Summary

**Risk #3 (conflict overlap):** The entire algorithm is **inline in `src/pages/meetings.astro` frontmatter (lines 23–85)** — a half-open interval-overlap test `mStart < piEnd && mEnd > piStart`, computed once per page render from a single RLS-scoped `from("meetings").select(...)` query. It is **NOT** a pure importable function, **not** in `src/lib/`, **not** in any RPC, and **not** in the accept endpoint (the warning is advisory and never blocks accept). **There is no unit seam today** — the actual overlap line is only reachable by rendering the page. This is the one tension the plan must resolve (see [Open Questions](#open-questions)): the test plan §6.1 assumes "conflict-overlap math is the first pure-logic unit under test," but as-is it isn't pure or importable.

**Risk #5 (expiry):** Well-structured and very testable. The sweep RPC `expire_stale_invitations()` (`supabase/migrations/20260601120000_invitation_expiry_sweep.sql:24-40`) is `SECURITY DEFINER`, granted to **`service_role` only**, idempotent, returns a row count, and uses the predicate `status='pending' AND invited_at < now() - interval '24 hours'` (strict `<`). Expiry is enforced **twice**: lazily by the `meeting_invitations_update` RLS USING clause at accept-time (`invited_at > now() - 24h`), and materially by the sweep. All **three layers** (sweep RPC, RLS USING, `meetings.astro` read filter) agree on the timestamp column (`invited_at`) and boundary direction, per `lessons.md`. Integration tests can call the sweep via `serviceClient()` and assert the predicate, idempotency (second run → 0), and the lazy RLS block.

**Harness:** Phases 1 & 2 already built everything Phase 3 needs — Vitest (`fileParallelism: false`), `signInAs`/`serviceClient`/`anonClient`, the HTTP cookie-jar (`signInOverHttp`/`Jar`/`anonymousJar`), `globalSetup` (build-before-serve), seeded Alice/Bob/Carol/Dave, and the `create_meeting_with_invitations` fixture pattern with residual-row teardown. **No meetings/invitations are seeded** — they're built per-test via the RPC. One important gap: the RPC sets `invited_at = now()`, so **expiry fixtures must backdate `invited_at`** via a direct `serviceClient()` insert/update (see [Fixture techniques](#fixture-techniques-for-phase-3)).

## Detailed Findings

### A. Conflict-overlap detection (Risk #3)

**The algorithm — inline in the page frontmatter** ([src/pages/meetings.astro:71-85](src/pages/meetings.astro#L71-L85)):

```ts
conflictsByInvitationId = Object.fromEntries(
  pendingInvitations.map((pi) => {
    const piStart = new Date(pi.meeting.starts_at).getTime();
    const piEnd = endsAt(pi.meeting);
    const clashes = myScheduleForConflicts
      .filter((m) => m.id !== pi.meeting.id)
      .filter((m) => {
        const mStart = new Date(m.starts_at).getTime();
        const mEnd = endsAt(m);
        return mStart < piEnd && mEnd > piStart; // ← the overlap test
      })
      .map((m) => ({ id: m.id, starts_at: m.starts_at, duration_minutes: m.duration_minutes }));
    return [pi.invitation_id, clashes];
  }),
);
```

with the duration helper ([src/pages/meetings.astro:23-25](src/pages/meetings.astro#L23-L25)):

```ts
function endsAt(m: { starts_at: string; duration_minutes: number }): number {
  return new Date(m.starts_at).getTime() + m.duration_minutes * 60_000;
}
```

- **Duration model**: `meetings.duration_minutes int not null default 60 check (duration_minutes between 1 and 1440)` ([supabase/migrations/20260528105428_meetings_foundation.sql:18-19](supabase/migrations/20260528105428_meetings_foundation.sql#L18-L19)). There is **no `ends_at` column** — end time is derived at render as `starts_at + duration_minutes * 60_000`. The math always uses the row's real `duration_minutes`; the only magic number is the `60_000` minutes→ms factor. Zero-duration is impossible (CHECK ≥ 1), so degenerate empty intervals can't occur.
- **Timezone**: every value is reduced to a **UTC epoch-ms integer** via `new Date(iso).getTime()` before comparison, so the test is zone-correct _as long as_ `starts_at` carries an offset (which `timestamptz` serialization gives). **Test-worthy seam**: a naive (offset-less) datetime string would be parsed in the server's local zone — worth one defensive case. `"now"` is `Date.now()` ([meetings.astro:48](src/pages/meetings.astro#L48)). Display uses `toLocaleString()` ([PendingInvitationsList.tsx:14](src/components/meetings/PendingInvitationsList.tsx#L14)) — local zone, but cosmetic only, not part of the math.
- **Dataset** — a single query ([meetings.astro:34-40](src/pages/meetings.astro#L34-L40)) feeds everything, RLS-scoped by `meetings_select` (creator OR invitee). Two derived sets:
  - `myScheduleForConflicts` ([meetings.astro:60-63](src/pages/meetings.astro#L60-L63)) = "existing schedule": meetings where viewer is creator OR an **accepted** invitee.
  - `pendingInvitations` ([meetings.astro:52-58](src/pages/meetings.astro#L52-L58)) = "proposed": meetings where viewer has a **fresh pending** invitation (`invited_at` within 24h — see expiry).
  - **Nuance**: the "friend" whose conflicts are checked is always **the current viewer** computed in their own session — a self-conflict check for the logged-in user against their own pending invitations, _not_ a cross-user lookup.
- **Boundary semantics** (operators `mStart < piEnd && mEnd > piStart`, half-open `[start, end)`):
  - **Equal start** (`mStart === piStart`) → **CONFLICT**.
  - **Back-to-back / touching** (`mEnd === piStart`) → **NOT a conflict** (endpoints exclusive; adjacency allowed).
  - Good boundary test cases: equal start (clash), `mEnd === piStart` (no clash), 1-minute overlap (clash).
- **Seams** (the crux):
  - `endsAt` is a **module-local, non-exported** function declaration in the frontmatter; the overlap predicate is an **anonymous `.filter` callback**. Neither is importable. **No unit seam.**
  - `src/lib/` has **no** date/conflict helper — only `cn()` in [src/lib/utils.ts](src/lib/utils.ts). No `src/lib/services/`.
  - The React component **does not compute conflicts** — it renders the pre-computed prop. `[data-testid="conflict-warning"]` block at [PendingInvitationsList.tsx:80-94](src/components/meetings/PendingInvitationsList.tsx#L80-L94), text `"Heads up — this overlaps with:"`. Other testids: `pending-invitation`, `accept-button`, `decline-button`. → clean **DOM-assertion seam** for E2E/integration page render, and a **component-unit seam** that tests _display_ (not the math).
  - The accept endpoint does **no** conflict math ([respond.ts:41-51](src/pages/api/meetings/invitations/respond.ts#L41-L51)); the RPC does **no** conflict math ([meetings_foundation.sql:149-206](supabase/migrations/20260528105428_meetings_foundation.sql#L149-L206)). No API/DB seam for overlap.

### B. 24h invitation expiry (Risk #5)

**The sweep RPC** ([supabase/migrations/20260601120000_invitation_expiry_sweep.sql:24-40](supabase/migrations/20260601120000_invitation_expiry_sweep.sql#L24-L40)):

```sql
create or replace function public.expire_stale_invitations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  update public.meeting_invitations
     set status = 'expired'
   where status = 'pending'
     and invited_at < now() - interval '24 hours';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
```

1. **Predicate**: `status = 'pending' AND invited_at < now() - interval '24 hours'`. Timestamp column is **`invited_at`** (`timestamptz not null default now()`, [meetings_foundation.sql:37](supabase/migrations/20260528105428_meetings_foundation.sql#L37)) — _not_ `created_at`/`sent_at` (those don't exist on the table). Operator is **strict `<`** (a row exactly 24h old is NOT swept).
2. **Idempotency / atomicity / count**: only matches `status='pending'`, so a second run no-ops on already-expired rows. Single SQL `UPDATE` → atomic, no partial-sweep state. Returns `integer` row count (a no-op second run returns `0`). Deliberately does **not** stamp `responded_at` (comment at `:43`: _"expiry is not a user response. Idempotent."_) — so an expired invite has `responded_at = null` while accept/decline stamps it.
3. **Who may invoke** ([:48-49](supabase/migrations/20260601120000_invitation_expiry_sweep.sql#L48-L49)): `SECURITY DEFINER`; `revoke execute … from public, anon, authenticated; grant execute … to service_role`. **An authenticated test client cannot call it** — Phase 3 must invoke via `serviceClient()` (the `.env.test` `SUPABASE_SERVICE_ROLE_KEY`). Caller in prod is `src/worker.ts`'s `scheduled()` (out of scope, location only).
4. **RLS USING clause + the lazy-vs-swept interaction** ([:54-59](supabase/migrations/20260601120000_invitation_expiry_sweep.sql#L54-L59)):

   ```sql
   create policy meeting_invitations_update on public.meeting_invitations
     for update to authenticated
     using      (auth.uid() = invitee_id and status = 'pending' and invited_at > now() - interval '24 hours')
     with check (auth.uid() = invitee_id and status in ('accepted', 'declined'));
   ```

   One-shot `pending → accepted|declined` (client can't write `expired` or revert). The 24h boundary here is `>` (keep-if-fresh) — the inverse of the sweep's `<`. **Key behaviour**: accepting a >24h-old-but-not-yet-swept invitation is **blocked by RLS independently of the sweep** (the row is invisible to the update path). Expiry is therefore enforced lazily at accept-time even if the sweep never ran; the sweep is a backstop that _materializes_ the `expired` status for display. (This USING clause was tightened from the S-03 version at [20260529120000_meeting_invitations_respond.sql:35-38](supabase/migrations/20260529120000_meeting_invitations_respond.sql#L35-L38), which gated only on `status='pending'`.)

5. **Read filter** ([meetings.astro:48-58](src/pages/meetings.astro#L48-L58)): `const freshnessCutoff = now - 24 * 60 * 60 * 1000;` then keep pending invitations where `new Date(i.invited_at).getTime() > freshnessCutoff`. Same column (`invited_at`), same `>` direction as the RLS accept side.
6. **Three layers agree**: all use `invited_at`; the two user-facing layers use `> now()-24h`, the sweep uses `< now()-24h` (intentional inverses, per `lessons.md`). **Boundary edge to test**: all three use _strict_ comparisons, leaving the exact-24h instant in a measure-zero "limbo" — un-acceptable (RLS `>` fails), un-displayed (read `>` fails), un-swept (sweep `<` fails, stays `pending`). It **fails closed** (safe). A test at `invited_at = now() - exactly 24h` should expect: accept → 404/blocked, Pending → absent, sweep count → 0.
7. **Respond endpoint handling of stale** ([respond.ts:41-60](src/pages/api/meetings/invitations/respond.ts#L41-L60)): UPDATE filtered by `id` + `.eq("status","pending")` (app-level mirror of RLS), `.maybeSingle()`. A stale invite (swept-`expired` or lazily-`pending`) is filtered out by RLS → `data === null` → **HTTP 404 `{ error: "not found" }`**. No expiry-specific errcode mapping (expiry handled by row-invisibility, no exception raised). Other mapped statuses: 401 (no user), 400 (bad JSON/input), 500 (not configured / DB error).

### C. Existing test harness (reuse map)

- **Vitest** ([vitest.config.ts](vitest.config.ts)): `environment: "node"`, `include: ["tests/**/*.test.ts"]`, `globalSetup: ["./tests/setup/server.ts"]`, `testTimeout: 30_000`, `hookTimeout: 150_000`, **`fileParallelism: false`** (shared-DB fixture safety — a Phase 1 impl-review fix), `@` alias → `src`, `loadEnv` for `.env.test`. Scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.
- **`tests/helpers/supabase.ts`**: `signInAs(email, pw) → {client, userId}` (asserts session resolves, the silent-pass guard), `serviceClient()` (RLS bypass — fixtures/teardown/verification only), `anonClient()` (RLS on, `auth.uid()` null). Reads `.env.test`: `SUPABASE_URL` (`http://127.0.0.1:54321`), `SUPABASE_KEY` (anon/publishable), `SUPABASE_SERVICE_ROLE_KEY`.
- **`tests/helpers/http.ts`**: `signInOverHttp(email, pw) → Jar` (POSTs form creds, asserts `302 → /`, captures all `Set-Cookie` incl. chunked `sb-…-auth-token.0/.1`, throws on bad creds), `anonymousJar()`, `Jar` = `{ cookie, fetch, json, postJson }` (replays cookie + `Origin` header + `redirect:"manual"`). Base URL `TEST_BASE_URL` (default `http://localhost:4321`).
- **`tests/setup/server.ts`** (globalSetup): reuse-if-reachable → else `npm run build` then `npm run preview` (workerd, reads `.dev.vars`) → poll `GET /auth/signin` (real route, not TCP) up to 120s → teardown kills process tree (`taskkill /T /F` on win32) and verifies port freed. **Build-before-serve** is load-bearing (preview serves the last build).
- **Existing test files**: `tests/integration/{smoke,auth,parents-isolation,meetings-isolation}.test.ts` and `tests/integration/api/{harness.smoke,authz,validation}.test.ts`. `meetings-isolation.test.ts` and `authz.test.ts` are the closest fixture-pattern templates.

#### Fixture techniques for Phase 3

- **Seed** ([supabase/seed.sql](supabase/seed.sql)): Alice `…a01`, Bob `…b01` (accepted FC w/ Alice), Carol `…c01` (pending FC w/ Alice), Dave `…d01` (unconnected); all password `test1234`. **No meetings/invitations seeded** — built per-test.
- **Standard fixture build** (from `meetings-isolation.test.ts` / `authz.test.ts`): `signInAs(ALICE…)` → assert `userId === ALICE.id` → `client.rpc("create_meeting_with_invitations", {p_starts_at, p_duration_minutes, p_street, p_city, p_postal_code, p_country, p_description, p_invitee_ids:[BOB.id]})` returns the meeting UUID. Fetch the generated invitation id via `serviceClient().from("meeting_invitations").select("id").eq("meeting_id", …)`. Teardown in `afterAll`: `serviceClient().from("meetings").delete().eq("id", …)` (FK-cascades to invitations), then **assert zero residual rows** (loud-fail model).
- **⚠ Expiry-specific gap**: `create_meeting_with_invitations` always sets `invited_at = now()` — there is **no parameter to backdate it**. To test the expiry predicate / lazy-block, the fixture must set `invited_at` to a past time via `serviceClient()` — either a direct insert of the `meeting_invitations` row with an explicit `invited_at`, or create via RPC then `serviceClient().from("meeting_invitations").update({invited_at: <>24h ago>})`. This is the one new fixture move Phase 3 introduces; the plan should pick one approach and note that RLS does not apply to the service client.
- **Conflict-specific**: build two meetings for the same viewer with overlapping vs adjacent `starts_at`/`duration_minutes`; assert via the page-render seam (see Open Questions for why there's no unit seam).
- **DB types** ([src/db/database.types.ts](src/db/database.types.ts)) already include `meetings`, `meeting_invitations` (`responded_at`, `status`), the `meeting_invitation_status` enum (4 values + runtime `Constants`), and the `create_meeting_with_invitations` / `expire_stale_invitations` RPC signatures.

## Code References

- `src/pages/meetings.astro:23-25` — `endsAt()` duration helper (inline, not exported)
- `src/pages/meetings.astro:34-40` — the single RLS-scoped meetings query feeding all sections
- `src/pages/meetings.astro:48-58` — `now`, `freshnessCutoff`, pending-freshness read filter (`> now-24h`)
- `src/pages/meetings.astro:60-63` — `myScheduleForConflicts` (creator-OR-accepted)
- `src/pages/meetings.astro:71-85` — the conflict/overlap computation (`mStart < piEnd && mEnd > piStart`)
- `src/components/meetings/PendingInvitationsList.tsx:57,80-94` — conflict-warning render (`[data-testid="conflict-warning"]`, no math)
- `src/components/meetings/types.ts:11-34` — `MeetingRow`, `ClashingMeetingSummary` shapes
- `src/pages/api/meetings/invitations/respond.ts:41-60` — accept/decline; stale → 404 (no conflict math, no expiry errcode)
- `supabase/migrations/20260528105428_meetings_foundation.sql:18-19,37` — `starts_at`/`duration_minutes` CHECK, `invited_at` default now()
- `supabase/migrations/20260528105428_meetings_foundation.sql:149-206` — `create_meeting_with_invitations` RPC (no conflict math; no `invited_at` param)
- `supabase/migrations/20260601120000_invitation_expiry_sweep.sql:24-40` — `expire_stale_invitations()` sweep RPC + predicate
- `supabase/migrations/20260601120000_invitation_expiry_sweep.sql:48-49` — revoke/grant (service_role only)
- `supabase/migrations/20260601120000_invitation_expiry_sweep.sql:54-59` — tightened `meeting_invitations_update` RLS (lazy 24h block)
- `vitest.config.ts` — `fileParallelism:false`, globalSetup, timeouts
- `tests/helpers/supabase.ts` / `tests/helpers/http.ts` / `tests/setup/server.ts` — reusable harness
- `tests/integration/meetings-isolation.test.ts`, `tests/integration/api/authz.test.ts` — fixture-build + teardown templates

## Architecture Insights

- **Conflict detection is a presentation-layer concern by design** (S-03 decision): plain JS in the page frontmatter, computed once per render, advisory-only (accept is never blocked — the second click is consent). The cost of this choice for testing is that the math has no non-render seam.
- **Expiry is defense-in-depth across three layers** that must move together (`lessons.md`): the sweep materializes `expired`, but RLS lazily blocks stale accepts regardless of the sweep, and the read filter hides stale invites. The durable oracle for tests is the _behaviour_ (a >24h pending invite cannot be accepted and is swept to `expired`), not any single SQL clause.
- **errcode over message-string** remains the oracle convention (`lessons.md`); for expiry specifically there is no errcode path — the contract is the 404 row-invisibility, so assert HTTP status + DB side-effect (status flipped, `responded_at` still null after a sweep).
- **Silent-pass guards are non-negotiable**: assert `userId === expected` before any zero-row/deny assertion; pair every deny/absent case with a positive control (fresh invite accepts; non-overlapping time shows no warning).

## Historical Context (from prior changes)

- `context/archive/2026-05-29-meeting-accept-with-conflict-and-list/plan.md:58,74` — overlap predicate chosen as client-side JS `aStart < bEnd && aEnd > bStart`; `endsAt`/`meetingEndsAt` extracted _once_ to avoid drift between conflict and upcoming/past split; equal-start = overlap, back-to-back = no overlap, multi-clash map `Record<invitation_id, Clashing[]>`; warning informational, accept stays enabled. Known: O(P×M), revisit > ~500 meetings; `endsAt` returns `NaN` on malformed `starts_at` (acceptable — column is `NOT NULL timestamptz`).
- `context/archive/2026-06-01-invitation-expiry-cron-backstop/plan.md:69,71,197` + `reviews/impl-review.md` (F2/F3) — sweep predicate, tightened RLS USING, read filter; the three-layer coupling captured as the `/10x-lesson` now in `lessons.md`; exact-24h limbo noted as harmless; **Cron→`scheduled()` only exercisable on a real deploy** (local `@astrojs/cloudflare` v13.5 has no working `/cdn-cgi/handler/scheduled`; a throwaway `/__sweep-probe` route was used to verify the RPC on the local runtime). This is _why_ Phase 3 tests the RPC directly via `serviceClient()`, not the cron.
- `context/archive/2026-06-03-testing-privacy-rls-isolation/` (Phase 1) — bootstrapped Vitest; `signInAs`/`serviceClient`; silent-pass guard + negative control; impl-review fixes: `fileParallelism:false` (F1), capture+warn on teardown delete error (F2).
- `context/archive/2026-06-08-testing-api-authz-validation/` (Phase 2) — HTTP cookie-jar harness; build-before-serve + poll-real-route; errcode-over-message oracle; ORDER-DEPENDENT BLOCK annotation for shared-invitation chains; service-role-key-in-stderr scrubbing caution (test-plan §6.6).
- `supabase/tests/meetings-rls.md` — behavioural oracle for meetings/invitations RLS. Blocks 9–13 cover the S-03 accept contract (invitee accepts → 1 row + `responded_at`; non-invitee → 0; one-shot; can't write `expired`; column-grant). **No conflict-overlap and no expiry proof block exists yet** — Phase 3 should add an expiry behavioural proof doc (e.g. `supabase/tests/invitation-expiry.md`) as the oracle source, _not_ copied from the SQL.

## Related Research

- `context/archive/2026-06-08-testing-api-authz-validation/research.md` — §"DB-side test oracle" errcode→HTTP table (42501→403, 22023→400, 23514→400, 23505→422/409); the F1 message-string guard for `meetings/index.ts`.
- `context/archive/2026-06-03-testing-privacy-rls-isolation/research.md` — RLS isolation-matrix patterns and the silent-pass trap rationale.

## Open Questions

1. **Conflict math has no unit seam — RESOLVED (2026-06-09): extract the overlap predicate to a pure helper.** Test-plan §6.1 says "conflict-overlap math is the first pure-logic unit under test," and §2 Risk #3 lists "unit (overlap math) + one integration" as the cheapest layer — but the math is currently inline, non-exported `.astro` frontmatter (`meetings.astro:23-85`), reachable _only_ by rendering the page. Per test-plan §1 principle #3, research is ground truth where it disagrees with the plan. The earlier "test as-is" scoping was **reversed by the user**: `/10x-plan` should include a **small extraction** of the overlap predicate (and `endsAt`) into a pure, exported helper (e.g. `src/lib/conflicts.ts`) as a prerequisite, then unit-test that helper directly — honoring §6.1's "pure-logic unit" without the oracle/tautology trap. Constraints for the extraction: (i) keep `meetings.astro` behaviour identical — the frontmatter calls the new helper, the single drift-free `endsAt`/`meetingEndsAt` is preserved (S-03 decision, `2026-05-29-meeting-accept-with-conflict-and-list/plan.md:74`); (ii) it is a refactor, not a behaviour change — no new conflict rules, accept stays advisory; (iii) keep one integration/render check (the `[data-testid="conflict-warning"]` DOM, §2 "+ one integration") so the wiring from page → helper is proven, while the boundary cases (equal start, back-to-back, 1-min overlap, multi-clash) live in the fast unit test. The rejected alternatives (kept for the plan's record): **(b)** component-unit of `PendingInvitationsList` tests _display_ not the algorithm; **(c)** reproducing the predicate in a test helper risks the oracle/tautology trap §2 warns about. Note: this is a small code change inside a testing phase — `/10x-plan` should keep the refactor minimal and confined to making the existing math testable, not redesign conflict detection.
2. **Expiry fixture backdating approach.** `create_meeting_with_invitations` can't set `invited_at` in the past. Plan must choose: direct `serviceClient()` insert of a `meeting_invitations` row with explicit `invited_at`, vs RPC-then-`serviceClient().update({invited_at})`. The latter reuses the RPC's validation but needs a follow-up write; the former is one statement but bypasses the RPC's invitee-connection checks (fine for an expiry fixture, but note it).
3. **Where to record the expiry behavioural oracle.** No `supabase/tests/*expiry*.md` proof doc exists. Recommend Phase 3 author one as the source of expected behaviour (so test expectations aren't lifted from the sweep SQL).
4. **Naive-datetime defensive case for overlap** — low priority; `starts_at` is `timestamptz NOT NULL` so an offset-less string shouldn't occur in practice, but the comparison would silently misbehave if one did.
