# Test Plan

> Phased test rollout for this project. Strategy is frozen at the top
> (§1–§5); cookbook patterns at the bottom (§6) fill in as phases ship.
> Read before writing any new test.
>
> Refresh: re-run `/10x-test-plan --refresh` when stale (see §8).
>
> Last updated: 2026-06-15 (Phase 4 complete — rollout finished)

## 1. Strategy

Tests follow three non-negotiable principles for this project:

1. **Cost × signal.** The cheapest test that gives a real signal for the
   risk wins. Do not promote to e2e because e2e "feels safer." Do not put a
   vision model on top of a deterministic visual diff that already catches
   the regression.
2. **User concerns are first-class evidence.** Risks anchored in "the team
   is worried about X, and the failure would surface somewhere in <area>"
   carry the same weight as PRD lines or hot-spot data.
3. **Risks are scenarios, not code locations.** This plan documents _what
   could fail_ and _why we believe it's likely_ — drawn from documents,
   interview, and codebase _signal_ (churn, structure, test base). It does
   NOT claim to know which line owns the failure. That knowledge is
   produced by `/10x-research` during each rollout phase. If the plan and
   research disagree about where the failure lives, research is the
   ground truth.

Hot-spot scope used for likelihood weighting: `src/`, `supabase/migrations/`, `supabase/tests/` (30-day window, 41 commits; generated `src/db/database.types.ts` and `supabase/snippets/` excluded).

## 2. Risk Map

The top failure scenarios this project must protect against, ordered by
risk = impact × likelihood. Risks are failure scenarios in user / business
terms, not test names. The Source column cites the _evidence that surfaced
this risk_ — never a specific file as "where the failure lives" (that is
research's job, see §1 principle #3).

| #   | Risk (failure scenario)                                                                                                                                                         | Impact | Likelihood | Source (evidence — not anchor)                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A parent reads another circle's meetings or child details — an RLS SELECT policy is wrong or bypassed and the privacy boundary leaks                                            | High   | High       | PRD §Non-Functional (Privacy boundary); PRD US-02 AC; interview Q1 (top fear); AGENTS RLS-template rule; hot-spot dir `supabase/migrations/` (7 commits/30d)                                    |
| 2   | A parent accepts/declines/deletes an invitation or meeting that is not theirs, or invites a non-connected parent (authorization / IDOR)                                         | High   | High       | PRD FR-007; PRD US-02 AC ("cannot invite a non-friend"); AGENTS cross-table SECURITY DEFINER + one-shot update-policy rules; hot-spot dir `src/pages/api/` (14 commits/30d); interview Q3       |
| 3   | Silent double-booking — the conflict warning fails to fire (overlap math, timezone, or duration wrong) and a meeting is confirmed on top of a clash                             | High   | Medium     | PRD §Success Criteria (Guardrail: no silent double-booking); PRD FR-009; PRD §Business Logic; hot-spot dir `src/pages/` (10 commits/30d)                                                        |
| 4   | An API route trusts the client or maps an RLS/RPC error to the wrong HTTP status — leaking a raw DB message or admitting an invalid write (bad invitee count, invalid duration) | Medium | High       | AGENTS zod-on-every-payload rule; archive `meeting-creation-and-invite` impl-review F1 (message-string error dispatch is fragile); hot-spot dir `src/pages/api/` (14 commits/30d); interview Q3 |
| 5   | An unanswered invitation never expires — the sweep cron stops or the expiry predicate is wrong, so a stale invitation stays actionable past 24h and is confirmed                | Medium | Medium     | PRD FR-008; roadmap S-04 (cron backstop); archive `invitation-expiry-cron-backstop` (real Cron→`scheduled()` only exercisable on deploy)                                                        |
| 6   | The service-role / admin key escapes onto a client or request path, or into logs / error bodies (secret leakage)                                                                | High   | Low–Medium | AGENTS admin-client-only-in-Worker rule; archive `invitation-expiry-cron-backstop` review (service-role isolation check); project state: service_role key currently exposed and not yet rotated |

**Impact × Likelihood rubric.** High = user loses access/data, or failure is publicly visible / changes weekly / already burned. Medium = feature degrades or a workaround exists / touched occasionally. Low = cosmetic / stable code. Protect High × High first (Risks 1, 2). Risk 6 is High-impact but lower-likelihood and is partly an ops concern (key rotation) — only its _isolation_ property is testable; rotation is tracked in §7, not as a test.

**Abuse / security lens.** AppiTata has auth and accepts user input (no payments), so the map carries the abuse rows the happy path hides: Risk 2 = authorization/IDOR, Risk 4 = untrusted-input / validation parity, Risk 6 = secret leakage. Resource-abuse (friend-request / invitation flooding) was considered and deliberately deferred to §7 — low blast radius for an MVP among already-known friends.

### Risk Response Guidance

| Risk | What would prove protection                                                                                                                     | Must challenge                                                                                                             | Context `/10x-research` must ground                                                                             | Likely cheapest layer                                                   | Anti-pattern to avoid                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| #1   | Parent A's query returns zero rows of an unconnected Parent C's meetings/children; returns them only after an accepted friend-connection exists | "Authenticated ⇒ allowed to read"; "a pending friend-connection counts as connected" (the parents_select pending exposure) | The viewer/owner check used by each SELECT policy; what "connected" resolves to; the multi-parent fixture shape | integration (local Supabase, RLS on, two+ parents)                      | Asserting privacy via UI filtering instead of at the DB; lifting the expected result from the policy SQL (tautology) |
| #2   | A non-owner's accept/decline/delete is rejected; inviting a non-connected parent is rejected; an invitation transition is one-shot              | "The meeting creator can mutate ⇒ the invitee can too"; "a row is visible ⇒ that row is mutable"                           | The ownership/connection precondition each mutation enforces; which transitions the update policy permits       | integration (API routes exercised as two different authenticated users) | Happy-path-only; over-mocking the Supabase client so RLS never actually runs                                         |
| #3   | An overlapping proposed time yields a conflict signal _before_ confirm; a non-overlapping time does not                                         | "Equal start time is the only kind of overlap"; the assumed meeting duration; UTC vs local time comparison                 | How overlap is computed and from which dataset; the duration assumption; the timezone the comparison runs in    | unit (overlap math) + one integration                                   | Copying the expected value out of the frontmatter overlap calculation (the oracle problem)                           |
| #4   | A malformed payload returns a 4xx with a safe body; an RLS/RPC failure returns the correct status with no raw DB text                           | "HTTP 200 means the operation succeeded"; "the RPC error message string is stable"                                         | The zod schema each route enforces; the RLS/RPC error-code → HTTP-status mapping; what the error body exposes   | integration (API routes)                                                | Asserting the current literal error string instead of the status/contract                                            |
| #5   | A >24h unanswered invitation is `expired` and can no longer be confirmed after a sweep; the sweep is idempotent                                 | "Lazy expiry-on-read is sufficient"; "a final 200 means the row was actually swept"                                        | The expiry predicate and the sweep's transactional/idempotency behaviour; who may invoke it                     | integration (expiry RPC + re-run for idempotency)                       | Meaningless snapshot; trusting the cron without asserting the predicate it runs                                      |
| #6   | The admin/service-role key is never imported onto a client or request-handling path                                                             | "It is server-only because we intend it to be"                                                                             | The full import graph of the admin client; where the key is read from                                           | deterministic static check (import/grep lint rule)                      | A test that needs the real service-role key in order to run                                                          |

## 3. Phased Rollout

Each row is a discrete rollout phase that will open its own change folder
via `/10x-new`. Status moves left-to-right through the values below; the
orchestrator updates Status as artifacts appear on disk.

| #   | Phase name                                               | Goal (one line)                                                                                            | Risks covered      | Test types                 | Status        | Change folder                                               |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------- | ------------- | ----------------------------------------------------------- |
| 1   | Test-runner bootstrap + privacy-boundary RLS isolation   | Stand up the runner on the highest risk and prove cross-circle reads return nothing                        | #1, #2 (read path) | integration                | complete      | context/changes/testing-privacy-rls-isolation/              |
| 2   | API authorization + input-validation contract            | Prove endpoints reject non-owners, non-connected invites, and malformed payloads with the correct status   | #2, #4             | integration                | complete      | context/changes/testing-api-authz-validation/               |
| 3   | Conflict-overlap & 24h expiry logic                      | Prove a clash surfaces before confirm and a stale invitation expires                                       | #3, #5             | unit + integration         | complete      | context/archive/2026-06-09-testing-conflict-overlap-expiry/ |
| 4   | Secret isolation + quality-gates wiring + north-star e2e | Lock the floor: key-isolation check, CI gates, one e2e of the full co-care flow incl. the conflict warning | #6, cross-cutting  | static check + gates + e2e | change opened | context/changes/testing-secret-isolation-gates-e2e/         |

**Status vocabulary** (fixed — parser literals): `not started` → `change opened` → `researched` → `planned` → `implementing` → `complete`.

AI-native note: Phase 4 includes one deterministic **Playwright e2e** of the north-star flow because the conflict warning renders in `.astro` frontmatter and integration tests cannot see the rendered UI. **When NOT to use:** do not add multimodal / vision review — the surface is plain deterministic DOM and CSS selectors suffice; do not e2e every page, only the single co-care flow.

## 4. Stack

The classic test base for this project. AI-native tools (if any) carry a
`checked:` date so future readers can see which lines need re-verification.

| Layer                         | Tool                                                                | Version  | Notes                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| unit + integration            | none yet — see §3 Phase 1 (Vitest is the Astro-native default)      | n/a      | No test runner, config, or test deps exist today; Phase 1 bootstraps it                                                                                                                                                              |
| DB integration harness        | local Supabase via `npx supabase start` + `npm run db:reset`        | existing | Already used for manual RLS proofs (`supabase/tests/*.md`); Phase 1 automates these                                                                                                                                                  |
| API mocking                   | edge-only (mock the external HTTP boundary, never internal modules) | n/a      | Prefer real local Supabase over mocking the DB client                                                                                                                                                                                |
| e2e                           | Playwright (`@playwright/test`)                                     | ^1.60.0  | Standalone config (`playwright.config.ts`), own `webServer` (build+preview) + storageState `setup` project; north-star co-care flow only; canonical model `tests/e2e/seed.spec.ts` (+ `tests/e2e/E2E-RULES.md`); checked: 2026-06-15 |
| static secret-isolation check | Vitest unit test (`tests/unit/secret-isolation.test.ts`)            | existing | Both vectors (import-graph + env-schema), no deps — pure static file inspection; runs in the `unit` Vitest project; checked: 2026-06-15                                                                                              |

If a row reads "none yet — see Phase N", that gap is addressed by the named rollout phase.

**Stack grounding tools (current session):**

- Docs: none (Context7 not available in current session) — relied on local `package.json` (Astro 6, React 19, `@supabase/ssr`, Cloudflare adapter) and AGENTS.md conventions; checked: 2026-06-02
- Search: Exa.ai (available, not used in this pass) — reserve for verifying current Vitest/Playwright-on-Astro setup during Phase 1 research; checked: 2026-06-02
- Runtime/browser: Playwright MCP not available, but the `wrangler` / `cloudflare` / `workers-best-practices` skills are present for Worker test guidance; Playwright is feasible as a dev dependency for the Phase 4 e2e; checked: 2026-06-02
- Provider/platform: no Supabase/GitHub MCP server — Supabase is driven via local CLI + SQL; GitHub Actions CI already exists (`.github/workflows/ci.yml`, lint + build) and is the wiring target for §5 gates; checked: 2026-06-02

## 5. Quality Gates

The full set of gates that must pass before a change reaches production.
"Required after §3 Phase N" means the gate is enforced once that rollout
phase lands; before that, the gate is `planned`.

| Gate                             | Where                                                    | Required?                                              | Catches                                                |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| lint + typecheck                 | lint: local + CI; typecheck: local (pre-push) + CI build | required (already wired in `.github/workflows/ci.yml`) | syntactic / type drift                                 |
| unit + integration               | unit: local + CI; integration: local (pre-merge)         | required after §3 Phase 1                              | RLS / logic regressions                                |
| e2e on the co-care critical flow | local (pre-merge)                                        | required after §3 Phase 4                              | broken north-star user path / missing conflict warning |
| static secret-isolation check    | local (pre-push) + CI                                    | required after §3 Phase 4                              | service-role key reaching a client/request path        |
| post-edit hook                   | local (agent loop)                                       | optional (Module 3 Lesson 3)                           | regressions at edit time                               |
| pre-prod smoke                   | between merge + prod                                     | optional                                               | environment-specific failures (cron, Worker secrets)   |

Every row corresponds to a gate that either is wired or will be wired by a named rollout phase.

## 6. Cookbook Patterns

How to add new tests in this project. Each sub-section is filled in once
the relevant rollout phase ships; before that, the sub-section reads
"TBD — see §3 Phase N."

### 6.1 Adding a unit test

- TBD — see §3 Phase 3 (conflict-overlap math is the first pure-logic unit under test).

### 6.2 Adding an integration test (RLS / Supabase)

Integration tests run against **local Supabase with RLS actually on** — never a
mocked client (a mock proves nothing about a policy).

- **Location**: `tests/integration/*.test.ts`. Shared client factories live in
  `tests/helpers/supabase.ts`. Run with `npm test` (Vitest, `node` env). The
  local stack must be up (`npx supabase start`) and seeded (`npm run db:reset`).
- **Env**: keys come from `.env.test` (gitignored) — `SUPABASE_URL`,
  `SUPABASE_KEY` (anon), `SUPABASE_SERVICE_ROLE_KEY`. Populate from
  `npx supabase status`. Helpers read `process.env` and **never** import
  `astro:env/server` or `src/lib/supabase.ts` (virtual modules that only resolve
  inside the Astro/Vite build).
- **Act as a real user**: `signInAs(email, password)` → `{ client, userId }`
  builds an anon client, signs in over HTTP, and asserts the session resolves to
  a non-null id. Use the seeded identities (all share password `test1234`):
  Alice `…a01`, Bob `…b01` (accepted FC w/ Alice), Carol `…c01` (pending FC),
  Dave `…d01` (unconnected). `serviceClient()` bypasses RLS — use it only for
  fixture setup/teardown, never to assert isolation.
- **Silent-pass guard (mandatory)**: a query with no identity makes every RLS
  branch false and returns **zero rows** — indistinguishable from correct
  isolation. So before trusting any zero-row assertion, (1) assert
  `userId === <expected uuid>`, and (2) add a positive self-visibility control
  (e.g. the actor sees their own row). Reference: `parents-isolation.test.ts`.
  Keep a no-session negative-control test that documents the zero-rows behaviour
  so the trap is visible, not hidden.
- **Expectations from the scenario, not the SQL**: derive expected counts from
  the behaviour (`an unconnected parent sees zero`), captured in the
  `supabase/tests/*-rls.md` proof docs — never by re-reading the policy USING
  clause (that is a tautology).
- **Cross-table / multi-row fixtures**: build them with the SECURITY DEFINER RPC
  (e.g. `create_meeting_with_invitations`) or service_role inserts — supabase-js
  has no multi-statement transaction. Filter assertions by the created row's id
  (not bare `count(*)`) so a parallel test file can't perturb counts, and tear
  the fixture down in `afterAll` via `serviceClient()`. Reference:
  `meetings-isolation.test.ts`.

### 6.3 Adding an e2e test

E2e is the **most expensive** layer — reserve it for a rendered-UI risk no
cheaper layer can see (here: the conflict warning renders in `.astro`
frontmatter, invisible to integration). One durable spec covers the north-star
co-care flow; do not e2e every page (§3 AI-native note).

- **Location & model**: `tests/e2e/*.spec.ts`, standalone `playwright.config.ts`
  with its own `webServer`. Run with `npm run test:e2e`. The **canonical model**
  to copy is `tests/e2e/seed.spec.ts` (a complete, runnable test of Risk #3, not a
  sketch); the seven durable rules it embodies live in `tests/e2e/E2E-RULES.md`.
  New specs reproduce what the seed shows.
- **Prerequisites**: `npx playwright install chromium` once per machine/CI (the
  browser binary is **not** installed automatically — `npm run test:e2e` fails
  with a missing-executable error until you do). Local Supabase must be up
  (`npx supabase start`) and seeded (`npm run db:reset`), and `.dev.vars` must
  hold `SUPABASE_URL` / `SUPABASE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` — the
  `webServer` (`npm run build && npm run preview`) serves the same **workerd
  preview** the app uses, which reads `.dev.vars`. The config sets a generous
  `webServer.timeout` (workerd's first compile is slow); wait on state, never a
  fixed sleep.
- **Auth via storageState — never log in through the UI (rule 7)**: a separate
  `setup` project (`tests/e2e/auth.setup.ts`), wired as a `dependencies` of the
  chromium project so it runs once first, signs each seeded parent in over **HTTP**
  (`request.post('/api/auth/signin', { form, headers:{ Origin }, maxRedirects:0 })`,
  assert `302 → /`; a `302 → /auth/signin?error=` means bad creds → fail loudly so
  no spec runs anonymous) and persists the cookie jar to `tests/e2e/.auth/<user>.json`.
  Specs consume it: `test.use({ storageState: BOB_AUTH })` drives the browser as the
  receiving parent; the creator acts through an `APIRequestContext` built from her
  own jar (`request.newContext({ storageState: ALICE_AUTH })`).
- **Fixture setup over the API, not the UI**: create meetings with
  `POST /api/meetings` (`Origin` header set) through the creator's API context —
  reserve the browser for the parts that genuinely need it (the hydrated accept
  click and the rendered-warning assertion). Don't type through the UI for setup.
- **Locators (rules 1–2)**: `getByRole` / `getByLabel` / `getByText` are primary;
  `getByTestId` only for a role-less container with no accessible name (the
  `pending-invitation` `<li>` row). Never CSS / XPath. The accept button is reached
  by `getByRole("button", { name: /accept/i })`; the conflict warning by
  `getByText(/overlaps/i)` (its copy is "…this overlaps with:"), not a test-id.
- **`client:visible` hydration (rule 4)**: the accept button hydrates only when
  scrolled into view. `scrollIntoViewIfNeeded()` then wait for actionability
  (`toBeEnabled()`) — never `page.waitForTimeout()`. Accepting fires a POST then
  reloads, so wrap the click in `page.waitForResponse(...respond...)` and re-query
  the row after the reload (web-first assertions auto-retry).
- **Control assertion (silent-pass discipline, §6.4)**: a selector that never
  matches passes a "warning renders" test vacuously. Pair the positive assertion
  with a control — assert the warning is **absent** on the second pending row
  before the first invite is accepted, then **present** once accepting the first
  puts an overlapping meeting on the schedule. Make overlap deterministic: both
  meetings share one `starts_at` + default 60-min duration → a guaranteed clash
  (`overlaps` is half-open `[start,end)`; back-to-back does not overlap).
- **Unique data + per-test cleanup (rule 6)**: tag fixture rows with a per-run
  marker (`crypto.randomUUID()`) so re-runs and parallel files can't collide, and
  delete every meeting the test created in `afterEach` (creator `DELETE
/api/meetings/<id>` → 204, FK-cascades the invitations). Clean up by tracked id —
  not a global `public.meetings` wipe.
- **Seed identities**: Alice (`alice@example.com`) / Bob (`bob@example.com`) are an
  accepted friend-connection (the pair to use); all seeded users share password
  **`test1234`**.

### 6.4 Adding a test for a new API endpoint

API-route tests exercise the **real HTTP path** — a running SSR server, real
cookie-authenticated users over `fetch`, RLS actually on. They never import a
route handler (the handler imports `astro:env/server`, a virtual module that only
resolves inside the Astro/Vite build — see §6.2). Builds on §6.2's fixture and
teardown rules.

- **Location**: `tests/integration/api/*.test.ts`. The HTTP cookie-jar helper is
  `tests/helpers/http.ts`; DB fixture/teardown + side-effect checks reuse
  `serviceClient()` from `tests/helpers/supabase.ts`. References:
  `tests/integration/api/authz.test.ts` (authz/IDOR),
  `tests/integration/api/validation.test.ts` (zod + error-mapping).
- **Harness**: a Vitest `globalSetup` (`tests/setup/server.ts`) runs `astro build`
  once, spawns `astro preview` on a known port, and polls a real route until ready
  before any test runs (workerd accepts the socket before routes compile, so a TCP
  probe is not enough; `build` must precede `preview` or stale routes are served).
  `hookTimeout`/`testTimeout` are raised to absorb first-request compile. The
  server is torn down in the returned teardown even if a test throws. `npm test`
  is self-contained — no manual server start.
- **Act as a real user over HTTP**: `signInOverHttp(email, password) → Jar` POSTs
  form-encoded credentials to `/api/auth/signin` with `Origin` set and redirects
  **not** followed, asserts `302 → /` (a `302 → /auth/signin?error=…` means bad
  credentials → throws loudly, never proceeds with an anonymous jar), and captures
  **every** `Set-Cookie` (Supabase-SSR may chunk a session across
  `sb-…-auth-token.0/.1`). The jar replays the `Cookie` header on every request:
  `jar.fetch(path, init)`, `jar.json(path, init) → {status, body}`,
  `jar.postJson(path, data)`. One independent jar per user, so two users run in one
  test. `anonymousJar()` is the no-cookie negative control.
- **Authz pattern (Risk #2)**: for a mutate-by-id route, RLS filters a non-owner's
  target row to null → the route returns **404, not 403**. So a deny test must run
  against a **real fixture row** owned by someone else (build it in `beforeAll` via
  `create_meeting_with_invitations` or `serviceClient()` inserts; capture the ids;
  tear down in `afterAll`) — never a random UUID. Every deny case needs a **paired
  owner-success control** on the same route (a non-owner 404 and a no-session 404
  are indistinguishable — the HTTP silent-pass guard). Cover the unauth case too:
  one no-cookie call per method → **401**. The create-route connection precondition
  is its own arm: inviting a non-connected (or pending-FC, not accepted) parent →
  **403**; inviting a connected friend → **201**.
- **Assertion convention**: assert **HTTP status + DB side-effect** (the side-effect
  read via `serviceClient()`: status flipped, `responded_at` stamped, row gone).
  Assert error **bodies only where load-bearing** — do not pin per-route divergent
  zod strings (`zod message` vs hardcoded `"invalid id"`). The one body that is
  contract is `meetings/index.ts`'s mapped error strings (see below) and
  `friends/search`'s `{found}` shape.
- **errcode over message-string oracle (Risk #4, the F1 guard)**: only
  `meetings/index.ts` maps RPC failures by **message string** before its SQLSTATE
  fallback — that string is fragile (a renamed `raise` text silently breaks the
  branch). Pin it on **both** paths: assert the mapped status/body on the
  message-string path (e.g. non-connected invitee → 403), and confirm the SQLSTATE
  fallback still yields the right status if the message text changes. For every
  mapped failure, assert the body is the **safe mapped string** — no SQLSTATE code,
  no `relation`/`constraint` text, no raw Postgres message (the anti-leak
  assertion). The errcode → HTTP-status table is the durable spec (see research.md
  §"DB-side test oracle"): `42501`→403, `22023`→400, `23514`→400, `23505`→422/409.

### 6.5 Adding a test for a new RLS policy or SECURITY DEFINER helper

Builds on §6.2 (same harness, helpers, and guards). Extra rules specific to a
policy or definer under test:

- **One assertion per matrix arm**: prove the policy GRANTS where it should AND
  DENIES where it should. A deny-only test passes against a policy that returns
  nothing for everyone; a grant-only test passes against one that leaks to all.
  The `parents` matrix is the template: accepted → visible, pending → visible
  (via `parents_select`'s pending branch), unconnected → invisible.
- **Encode the subtle distinctions as first-class assertions**. "Two faces of
  connected" — `parents_select` exposes a pending FC, but `list_my_friends()`
  (accepted-only) does not — is the kind of behaviour a coarse test misses.
  Pin it with explicit `.toContain` / `.not.toContain`. Reference:
  `parents-isolation.test.ts`.
- **Cross-table policies that reference each other** route through SECURITY
  DEFINER helpers (`user_is_meeting_invitee` / `user_is_meeting_creator`) to
  break Postgres's infinite-recursion guard. Assert the SELECT **returns without
  error** (a recursion regression surfaces as a 500, not a wrong count) in
  addition to the 1/1/0 count. Reference: `meetings-isolation.test.ts`.
- **Reuse the `supabase/tests/*-rls.md` SQL proofs as the behavioural spec**
  (the source of expected counts), not as the oracle to copy from the policy
  body. When a new seed fixture shifts a count, update those docs too — the
  fixture is shared state (see §6.6).

### 6.6 Per-rollout-phase notes

(Optional. After each phase lands, `/10x-implement` appends a 2–3 line note here capturing anything surprising the phase taught.)

- **Phase 1 (testing-privacy-rls-isolation).** The seed (`supabase/seed.sql`) is
  **shared state**: adding Carol/Dave + a pending FC to support the isolation
  matrix shifted counts the manual `supabase/tests/*-rls.md` proofs assert, which
  had to be reconciled in lockstep (e.g. Alice's `parents` view 2→3; the
  "outsider sees 0 FC" block re-pointed to Dave). When you extend the fixture,
  re-run every proof block and update its expected count — don't assume.
- **Loginable `auth.users` need empty-string token columns.** Raw inserts leave
  GoTrue's token columns NULL, which passes service_role reads but fails
  `signInWithPassword` with "Database error querying schema". Stamp
  `encrypted_password` AND coalesce every token column to `''` (see
  `context/foundation/lessons.md`). Verify with a real login, not a service read.
- **Docker-VM clock skew.** Right after Docker Desktop boots, the VM clock can
  sit ahead of the host, so a freshly minted JWT's `iat` is "in the future" and
  PostgREST rejects it (`PGRST303 "JWT issued at future"`). It is environmental,
  not a test bug — resync with `docker run --rm --privileged alpine hwclock -s`
  and re-run.
- **Phase 2 (testing-api-authz-validation).** Three things this phase taught:
  (1) **Cookie replay needs `maxRedirects:0`.** The signin route answers `302`
  with the `Set-Cookie`; following the redirect to `/` drops the header context,
  so the helper POSTs with redirects disabled and captures every `set-cookie`
  (Supabase-SSR chunks large sessions across `sb-…-auth-token.0/.1`). (2) **The
  HTTP silent-pass trap.** A non-owner 404 and a no-session 404 are
  indistinguishable, so every authz test asserts `302 → /` at signin AND pairs a
  deny case with an authenticated owner-success control — an anonymous jar that
  silently 404s everywhere would otherwise "pass". (3) **Build before serve.**
  `astro preview` serves the last `astro build`; globalSetup must build first and
  poll a real route (not just TCP) for readiness, or it serves stale/uncompiled
  routes. **Caution:** the preview subprocess inherits stderr (so startup failures
  surface), and workerd reads `.dev.vars` incl. `SUPABASE_SERVICE_ROLE_KEY` — on a
  startup error that console output could contain bound secrets, so never paste a
  raw `npm test` log into a shared issue / CI artifact without scrubbing.
- **Known latent leak: unmapped `23503` → raw-500 in `POST /api/meetings`.**
  `meetings/index.ts` maps `23505`/`23514`/`42501`/`22023` but not `23503` (FK
  violation), so a parent deleted mid-transaction would fall through to the raw-500
  branch and leak a Postgres message. The sibling `friends/request.ts` _does_ map
  `23503`→404. Documented, **not fixed** here (the parent-deleted-mid-tx race is
  impractical to trigger deterministically; a fix is its own change). The
  generalizable rule — map every errcode an RPC can raise or it falls through to a
  raw-500 leak — is captured in `context/foundation/lessons.md`.
- **Phase 4 (testing-secret-isolation-gates-e2e).** Three things this phase
  settled: (1) **The secret check is a regression-lock, not a fix** — Risk #6
  isolation already held, so `tests/unit/secret-isolation.test.ts` pins **both**
  vectors (import-graph: only `src/worker.ts` may import `supabase-admin`;
  env-schema: `SUPABASE_SERVICE_ROLE_KEY` stays out of `astro.config.mjs`). The
  import scan is allow-list shaped (assert the importer set equals
  `{ src/worker.ts }`) so a new top-level leak path fails closed. (2) **CI stays
  deliberately light** — only `vitest run --project unit` runs in CI (no Supabase,
  no preview server), so the Phase-2 `.dev.vars`-echo-in-logs caution is moot for
  CI; integration + e2e remain local/pre-merge gates and the secret check also runs
  on pre-push. (3) **The e2e proves _rendering_, not behavior coverage** — it
  asserts the conflict warning renders on an overlapping invite (with an absence
  control); it is not a substitute for the integration conflict-math/authz suites.

## 7. What We Deliberately Don't Test

Exclusions agreed during the rollout (Phase 2 interview, Q5). Future
contributors should respect these unless the underlying assumption changes.

- **Starter auth scaffold** (sign-in / sign-up / sign-out from 10x-astro-starter) — trusted template code, not project-authored. Re-evaluate if auth is customised (e.g. social login, password-reset flows, or a change to the `on_auth_user_created` trigger). (Source: Phase 2 interview Q5.)
- **shadcn/ui primitives** (`src/components/ui/`) — vendored; the upstream library is the test. Re-evaluate only if a primitive is forked and given project-specific logic.
- **Friend-request / invitation flooding (resource abuse)** — deferred from the risk map; low blast radius for an MVP among already-known friends. Re-evaluate if the product opens connection requests beyond known contacts or adds email/push side-effects per request.
- **Service-role key rotation** — an ops action, not a test. Tracked as an open security to-do (the key is currently exposed); Phase 4 tests the key's _isolation_, not its rotation.

## 8. Freshness Ledger

- Strategy (§1–§5) last reviewed: 2026-06-02
- Stack versions last verified: 2026-06-02
- AI-native tool references last verified: 2026-06-02

Refresh (`/10x-test-plan --refresh`) when:

- a new top-3 risk surfaces from the roadmap or archive,
- a recommended tool's `checked:` date is older than three months,
- the project's tech stack changes (new framework, new test runner),
- §7 negative-space no longer matches what the team believes.
