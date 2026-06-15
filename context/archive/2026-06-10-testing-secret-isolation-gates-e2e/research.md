---
date: 2026-06-10T00:00:00+02:00
researcher: Przemek
git_commit: ced28350d35945c30a01e59c7342adcbcb2c945c
branch: master
repository: appitata
topic: "Phase 4 grounding — secret isolation (Risk #6), CI quality-gate wiring, north-star co-care e2e"
tags: [research, codebase, secret-isolation, ci, e2e, playwright, eslint, test-plan-phase-4]
status: complete
last_updated: 2026-06-10
last_updated_by: Przemek
---

# Research: Phase 4 — Secret isolation, quality-gate wiring, north-star e2e

**Date**: 2026-06-10T00:00:00+02:00
**Researcher**: Przemek
**Git Commit**: ced28350d35945c30a01e59c7342adcbcb2c945c
**Branch**: master
**Repository**: appitata

## Research Question

Ground rollout Phase 4 of `context/foundation/test-plan.md` ("Secret isolation + quality-gates wiring + north-star e2e"). Verify, do not blindly accept, the §2 Risk Response Guidance for:

- **Risk #6** — the Supabase service-role/admin key must never reach a client bundle or a request-handling path. Cheapest layer: a deterministic static import/grep check (NOT a runtime test that needs the real key).
- **Cross-cutting** — wire the §5 quality gates and make one Playwright e2e of the full co-care flow durable, asserting the conflict warning renders.

For each: ground the real failure path in code, locate existing tests/infra, verify or correct the response guidance, and identify the cheapest useful layer.

## Summary

Three findings reframe how Phase 4 should be planned:

1. **Risk #6 isolation is already correct — the static check is a _regression lock_, not a fix.** A dedicated admin module [src/lib/supabase-admin.ts](../../../src/lib/supabase-admin.ts) reads the service-role key from the Worker `env` binding (never `astro:env/server`) and is imported by exactly one file, [src/worker.ts:3](../../../src/worker.ts#L3) (the Cloudflare cron entrypoint). The key is deliberately **absent** from the `astro.config.mjs` env schema, so it cannot enter the SSR/cookie path or the client bundle. The "what would prove protection" oracle (§2) holds today. So the check's job is to _fail if a future edit breaks this_, not to repair a current leak. Plan it as a forward guard and pin both vectors (import-site **and** the env-schema vector).

2. **CI gate drift: §5 declares unit+integration "required after Phase 1", but CI runs neither.** [.github/workflows/ci.yml](../../../.github/workflows/ci.yml) is **lint + build only** — no test step, no local Supabase. Phases 1–3 shipped 10 test files (1 unit + 9 integration) that have never run in CI. Phase 4's "quality-gate wiring" must reconcile this: decide which layers actually run in CI and how (Supabase + SSR server are required for integration/e2e, which CI does not yet provide). This is the single biggest planning decision — see Open Questions.

3. **The north-star e2e is fully specified and has a working reference driver.** `[data-testid="conflict-warning"]` is confirmed at [PendingInvitationsList.tsx:82](../../../src/components/meetings/PendingInvitationsList.tsx#L82); the Alice→Bob accepted friend-connection is seeded; and `.verify-evidence/phase-3/verify.mjs` already drives the exact flow end-to-end (with one bug: it uses the wrong password). Playwright is **not** a project dependency — it would be new. The flow is browser-necessary because the conflict math renders in `.astro`/island markup that integration tests cannot see (the §3 rationale holds).

## Detailed Findings

### Risk #6 — Secret isolation surface (the static-check target)

**Admin client construction** — [src/lib/supabase-admin.ts](../../../src/lib/supabase-admin.ts):

- `createAdminClient(env: { SUPABASE_URL?, SUPABASE_SERVICE_ROLE_KEY? }): SupabaseClient | null` (lines 18–28).
- Reads `env.SUPABASE_SERVICE_ROLE_KEY` from the **passed Worker `env` object**, NOT from `astro:env/server`. Returns `null` (never throws) if either value is missing. `auth: { persistSession: false, autoRefreshToken: false }`.
- Module doc comment (lines 8–11) states the separation intent explicitly: kept apart from the cookie/request client so the key "never enters the SSR/cookie path or the client bundle."

**Import graph (verified directly with grep):**

- `supabase-admin` is imported by exactly **one** file: [src/worker.ts:3](../../../src/worker.ts#L3). Nothing under `src/components/**`, `src/pages/**` (incl. `src/pages/api/**`), `src/lib/**` (other than itself), or `src/middleware.ts` imports it.
- The cron consumer: [src/worker.ts](../../../src/worker.ts) — `wrangler.jsonc` sets `"main": "./src/worker.ts"` and `"crons": ["0 3 * * *"]`. `scheduled()` → `runExpirySweep(env)` → `createAdminClient(env)` → `admin.rpc("expire_stale_invitations")` (lines 13–29). The key flows `Worker env → fn param → client`, no global/module state.

**The second vector — env schema:** verified `SUPABASE_SERVICE_ROLE_KEY` does **not** appear in `astro.config.mjs` (grep: no matches). Only `SUPABASE_URL` and `SUPABASE_KEY` are declared in the `env.schema` (anon path, accessed via `astro:env/server` in [src/lib/supabase.ts](../../../src/lib/supabase.ts)). If a future edit added the service-role key to that schema, it would become importable on the request path even without importing `supabase-admin` — so a complete isolation check must guard the schema too, not just the import site.

**Where the key legitimately lives** (names only, values not reproduced): `.dev.vars` (used by `astro preview`/workerd), `.env.test` (Vitest), `.env.example` (`###` placeholder + comments), and production via `wrangler secret put`. Tests read it from `process.env` via `serviceClient()` in [tests/helpers/supabase.ts](../../../tests/helpers/supabase.ts) (`requireEnv("SUPABASE_SERVICE_ROLE_KEY")`, lines 14, 36–40) — **legitimate and out of scope** for the isolation check.

**Verdict on §2 guidance for Risk #6:** confirmed and cheapest-layer is correct (deterministic static check, no runtime key). One correction/extension: the guidance says "prove the key is never imported onto a client/request path" — add the env-schema vector to the proof. The anti-pattern ("a test that needs the real service-role key to run") is right; isolation is a grep/lint assertion, not an integration test.

### Static-check feasibility (ESLint rule vs grep script)

**ESLint config** — [eslint.config.js](../../../eslint.config.js): flat config (ESLint 9, `tseslint.config()`), plugins: typescript-eslint (strictTypeChecked + stylisticTypeChecked), prettier/recommended, astro (+jsx-a11y), react, react-compiler, react-hooks. **No** `no-restricted-imports`/`no-restricted-paths` rule today. `eslint-plugin-import` and `eslint-plugin-boundaries` are **not** in `package.json`. A path-specific override block already exists (lines 77–86 relax rules for `src/db/database.types.ts`), so per-zone config is an established pattern.

**Two viable mechanisms:**

- **(A) ESLint `no-restricted-imports`** (built-in, zero new deps): a config block scoped to `files: ["src/components/**", "src/pages/**", "src/middleware.ts", "src/lib/**"]` forbidding import of `@/lib/supabase-admin`. Runs in CI's `npm run lint` (ubuntu = LF, so the CRLF caveat below does not bite CI). Not auto-fixable, so it surfaces as a hard error. Does **not** cover the env-schema vector.
- **(B) grep/script gate** (CRLF-safe, vector-complete): a small `scripts/check-secret-isolation.mjs` (or `.sh`) that (1) greps for `supabase-admin` imports outside `src/worker.ts`, and (2) asserts `astro.config.mjs` never names `SUPABASE_SERVICE_ROLE_KEY`. Exit 1 on violation. No new deps, no line-ending sensitivity.

**Local-lint caveat** (AGENTS.md, [package.json](../../../package.json) `"lint": "eslint ."`): on Windows `npm run lint` over the full tree fails on pre-existing CRLF debt — so option (A) is reliable in CI but awkward to run full-tree locally on Windows (scoped `npx eslint <paths>` works). Option (B) sidesteps this entirely. **These are not exclusive** — a robust plan can do both: ESLint rule for the import vector (catches it at dev time via lint-staged) + a tiny grep/test for the env-schema vector. A Vitest **unit** test that statically reads the two files and asserts the invariants is a third framing that runs in the existing `unit` project with no server (and would run in CI the moment unit tests are wired).

**Hook layers** (Module 3 Lesson 3 context): `.husky/pre-commit` → `npx lint-staged` (eslint --fix on `*.{ts,tsx,astro}`); `.husky/pre-push` (untracked, exists) → `npm run typecheck`. The pre-push hook is a candidate home for a heavier secret-isolation gate, but CI is the durable enforcement point.

### CI + test infrastructure (the gate-wiring target)

**Current CI** — [.github/workflows/ci.yml](../../../.github/workflows/ci.yml): triggers on push/PR to `master`; one `ci` job on `ubuntu-latest`, Node 22; steps: checkout → setup-node → `npm ci` → `npx astro sync` → `npm run lint` → `npm run build` (with `SUPABASE_URL`/`SUPABASE_KEY` secrets). **No test step. No local Supabase service.**

**Scripts** — [package.json](../../../package.json): `test: "vitest run"`, `test:watch`, `lint`, `lint:fix`, `typecheck: "astro check"`, `build`, `db:reset`, `db:types`. No `test:unit`/`test:integration`/`test:e2e` scripts (project filtering is via `--project`).

**Vitest** — [vitest.config.ts](../../../vitest.config.ts) (`vitest ^3.2.6`): loads `.env.test` via `loadEnv`. Two projects:

- `unit` — `environment: node`, `include: tests/unit/**/*.test.ts`, no globalSetup, default timeouts. Sub-second, no server/DB.
- `integration` — `environment: node`, `include: tests/integration/**/*.test.ts`, `globalSetup: ./tests/setup/server.ts`, `testTimeout: 30_000`, `hookTimeout: 150_000`, `fileParallelism: false` (shared DB fixtures). A new **e2e** would be project #3 (or a standalone Playwright config).

**Server harness** — [tests/setup/server.ts](../../../tests/setup/server.ts): runs `npm run build` then spawns `npm run preview` (workerd) on hard-coded `http://localhost:4321`; polls `GET /auth/signin` for readiness (TCP is insufficient — workerd accepts the socket before routes compile); tears down the process tree. Honors a `TEST_BASE_URL` env override to **reuse an already-running server** (lines ~101) — relevant for letting a Playwright run reuse the same server. Reads secrets from `.dev.vars` (inherited by the preview subprocess).

**Helpers** — [tests/helpers/supabase.ts](../../../tests/helpers/supabase.ts) (client factories: `signInAs`, `serviceClient`), [tests/helpers/http.ts](../../../tests/helpers/http.ts) (cookie-jar `signInOverHttp`, `anonymousJar`).

**Existing suites (10 files):** `tests/unit/conflicts.test.ts`; integration: `smoke`, `auth`, `parents-isolation`, `meetings-isolation`, `conflict-render`, `invitation-expiry`, `api/harness.smoke`, `api/validation`, `api/authz`. All require local Supabase up + `npm run db:reset`.

**Playwright presence:** **not** in `package.json` (no `playwright`/`@playwright/test`). Installed only inside `.verify-evidence/node_modules` (untracked scratchpad). `.gitignore` has no `test-results/`/`playwright-report/` entries — would need adding.

### North-star co-care flow (the e2e spec)

A complete working reference exists: **`.verify-evidence/phase-3/verify.mjs`** drives sign-in (Alice + Bob) → create meeting → accept → create overlapping meeting → assert `[data-testid="conflict-warning"]` renders with "overlaps" text → screenshot. Reuse as the spec template. **Bug to fix when porting:** it uses password `password123!` (does not match the seed's `test1234`). `.verify-evidence/` is an untracked scratchpad — do not propose tracking it (see MEMORY).

**Auth:** sign-in page [src/pages/auth/signin.astro](../../../src/pages/auth/signin.astro) renders `<SignInForm client:load>` ([SignInForm.tsx](../../../src/components/auth/SignInForm.tsx)): `<form method="POST" action="/api/auth/signin">`; inputs `#email`/`name="email"` (line 45) and `#password`/`name="password"` (line 59). API [src/pages/api/auth/signin.ts](../../../src/pages/api/auth/signin.ts): success → **302 → `/`** (line 19); bad creds → `302 → /auth/signin?error=…`. Deterministic shortcut (from template): `request.post('/api/auth/signin', { form: {email,password}, headers: {Origin: BASE}, maxRedirects: 0 })`, assert `302` + `location === '/'`; cookies then persist on the browser context.

**Meeting creation:** inline on `/meetings`, not a separate route — [meetings.astro:91-94](../../../src/pages/meetings.astro#L91) renders `<MeetingCreateForm client:load>` ([MeetingCreateForm.tsx](../../../src/components/meetings/MeetingCreateForm.tsx)). The form only renders when the viewer has accepted friends (else a "Connect on /friends" message; lines 33–43). Fields (`id`===`name`): `starts_at` (datetime-local, line 124), `street`/`city`/`postal_code`/`country` (133–161), `description` textarea (179), invitee checkboxes per friend selected by visible `display_name` (207–216, no test-id). **No duration field** — server defaults to 60 min ([api/meetings/index.ts:57](../../../src/pages/api/meetings/index.ts#L57)). Submits JSON to `POST /api/meetings`, expects **201**, then `window.location.reload()`. For determinism, prefer API-driven setup (`POST /api/meetings`) and reserve UI clicks for Bob's accept path.

**The /meetings page + conflict warning** — [meetings.astro](../../../src/pages/meetings.astro): four sections (Create / Pending invitations / Upcoming / Past). Conflict warning **confirmed** at [PendingInvitationsList.tsx:82](../../../src/components/meetings/PendingInvitationsList.tsx#L82): `<div data-testid="conflict-warning">` renders iff `rowConflicts.length > 0`. Each pending row is `<li data-testid="pending-invitation" data-invitation-id=…>` (60–63). Accept/decline are `<Button data-testid="accept-button">` / `data-testid="decline-button"` (95–116) — `type="button"` onClick (not form submit) → `fetch POST /api/meetings/invitations/respond {invitation_id, action}` → reload.

**Trigger condition** — frontmatter [meetings.astro:49-68](../../../src/pages/meetings.astro#L49) + [src/lib/conflicts.ts](../../../src/lib/conflicts.ts): `computeConflictsByInvitationId(pendingInvitations, myScheduleForConflicts)`. `overlaps(a,b) = aStart < endsAt(b) && bStart < endsAt(a)` — half-open `[start,end)`: equal-start overlaps; back-to-back (touching) does not. `pendingInvitations` are filtered to `invited_at > now - 24h` (freshness cutoff). `myScheduleForConflicts` = meetings the viewer **created OR accepted**. So to force the warning: the invitee must already hold a created/accepted meeting that overlaps a second meeting they hold a **fresh pending** invitation for. Equal `starts_at` + default 60-min duration guarantees overlap.

**Seed identities** — [supabase/seed.sql](../../../supabase/seed.sql): four parents, all password `test1234` (bcrypt-stamped via UPDATE): Alice `…a01` `alice@example.com`, Bob `…b01` `bob@example.com`, Carol `…c01`, Dave `…d01`. FCs: **Alice→Bob `accepted`** (use this pair), Alice→Carol `pending` (not invitable via `list_my_friends()`), Dave unconnected. **No seeded meetings/invitations** — the e2e creates them at runtime (template wipes `public.meetings` first). Local DB container for psql probes: `supabase_db_10x-astro-starter` (pipe SQL via `docker exec -i`; psql not on PATH — see MEMORY).

**Hydration timing (load-bearing):** `PendingInvitationsList`/`MeetingsList` are `client:visible` — accept/decline handlers attach only after the IntersectionObserver fires, so the e2e must `scrollIntoView` + wait before clicking. The conflict `<div>` itself is server-rendered and assertable without hydration; only the click path needs it.

## Code References

- [src/lib/supabase-admin.ts:18-28](../../../src/lib/supabase-admin.ts#L18) — `createAdminClient(env)`; reads key from Worker env, not `astro:env/server`.
- [src/worker.ts:3](../../../src/worker.ts#L3) — the **only** importer of `supabase-admin`; cron `scheduled()` consumer (lines 13–29).
- `astro.config.mjs` env schema — service-role key absent (verified, no match); anon path in [src/lib/supabase.ts](../../../src/lib/supabase.ts).
- [tests/helpers/supabase.ts:14,36-40](../../../tests/helpers/supabase.ts#L36) — `serviceClient()` reads `process.env` (legitimate test usage, out of scope).
- [eslint.config.js:77-86](../../../eslint.config.js#L77) — existing per-path override pattern; no `no-restricted-imports` yet.
- [.github/workflows/ci.yml:18-24](../../../.github/workflows/ci.yml#L18) — lint + build only, no tests, no Supabase.
- [vitest.config.ts](../../../vitest.config.ts) — `unit` and `integration` projects (template for an e2e project).
- [tests/setup/server.ts](../../../tests/setup/server.ts) — build+preview on :4321; `TEST_BASE_URL` reuse hatch.
- [src/components/meetings/PendingInvitationsList.tsx:82](../../../src/components/meetings/PendingInvitationsList.tsx#L82) — `[data-testid="conflict-warning"]`; accept/decline test-ids at 95–116.
- [src/lib/conflicts.ts:24-49](../../../src/lib/conflicts.ts#L24) — `overlaps` (half-open) + `computeConflictsByInvitationId`.
- [supabase/seed.sql](../../../supabase/seed.sql) — Alice/Bob/Carol/Dave, Alice→Bob accepted, password `test1234`.
- `.verify-evidence/phase-3/verify.mjs` — working e2e reference driver (untracked; wrong password to fix on port).

## Architecture Insights

- **Two-client separation is the core invariant.** Request path uses the anon/cookie client ([src/lib/supabase.ts](../../../src/lib/supabase.ts), `astro:env/server`); the privileged path uses [src/lib/supabase-admin.ts](../../../src/lib/supabase-admin.ts) fed from the Worker `env` binding, reachable only via the `src/worker.ts` cron entrypoint. The isolation has two independent vectors — the **import graph** and the **env schema** — and a complete check must cover both.
- **CI currently verifies syntax/type/build, not behavior.** All RLS/authz/conflict/expiry guarantees from Phases 1–3 are proven only on a developer's machine with local Supabase. Wiring them into CI requires standing up Supabase (e.g. `supabase start` step or a service container) + the SSR preview server — a non-trivial CI cost the plan must price in or scope down.
- **The e2e is justified by rendering, not behavior coverage.** Conflict math is already unit-tested ([conflicts.test.ts]) and render-wired in integration ([conflict-render.test.ts]); the e2e exists solely because the warning renders in island/`.astro` markup a Node integration test can't see. Per §3: one flow only, deterministic DOM selectors, no vision review.
- **Determinism levers:** API-driven fixture setup over UI typing; equal `starts_at` to guarantee overlap; `maxRedirects:0` on signin; scroll-into-view + wait for `client:visible` hydration before clicking.

## Historical Context (from prior changes)

- `context/archive/2026-06-03-testing-privacy-rls-isolation/` — Phase 1; built the integration harness, `serviceClient()`, seed identities. Lessons: seed loginable users with empty-string token columns; Docker-VM clock skew (`context/foundation/lessons.md`).
- `context/archive/2026-06-08-testing-api-authz-validation/` — Phase 2; built the HTTP cookie-jar harness, `maxRedirects:0` signin, build-before-serve globalSetup, and the "HTTP silent-pass" guard (a no-session 404 is indistinguishable from a non-owner 404 — every deny needs a paired owner-success control). Same silent-pass discipline applies to e2e assertions. Also flagged: never paste a raw `npm test`/preview log into a shared CI artifact — workerd echoes `.dev.vars` (incl. the service-role key) on a startup error.
- `context/archive/2026-06-01-invitation-expiry-cron-backstop/` — built `src/worker.ts` + `expire_stale_invitations`; the service-role-isolation property this phase locks was first asserted (manually) here.
- `context/foundation/lessons.md` — the errcode-leak rule, the three-layer 24h-window coupling, and the frozen-clock boundary rule (the last two matter only if the e2e touches expiry, which it should not).

## Related Research

- `context/archive/2026-06-08-testing-api-authz-validation/research.md` — error-mapping / DB-side oracle (informs why the e2e asserts UI state, not error bodies).
- `context/archive/2026-06-09-testing-conflict-overlap-expiry/research.md` — the overlap math + render-wiring this e2e exercises at the browser layer.

## Open Questions (decisions for /10x-plan)

1. **CI test execution — the central decision.** CI has no Supabase and no test step. Options: (a) add a `supabase start` (or Postgres service container) + `db:reset` step and run `unit + integration` in CI; (b) run only `unit` (incl. a static secret-isolation unit test) in CI and keep integration local/pre-push; (c) full ladder incl. e2e on PR. Each has a real cost/signal trade. The plan should pick per the test-plan §1 cost×signal principle and update §5 to match reality (the "required after Phase 1" claim is currently aspirational).
2. **Static-check mechanism.** ESLint `no-restricted-imports` (import vector, dev-time via lint-staged, CI via `npm run lint`) vs a grep/script or **unit test** that also covers the env-schema vector. Recommendation to weigh: a `tests/unit/secret-isolation.test.ts` that statically asserts both invariants — runs in the existing `unit` project, CI-portable, no new deps, no CRLF issue, covers both vectors. Decide one or a combination.
3. **Playwright wiring shape.** Standalone `@playwright/test` with its own `webServer` (build+preview) config, vs a Vitest browser-mode e2e project reusing `tests/setup/server.ts` via `TEST_BASE_URL`. Standalone `@playwright/test` is the conventional, CI-friendly path but builds/serves separately; reusing the Vitest server avoids a second build but couples to the Vitest run. New dep + `.gitignore` entries (`test-results/`, `playwright-report/`) needed either way.
4. **e2e in CI vs local-only.** The e2e needs Supabase + build + preview + a browser — heavy. Is it a required PR gate (§5 says "CI on PR") or a local/pre-push gate for the MVP? Tie this to decision (1).
5. **Secret hygiene in CI logs.** Given the Phase 2 warning that workerd echoes `.dev.vars` (service-role key) on startup error, any CI step that spawns the preview server must ensure failure logs are scrubbed or the key is provided via a non-echoed mechanism. Out of scope to _rotate_ the key (ops; test-plan §7), but in scope not to _leak_ it via the new CI step.

## What is explicitly OUT of scope (per test-plan)

- **Service-role key rotation** — ops action, tracked in §7; this phase tests _isolation_ only (the key is currently exposed in prod per MEMORY, but rotation is not a test).
- **Multimodal / vision review** of the e2e — the surface is deterministic DOM; CSS/test-id selectors suffice (§3).
- **e2e of any page other than the single co-care flow** (§3).
