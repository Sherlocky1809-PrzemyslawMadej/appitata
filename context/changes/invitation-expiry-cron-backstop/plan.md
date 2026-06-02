# 24h Invitation Expiry Cron Backstop — Implementation Plan

## Overview

Harden FR-008 ("an unanswered invitation expires automatically after 24 hours") so it holds for **every** invitation — including ones no parent ever opens. A daily Cloudflare Cron Trigger sweeps stale `pending` invitations to `expired` via a `SECURITY DEFINER` RPC, and the read/accept paths enforce the same 24h cutoff directly so a stale invitation is never shown or accepted in the window between sweeps.

This is roadmap slice **S-04** (`invitation-expiry-cron-backstop`), the only post-north-star slice. It closes the "lazy-expiry leak" recorded in [infrastructure.md §Risk Register](../../foundation/infrastructure.md).

## Current State Analysis

- The `meeting_invitation_status` enum already carries `expired` from S-02 ([20260528105428_meetings_foundation.sql:12](../../../supabase/migrations/20260528105428_meetings_foundation.sql#L12)). **Nothing writes it today.**
- `meeting_invitations.invited_at` (`timestamptz not null default now()`) is the basis for the 24h window ([meetings_foundation.sql:37](../../../supabase/migrations/20260528105428_meetings_foundation.sql#L37)).
- **"Lazy expiry on read" was never actually implemented**, despite AGENTS.md and the roadmap implying S-03 did it:
  - [meetings.astro:50-53](../../../src/pages/meetings.astro#L50-L53) builds `pendingInvitations` filtering only on `status === "pending"` — no `invited_at` cutoff. A 30h-old invite still renders as actionable.
  - [respond.ts](../../../src/pages/api/meetings/invitations/respond.ts) gates accept/decline on `status = 'pending'` only (mirroring the RLS `meeting_invitations_update` USING clause in [20260529120000_meeting_invitations_respond.sql:35-38](../../../supabase/migrations/20260529120000_meeting_invitations_respond.sql#L35-L38)) — no time check. A stale-but-unswept invite is still acceptable.
- Cloudflare deploy target is a **Worker** (`@astrojs/cloudflare` ^13.5), `main` currently `@astrojs/cloudflare/entrypoints/server` ([wrangler.jsonc:4](../../../wrangler.jsonc#L4)). `nodejs_compat` on, `observability.enabled = true`.
- Supabase client today is cookie/SSR-based and reads `SUPABASE_URL`/`SUPABASE_KEY` from `astro:env/server` ([supabase.ts](../../../src/lib/supabase.ts)). There is **no service-role client** and no `SUPABASE_SERVICE_ROLE_KEY` anywhere ([.dev.vars](../../../.dev.vars), [.env.example](../../../.env.example) hold only URL + anon key).

## Desired End State

- A daily Cloudflare Cron Trigger fires `scheduled()` on the Worker, which calls `public.expire_stale_invitations()`; every `pending` invitation with `invited_at < now() - 24h` becomes `expired`. The run logs how many rows it expired (visible via `wrangler tail`).
- A pending invitation older than 24h is **never** shown in the `/meetings` Pending section and **cannot** be accepted or declined, even before the next sweep runs — FR-008 holds at all times, not merely at cron granularity.
- The web app still serves normally through the new custom worker entrypoint (middleware/auth/assets unchanged — verified, not assumed).

**Verification of end state:** seed a `pending` invitation with `invited_at = now() - 25h`, run the sweep (`select public.expire_stale_invitations();` and/or the local scheduled trigger), observe the row flip to `expired`; confirm the same row is absent from Pending and returns 404 on accept.

### Key Discoveries:

- Astro Cloudflare cron pattern: a custom entrypoint that imports `handle` from `@astrojs/cloudflare/handler` and exports `{ fetch, scheduled }`; v13 builds the manifest internally so `handle(request, env, ctx)` is called directly. `main` points at the custom file. (Source: [Astro Cloudflare adapter docs](https://docs.astro.build/en/guides/integrations-guide/cloudflare/), [withastro/astro#13838](https://github.com/withastro/astro/issues/13838).)
- Local scheduled handler can be triggered by an HTTP request to `/cdn-cgi/handler/scheduled` under `wrangler dev` (Source: [Cloudflare Scheduled Handler docs](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)).
- Postgres grants `EXECUTE` on new functions to `PUBLIC` by default — the RPC must `revoke execute ... from public` (and `anon`, `authenticated`) and `grant execute ... to service_role` so only the background job can call it.
- SECURITY DEFINER + `set search_path = public, pg_temp` is the established project pattern for privileged DB logic (see `is_connected`, `create_meeting_with_invitations`, the cross-table helpers — [AGENTS.md §Key conventions](../../../AGENTS.md)).

## What We're NOT Doing

- Not building a queue, retry/dead-letter, or any durable job infrastructure — a single idempotent daily sweep is the whole job.
- Not adding multi-region / HA scheduling (explicitly out of scope per roadmap and infrastructure.md).
- Not changing the `expired` enum, the meetings tables, or the create/list RPCs.
- Not surfacing `expired` invitations anywhere in the UI as a distinct state — once expired they simply drop out of the Pending section (the meeting itself remains visible per existing RLS if the viewer is creator or accepted invitee).
- Not implementing Supabase `pg_cron` (the in-DB alternative was considered and rejected in favor of the Cloudflare Cron Trigger recorded in infrastructure.md).
- Not wiring CI to run `wrangler dev` as a gate (noted in infrastructure.md as a separate concern).

## Implementation Approach

Three ordered phases. Phase 1 lands the DB contract (the sweep RPC + an accept-time RLS guard) so the rest has something to call and the strict-FR-008 guarantee has a server-side anchor. Phase 2 adds the Cloudflare cron worker entrypoint and the service-role plumbing that invokes the RPC — the headline deliverable and the riskiest change (it repoints the Worker's `main`). Phase 3 closes the user-visible read gap so stale invites disappear from Pending immediately. Phases 2 and 3 both depend only on Phase 1.

## Critical Implementation Details

- **Worker entrypoint swap is the load-bearing risk.** Repointing `main` from `@astrojs/cloudflare/entrypoints/server` to `./src/worker.ts` must preserve the full Astro pipeline — `handle()` runs middleware (auth redirects), API routes, and asset serving. This has to be regression-verified under `wrangler dev`, not assumed.
- **Service-role auth context.** `scheduled()` receives the Worker `env` binding directly and runs with no user session; it must read `SUPABASE_SERVICE_ROLE_KEY` from `env` (not `astro:env/server`, which is wired for the request pipeline) and create a non-cookie supabase-js client. The service-role key bypasses RLS — it must never reach the client bundle or any request-path code.
- **Idempotency.** The sweep only ever transitions `pending → expired` for rows past the cutoff; running it twice in a row is a no-op the second time. No locking needed.

## Phase 1: DB — sweep RPC + accept-time guard

### Overview

Add the migration that creates the `SECURITY DEFINER` sweep function and tightens the invitation-update RLS policy so a stale pending invite cannot be accepted/declined even before the sweep marks it expired.

### Changes Required:

#### 1. New migration

**File**: `supabase/migrations/20260601120000_invitation_expiry_sweep.sql`

**Intent**: Create the background-job sweep RPC and close the accept-time hole so FR-008 is enforced server-side at all times.

**Contract**:

- `public.expire_stale_invitations() returns integer` — `language plpgsql`, `security definer`, `set search_path = public, pg_temp`. Updates `meeting_invitations set status = 'expired' where status = 'pending' and invited_at < now() - interval '24 hours'`; returns the affected row count (`GET DIAGNOSTICS` or `with ... returning`). Does **not** stamp `responded_at` (expiry is not a user response; leave it null). Idempotent.
- Grant surface: `revoke execute on function public.expire_stale_invitations() from public, anon, authenticated;` then `grant execute on function public.expire_stale_invitations() to service_role;`. Add a `comment on function` noting it is S-04's cron-only sweep.
- Tighten the existing `meeting_invitations_update` policy: `drop policy meeting_invitations_update on public.meeting_invitations;` then recreate it identically **except** the USING clause gains the freshness predicate — `using (auth.uid() = invitee_id and status = 'pending' and invited_at > now() - interval '24 hours')`. WITH CHECK is unchanged (`accepted`/`declined`). Effect: a stale pending row is invisible to the update path, so `respond.ts`'s `.maybeSingle()` returns null → existing 404 mapping covers it with no endpoint change.

#### 2. Regenerated DB types

**File**: `src/db/database.types.ts`

**Intent**: Pick up the new RPC in the typed client so `supabase.rpc("expire_stale_invitations")` is typed.

**Contract**: Regenerated output of `npm run db:types` (do not hand-edit). The `Functions` block gains `expire_stale_invitations`.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly on a fresh DB: `npm run db:reset`
- Types regenerate without diff drift beyond the new function: `npm run db:types` then `git diff --stat src/db/database.types.ts`
- Sweep is correct + idempotent (local psql via the documented `docker exec -i supabase_db_<project> psql` probe): seed a `pending` row with `invited_at = now() - interval '25 hours'`, call `select public.expire_stale_invitations();` → returns `1` and the row is `expired`; call again → returns `0`.
- A fresh (`invited_at = now()`) pending row is untouched by the sweep.

#### Manual Verification:

- With a 25h-old pending invitation, the RLS guard blocks accept: a direct `update ... set status='accepted'` as the invitee affects 0 rows (and the respond endpoint returns 404 — exercised in Phase 3 check).

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Cloudflare cron worker entrypoint

### Overview

Add a custom Worker entrypoint exporting `scheduled()`, wire the daily cron trigger, and give the background job a service-role Supabase client to call the sweep RPC.

### Changes Required:

#### 0. Generate Cloudflare Worker types

**File**: `worker-configuration.d.ts` (new, generated)

**Intent**: Bring the `Env`, `ExportedHandler`, `ExecutionContext`, and `ScheduledController` globals into the project's type scope so the typed worker entrypoint compiles under `astro/tsconfigs/strict`. These are not currently defined anywhere (no `@cloudflare/workers-types` dep, no generated d.ts; `src/env.d.ts` defines only `App.Locals`).

**Contract**: Run `npx wrangler types` (wrangler ^4.90 is already a dep) to emit `worker-configuration.d.ts` at the repo root, then confirm tsconfig picks it up — the `**/*` include already covers the root, but verify `astro check`/`tsc` resolves `Env` afterward; add an explicit `"types"`/triple-slash reference only if it doesn't. Commit the generated file (it's deterministic and small). Note: secrets set via `wrangler secret put` are **not** auto-included in the generated `Env`, so `env.SUPABASE_SERVICE_ROLE_KEY` is typed `string | undefined` — the admin factory (change #1) must treat it as possibly-missing.

#### 1. Service-role Supabase client factory

**File**: `src/lib/supabase-admin.ts` (new)

**Intent**: Create a non-cookie supabase-js client authenticated with the service-role key for background jobs that must bypass RLS. Kept separate from the request-path `createClient` so the service-role key never enters the cookie/SSR path.

**Contract**: Export a function taking the Worker `env` (or the two string values) and returning a `supabase-js` client built with `createClient<Database>(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })`. Reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from the passed-in `env`, not from `astro:env/server`. Returns null (or throws a clearly-logged error) if either is missing.

#### 2. Custom worker entrypoint

**File**: `src/worker.ts` (new)

**Intent**: Wrap the Astro request handler and add the cron `scheduled()` handler that runs the sweep.

**Contract**: Default-exports a Worker object `{ fetch, scheduled } satisfies ExportedHandler<Env>` (the `Env` / `ExportedHandler` globals come from the `worker-configuration.d.ts` generated in change #0). `fetch` delegates to `handle` from `@astrojs/cloudflare/handler` — verified to export `handle(request: Request, env: Env, context: ExecutionContext)` in the installed v13.5 (`@astrojs/cloudflare/dist/utils/handler.d.ts`). `scheduled(event, env, ctx)` builds the admin client, calls `rpc("expire_stale_invitations")`, and `console.log`s the returned count (or logs the error); wrap the async work in `ctx.waitUntil(...)`. Errors are logged, never rethrown to crash the runtime.

```ts
// shape only — the scheduled body is the non-obvious part
import { handle } from "@astrojs/cloudflare/handler";
export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled: (event, env, ctx) => {
    ctx.waitUntil(
      (async () => {
        const admin = createAdminClient(env);
        const { data, error } = await admin.rpc("expire_stale_invitations");
        if (error) console.error("expiry sweep failed", error.message);
        else console.log(`expiry sweep: ${data} invitation(s) expired`);
      })(),
    );
  },
};
```

#### 3. Wrangler config

**File**: `wrangler.jsonc`

**Intent**: Point the Worker at the custom entrypoint and register the daily cron schedule.

**Contract**: Set `"main": "./src/worker.ts"` (replacing `@astrojs/cloudflare/entrypoints/server`). Add `"triggers": { "crons": ["0 3 * * *"] }` (daily 03:00 UTC). Leave `assets`, `observability`, `compatibility_*` unchanged.

#### 4. Service-role secret wiring

**Files**: `.dev.vars`, `.env.example`

**Intent**: Make the new secret available locally and document it; the production secret is set by hand (human-gated per infrastructure.md).

**Contract**: Add `SUPABASE_SERVICE_ROLE_KEY=<local supabase service_role key>` to `.dev.vars` and a `SUPABASE_SERVICE_ROLE_KEY=###` placeholder to `.env.example`. The local value is the `service_role key` printed by `npx supabase status`. Document in the change notes that production requires `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (manual, human-only). No `astro.config.mjs` env-schema entry is required because the key is consumed only via the Worker `env` binding in `scheduled()`, not via `astro:env/server`.

### Success Criteria:

#### Automated Verification:

- Worker types generated: `npx wrangler types` produces `worker-configuration.d.ts` and `Env` resolves
- Build succeeds with the custom entrypoint: `npm run build`
- Lint passes on touched files (Windows: `npx eslint src/worker.ts src/lib/supabase-admin.ts`)
- Type checking passes (after `wrangler types`): `npx astro check` (or `npx tsc --noEmit`)

#### Manual Verification:

- `npx wrangler dev` serves the app: home page loads, and an unauthenticated request to `/dashboard` still redirects to `/auth/signin` (middleware regression check through the new entrypoint).
- Triggering the scheduled handler locally (`curl http://localhost:8787/cdn-cgi/handler/scheduled`) runs the sweep — `wrangler dev` console logs `expiry sweep: N invitation(s) expired`, and a pre-seeded 25h-old pending row is now `expired`.
- `npx wrangler deploy` registers the cron trigger (the deploy output lists the schedule). _(Deploy is human-initiated; do not deploy unattended.)_

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: Read-path guard (UI)

### Overview

Exclude pending invitations older than 24h from the `/meetings` Pending section so a stale invite is never shown or actioned, independent of when the sweep last ran.

### Changes Required:

#### 1. Pending-invitation read filter

**File**: `src/pages/meetings.astro`

**Intent**: Add the 24h freshness cutoff to the Pending-invitations computation so the user never sees a stale invite (the RLS guard from Phase 1 already prevents accepting one; this stops it ever appearing).

**Contract**: In the `pendingInvitations` derivation ([meetings.astro:50-53](../../../src/pages/meetings.astro#L50-L53)), extend the predicate so a row qualifies only if `status === "pending"` **and** `new Date(inv.invited_at).getTime() > now - 24 * 60 * 60 * 1000`. `invited_at` is already selected in the query and present on the invitation shape, so no query change is needed. The conflict-computation block keys off `pendingInvitations`, so stale invites drop out of conflict math automatically.

### Success Criteria:

#### Automated Verification:

- Lint passes on touched file (Windows: `npx eslint src/pages/meetings.astro`)
- Build succeeds: `npm run build`

#### Manual Verification:

- A meeting whose invitation to the viewer is `pending` with `invited_at` < 24h ago **appears** in Pending; one with `invited_at` > 24h ago does **not** appear.
- Attempting to accept a >24h-old pending invitation via the API returns 404 (Phase 1 RLS guard), confirming the read filter and the server guard agree.
- No regression: fresh pending invitations still show their conflict warning correctly.

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation.

---

## Testing Strategy

### Unit / DB Tests:

- Sweep selects exactly the rows past the 24h cutoff (boundary: a row at exactly 24h is not expired; at 24h+1s it is).
- Sweep is idempotent (second run returns 0).
- Sweep leaves `responded_at` null and never touches `accepted`/`declined`/already-`expired` rows.

### Integration Tests:

- End-to-end via the local stack: seed a 25h-old pending invite → trigger `/cdn-cgi/handler/scheduled` → row is `expired`, absent from Pending, 404 on accept.

### Manual Testing Steps:

1. `npm run db:reset` then seed two pending invites to the same invitee: one `invited_at = now()`, one `invited_at = now() - 25h`.
2. Load `/meetings` as that invitee — only the fresh one shows in Pending.
3. `npx wrangler dev`; `curl .../cdn-cgi/handler/scheduled`; confirm log count = 1 and the stale row is now `expired`.
4. Confirm `/dashboard` still redirects when logged out (entrypoint regression).

## Performance Considerations

The sweep is a single indexed UPDATE (`meeting_invitations_invitee_pending_idx` is a partial index on `status = 'pending'`, which the `where status = 'pending'` predicate uses). At MVP scale this is sub-millisecond and well inside the free-tier CPU budget. Daily cadence keeps invocations negligible.

## Migration Notes

- The migration is additive (new function) plus a policy drop+recreate. Per infrastructure.md, a Worker rollback does **not** revert Supabase migrations — but this migration is forward-compatible: the tightened `meeting_invitations_update` policy only narrows accept eligibility for already-stale rows, and the old Worker (without `scheduled`) functions fine against the new schema. No destructive change, no data backfill.

## References

- Roadmap slice S-04: [context/foundation/roadmap.md](../../foundation/roadmap.md) (§S-04)
- Risk it closes: [context/foundation/infrastructure.md](../../foundation/infrastructure.md) §Risk Register (lazy-expiry leak)
- Enum + invitation schema: [supabase/migrations/20260528105428_meetings_foundation.sql](../../../supabase/migrations/20260528105428_meetings_foundation.sql)
- Existing update policy + responded_at: [supabase/migrations/20260529120000_meeting_invitations_respond.sql](../../../supabase/migrations/20260529120000_meeting_invitations_respond.sql)
- Read path: [src/pages/meetings.astro](../../../src/pages/meetings.astro); accept path: [src/pages/api/meetings/invitations/respond.ts](../../../src/pages/api/meetings/invitations/respond.ts)
- Astro Cloudflare cron pattern: https://docs.astro.build/en/guides/integrations-guide/cloudflare/ · https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: DB — sweep RPC + accept-time guard

#### Automated

- [x] 1.1 Migration applies cleanly on a fresh DB (`npm run db:reset`) — 01e5dd2
- [x] 1.2 Types regenerate without drift beyond the new function (`npm run db:types`) — 01e5dd2
- [x] 1.3 Sweep is correct + idempotent (25h-old row → expired, returns 1; second call returns 0) — 01e5dd2
- [x] 1.4 A fresh pending row is untouched by the sweep — 01e5dd2

#### Manual

- [x] 1.5 RLS guard blocks accept of a 25h-old pending row (0 rows affected) — 01e5dd2

### Phase 2: Cloudflare cron worker entrypoint

#### Automated

- [x] 2.1 Worker types generated (`npx wrangler types` → `worker-configuration.d.ts`, `Env` resolves) — ea5cb54
- [x] 2.2 Build succeeds with the custom entrypoint (`npm run build`) — ea5cb54
- [x] 2.3 Lint passes on touched files (`npx eslint src/worker.ts src/lib/supabase-admin.ts`) — ea5cb54
- [x] 2.4 Type checking passes after `wrangler types` (`npx astro check` / `tsc --noEmit`) — ea5cb54

#### Manual

- [x] 2.5 `wrangler dev` serves the app and `/dashboard` still redirects when logged out (middleware regression) — ea5cb54
- [x] 2.6 Local scheduled trigger runs the sweep, logs the count, and expires a seeded stale row — ea5cb54
- [x] 2.7 `wrangler deploy` registers the daily cron trigger (human-initiated) — ea5cb54

### Phase 3: Read-path guard (UI)

#### Automated

- [x] 3.1 Lint passes on touched file (`npx eslint src/pages/meetings.astro`)
- [x] 3.2 Build succeeds (`npm run build`)

#### Manual

- [x] 3.3 Fresh pending invite shows in Pending; >24h-old one does not
- [x] 3.4 Accepting a >24h-old pending invite via API returns 404
- [x] 3.5 No regression: fresh pending invitations still show conflict warning
