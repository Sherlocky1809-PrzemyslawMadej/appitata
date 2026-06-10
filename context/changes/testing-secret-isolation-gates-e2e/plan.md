# Phase 4 — Secret Isolation, Quality-Gate Wiring & North-Star E2E Implementation Plan

## Overview

Final rollout phase of `context/foundation/test-plan.md`: lock the testing floor for AppiTata. Three deliverables plus a doc reconciliation:

1. A **forward regression-lock** on the Supabase service-role key (Risk #6) — a static unit test asserting the key cannot reach a client/request path, covering **both** isolation vectors.
2. **Quality-gate wiring** — a light CI gate (unit + secret-check) and a fast pre-push gate (secret-check + typecheck), keeping integration/e2e as local/pre-merge gates.
3. One durable **Playwright e2e** of the north-star co-care flow that asserts the conflict warning renders.
4. **Test-plan reconciliation** so §4/§5/§6 stop describing gates that don't run.

## Current State Analysis

- **Risk #6 isolation already holds.** `createAdminClient(env)` ([src/lib/supabase-admin.ts:18-28](../../../src/lib/supabase-admin.ts#L18)) reads `env.SUPABASE_SERVICE_ROLE_KEY` from the Worker binding (never `astro:env/server`), and is imported by exactly one file: [src/worker.ts:3](../../../src/worker.ts#L3) (the cron entrypoint). The key is deliberately **absent** from the `astro.config.mjs` `env.schema` (which declares only `SUPABASE_URL` / `SUPABASE_KEY`). So the static check is a _regression lock_, not a fix.
- **Two independent isolation vectors.** (a) the **import graph** — anything under `src/components/**`, `src/pages/**`, `src/lib/**` (except itself), `src/middleware.ts` importing `supabase-admin` would breach it; (b) the **env schema** — adding `SUPABASE_SERVICE_ROLE_KEY` to `astro.config.mjs` would make it request-reachable even without importing `supabase-admin`. A complete check guards both.
- **CI is lint + build only.** [.github/workflows/ci.yml](../../../.github/workflows/ci.yml) runs `npm ci → astro sync → lint → build`. No test step, no Supabase. The 10 test files from Phases 1–3 (1 unit + 9 integration) have **never run in CI**.
- **Vitest has two projects** ([vitest.config.ts](../../../vitest.config.ts)): `unit` (node env, `tests/unit/**`, no server/DB, sub-second) and `integration` (globalSetup spawns build+preview, needs local Supabase, serial). `vitest run --project unit` runs the fast suite without ever building/serving Astro.
- **`.husky/pre-push` runs `npm run typecheck` only.** `.husky/pre-commit` runs lint-staged (eslint --fix + prettier).
- **Playwright is not a project dependency** — present only inside the untracked `.verify-evidence/node_modules`. `.gitignore` has no `test-results/` / `playwright-report/` entries.
- **The e2e is fully specified with a working reference.** `[data-testid="conflict-warning"]` at [PendingInvitationsList.tsx:82](../../../src/components/meetings/PendingInvitationsList.tsx#L82); accept/decline test-ids at lines 95–116; `<li data-testid="pending-invitation">` rows. [.verify-evidence/phase-3/verify.mjs](../../../.verify-evidence/phase-3/verify.mjs) drives the exact flow — reuse as the spec template (it uses the **wrong password** `password123!`; the seed is `test1234`).
- **Seed identities** ([supabase/seed.sql](../../../supabase/seed.sql)): Alice `…a01` / Bob `…b01` are an **accepted** friend-connection (the pair to use), all password `test1234`. No seeded meetings — the e2e creates them at runtime and wipes `public.meetings` first.

## Desired End State

- A CI run on every PR/push to `master` runs lint + build (as today) **plus** the unit suite, which includes a secret-isolation test that fails the build if either vector breaks.
- `git push` runs the secret-isolation test + typecheck locally before code leaves the machine.
- `npm run test:e2e` builds, serves, and drives one Playwright spec that proves the conflict warning renders on Bob's overlapping pending invitation; it is documented as the local pre-merge gate for the north-star flow.
- `context/foundation/test-plan.md` §4/§5/§6 accurately describe where each gate runs.

### Key Discoveries:

- The secret check must pin **both** vectors — import-site **and** env-schema — not just imports ([research.md](research.md) §"Risk #6"; AGENTS.md admin-client rule).
- `vitest run --project unit` is the CI-portable entrypoint for the secret test — no Supabase, no server, no CRLF sensitivity ([vitest.config.ts](../../../vitest.config.ts)).
- Light CI means the **workerd `.dev.vars`-echo leak risk dissolves**: CI never spawns the preview server (only `unit` runs), so the Phase-2 warning about secrets in CI logs does not apply to this configuration.
- The conflict `<div>` is **server-rendered** and assertable without hydration; only the accept _click_ needs `client:visible` hydration (scroll-into-view + wait) ([research.md](research.md) §"Hydration timing").
- `overlaps` is half-open `[start,end)` — equal `starts_at` + default 60-min duration guarantees an overlap; back-to-back does not ([src/lib/conflicts.ts](../../../src/lib/conflicts.ts)).

## What We're NOT Doing

- **Not rotating the service-role key** — ops to-do (test-plan §7); this phase tests _isolation_ only.
- **Not standing up Supabase in CI** — integration + e2e stay local/pre-merge per the cost×signal decision; CI runs only unit + the existing lint/build.
- **Not adding integration or e2e to pre-push** — pre-push stays fast (secret-check + typecheck); integration/e2e are manual local gates.
- **No multimodal / vision review** of the e2e — deterministic DOM/test-id selectors only (test-plan §3).
- **No e2e of any page** other than the single north-star co-care flow.
- **Not adding an ESLint `no-restricted-imports` rule** — the unit test covers both vectors; a second mechanism was deliberately declined.
- **Not tracking `.verify-evidence/`** — untracked scratchpad (MEMORY); the durable e2e lives under `tests/e2e/`.
- **Not fixing the latent `23503`→raw-500 leak** in `meetings/index.ts` — documented in test-plan §6.6, its own change.

## Implementation Approach

Four phases, each independently verifiable. Phase 1 (the cheapest, highest-leverage regression-lock) lands first and is provable in isolation. Phase 2 wires it into CI + pre-push. Phase 3 adds the heavier e2e harness independently. Phase 4 reconciles the doc once all gates exist and their homes are known.

## Critical Implementation Details

- **The secret test reads files statically — it must not import `astro:env/server` or the admin module.** It reads source text from disk (the import-graph scan) and parses `astro.config.mjs` as text/AST for the schema-absence assertion. Importing the admin client would defeat the point and may not resolve in the node test env.
- **Import-vector scan must be allow-list shaped, not deny-list shaped.** Assert that the set of files importing `@/lib/supabase-admin` (or the relative path) equals exactly `{ src/worker.ts }`. A naive "no imports under src/components" misses new top-level dirs; scanning all of `src/**` and allow-listing the one legitimate importer fails closed when a new leak path appears.
- **E2e determinism levers** (research §"Determinism levers"): API-driven fixture setup over UI typing; equal `starts_at` to guarantee overlap; `maxRedirects:0` on signin (a `302 → /` means success, `302 → /auth/signin?error=` means bad creds → fail loudly); `scrollIntoViewIfNeeded` + wait for `client:visible` hydration before the accept click; wipe `public.meetings` at spec start for a clean slate.
- **Silent-pass discipline carries to e2e** (test-plan §6.4): asserting the warning _renders_ is only meaningful paired with a control — assert the warning is **absent** before the overlapping second meeting exists (or on a non-overlapping invite), so a selector that never matches can't pass green.

## Phase 1: Secret-Isolation Unit Test

### Overview

A static test that fails if a future edit lets the service-role key reach a client/request path, via either vector. Runs in the existing `unit` Vitest project.

### Changes Required:

#### 1. Secret-isolation test

**File**: `tests/unit/secret-isolation.test.ts` (new)

**Intent**: Statically prove the two Risk #6 invariants so a regression fails the unit suite. No real key, no server, no DB — pure file inspection.

**Contract**: Two assertions.

- **Import vector**: scan all source files under `src/**` for an import of the admin module (`@/lib/supabase-admin` or any relative path resolving to `src/lib/supabase-admin.ts`); assert the set of importers equals exactly `{ src/worker.ts }`. Fail with the offending file list if any other file imports it.
- **Env-schema vector**: read `astro.config.mjs` as text and assert it does **not** contain `SUPABASE_SERVICE_ROLE_KEY`. (The anon path declares only `SUPABASE_URL` / `SUPABASE_KEY`.)

Use Node `fs`/`path` + a glob or recursive read of `src/**/*.{ts,tsx,astro}`. Both assertions live in one test file; prefer two named `it()` blocks so a failure names which vector broke.

#### 2. Convenience script

**File**: `package.json`

**Intent**: Add a `test:unit` script so CI and pre-push invoke the fast suite by name.

**Contract**: `"test:unit": "vitest run --project unit"`. (Optionally also `"test:e2e"` is added in Phase 3.)

### Success Criteria:

#### Automated Verification:

- [ ] Secret-isolation test passes today (proves the invariant holds): `npm run test:unit`
- [ ] Test fails when a violation is introduced (temporarily add a `supabase-admin` import in a `src/lib/*` scratch file, confirm red, revert) — proves the test bites
- [ ] Full unit suite green: `npx vitest run --project unit`
- [ ] Typecheck passes: `npm run typecheck`
- [ ] Touched files lint clean: `npx eslint tests/unit/secret-isolation.test.ts`

#### Manual Verification:

- [ ] Failure message names which vector broke (import vs schema) and the offending file

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 2.

---

## Phase 2: CI + Pre-Push Gate Wiring

### Overview

Run the unit suite (incl. the secret check) in CI; run secret-check + typecheck on pre-push. CI stays light — no Supabase, no preview server — so the workerd `.dev.vars`-echo leak risk does not apply.

### Changes Required:

#### 1. CI unit-test step

**File**: `.github/workflows/ci.yml`

**Intent**: Add a unit-test step to the existing `ci` job so every PR/push runs the fast suite, including the secret-isolation regression-lock.

**Contract**: Add `- run: npm run test:unit` to the `ci` job steps. Placement after `npm run lint` and before/after `npm run build` is fine (no Supabase env needed — the unit project doesn't touch the DB). Do **not** add Supabase service setup or integration/e2e steps. No new secrets required.

#### 2. Pre-push hook

**File**: `.husky/pre-push`

**Intent**: Run the cheap regression-lock + typecheck before code leaves the machine, keeping push fast.

**Contract**: Prepend `npm run test:unit` to the existing `npm run typecheck` line (or run both). Do not add integration/e2e (kept as manual local gates). Husky pre-push runs the file's commands; non-zero exit blocks the push.

### Success Criteria:

#### Automated Verification:

- [ ] `npm run test:unit` exits 0 locally
- [ ] `npm run typecheck` exits 0
- [ ] CI workflow YAML is valid (no syntax error) — confirmed by a pushed run, or `npx --yes @action-validator/cli .github/workflows/ci.yml` if available
- [ ] A simulated pre-push runs both commands: `sh .husky/pre-push`

#### Manual Verification:

- [ ] A push to a branch triggers CI and the unit step appears green in the Actions tab
- [ ] `git push` is blocked when the secret test is made to fail (temporary violation), unblocked when reverted
- [ ] CI logs contain no secret values (sanity check — only `unit` runs, no preview server)

**Implementation Note**: Pause for manual confirmation (a real CI run is the proof) before Phase 3.

---

## Phase 3: North-Star E2E (Playwright)

### Overview

One durable Playwright spec of the co-care flow, asserting the conflict warning renders. Standalone `@playwright/test` with its own `webServer`. Hybrid fidelity: HTTP sign-in + API meeting setup, UI accept click, UI assertion of the warning.

### Changes Required:

#### 1. Playwright dependency + config

**File**: `package.json`, `playwright.config.ts` (new)

**Intent**: Add `@playwright/test` as a dev dependency and a config that builds+serves the app and runs the spec against it.

**Contract**: `playwright.config.ts` sets `testDir: "tests/e2e"`, a `webServer` block that runs the build+preview (e.g. command `npm run build && npm run preview`, `url` the preview origin, `reuseExistingServer: !process.env.CI`, generous `timeout` for workerd first-compile), `use.baseURL` matching, and `projects: [{ name: "chromium" }]`. Add `"test:e2e": "playwright test"` to `package.json` scripts. The webServer command must serve the same workerd preview the app uses (reads `.dev.vars`); requires local Supabase up.

**Contract note (browser binary)**: `@playwright/test` needs `npx playwright install chromium` once per machine/CI — document in the e2e cookbook (Phase 4); not run automatically.

#### 2. North-star spec

**File**: `tests/e2e/co-care-conflict.spec.ts` (new)

**Intent**: Port `.verify-evidence/phase-3/verify.mjs` into a durable, deterministic spec proving the conflict warning renders on an overlapping pending invitation.

**Contract**: One test, hybrid shape:

- Sign in Alice and Bob over HTTP via `request.post('/api/auth/signin', { form, headers:{Origin}, maxRedirects:0 })`, assert `302` + `location === '/'`; cookies persist on each browser context. **Password `test1234`** (fix the reference's `password123!` bug).
- Wipe `public.meetings` at start for a clean slate (via the same `docker exec … psql` probe pattern the reference uses, or a service-role delete) — see MEMORY for the local container name.
- Create meeting A (Alice → Bob) and an **overlapping** meeting B (same `starts_at`, default duration) via `POST /api/meetings`.
- **Control assertion**: before B exists (or on the first, non-overlapping invite), assert `conflict-warning` is **absent** on Bob's pending row (silent-pass guard).
- Bob loads `/meetings`, scrolls the accept button into view, waits for `client:visible` hydration, clicks accept on A; then with B pending, assert `[data-testid="conflict-warning"]` is present on B's `[data-testid="pending-invitation"]` row and its text contains "overlaps".

#### 3. Ignore generated artifacts

**File**: `.gitignore`

**Intent**: Keep Playwright output out of git.

**Contract**: Add `test-results/` and `playwright-report/` entries.

### Success Criteria:

#### Automated Verification:

- [ ] Browser installed: `npx playwright install chromium`
- [ ] E2e passes with local Supabase up: `npm run test:e2e`
- [ ] The conflict-warning assertion is load-bearing: temporarily make meeting B non-overlapping (offset `starts_at` past A's end), confirm the test **fails** (warning absent), then revert
- [ ] Touched files lint clean: `npx eslint tests/e2e/co-care-conflict.spec.ts playwright.config.ts`
- [ ] Typecheck passes: `npm run typecheck`

#### Manual Verification:

- [ ] Trace/screenshot on failure shows the rendered warning (Playwright `trace: "on-first-retry"` or a manual `--trace on` run)
- [ ] Spec is deterministic across 3 consecutive runs (no hydration-timing flake)
- [ ] No secret values appear in Playwright output/report

**Implementation Note**: Pause for manual confirmation (determinism across runs) before Phase 4.

---

## Phase 4: Test-Plan Doc Reconciliation

### Overview

Update `context/foundation/test-plan.md` so §4/§5/§6 describe where gates actually run after this phase.

### Changes Required:

#### 1. §5 Quality Gates — correct gate locations

**File**: `context/foundation/test-plan.md`

**Intent**: Replace the aspirational "required after Phase 1" claims with the real split.

**Contract**: Update the `Where` / `Required?` columns: `unit + integration` row → unit in **local + CI**, integration **local + pre-merge** (not CI); `e2e` row → **local pre-merge** (not CI on PR); `static secret-isolation check` row → **local (pre-push) + CI**. Keep the gate names; only correct location/enforcement wording.

#### 2. §4 Stack — fill the e2e + secret-check rows

**File**: `context/foundation/test-plan.md`

**Intent**: Record the now-chosen tools with a `checked:` date.

**Contract**: §4 `e2e` row → Playwright (`@playwright/test`, version from package.json), note "standalone config, own webServer, north-star flow only". §4 `static secret-isolation check` row → "Vitest unit test (`tests/unit/secret-isolation.test.ts`), both vectors, no deps".

#### 3. §6.3 Cookbook — write the e2e how-to

**File**: `context/foundation/test-plan.md`

**Intent**: Replace the "TBD — see Phase 4" stub with the durable pattern.

**Contract**: Document: location `tests/e2e/*.spec.ts`; `npm run test:e2e`; `npx playwright install chromium` prerequisite; local Supabase + `.dev.vars` required; the hybrid pattern (HTTP signin shortcut, API fixture setup, UI for the hydrated click + render assertion); the `client:visible` scroll+wait gotcha; the control-assertion (silent-pass) discipline; seed identities Alice/Bob `test1234`.

#### 4. §6.6 — append the Phase-4 note

**File**: `context/foundation/test-plan.md`

**Intent**: Capture what the phase taught (2–3 lines).

**Contract**: Note the key facts: the secret check is a regression-lock (both vectors), CI deliberately stays light (no Supabase) so the `.dev.vars`-echo risk is moot, and the e2e exists for _rendering_ not behavior coverage.

### Success Criteria:

#### Automated Verification:

- [ ] Markdown still parses / no broken table syntax (visual diff review)
- [ ] No references to gates that don't exist (grep the doc for "Phase 4" TBD stubs in §6.3 — none remain)

#### Manual Verification:

- [ ] §5 gate locations match the implemented CI + pre-push wiring
- [ ] §6.3 reads as a usable how-to for the next contributor

**Implementation Note**: Final phase — after confirmation, the change is ready to archive.

---

## Testing Strategy

### Unit Tests:

- `tests/unit/secret-isolation.test.ts` — the two-vector regression lock (Phase 1). Self-testing: must be shown to fail on an introduced violation.

### Integration Tests:

- None added — Phases 1–3 integration suite is unchanged; this phase only wires _when_ it runs.

### E2E (Playwright):

- `tests/e2e/co-care-conflict.spec.ts` — sign in → create overlapping meetings → accept → assert conflict warning renders, with an absence control.

### Manual Testing Steps:

1. Push a branch; confirm CI's unit step runs and is green.
2. Introduce a `supabase-admin` import in a throwaway `src/lib` file; confirm `git push` is blocked and CI would fail; revert.
3. Run `npm run test:e2e` three times with local Supabase up; confirm deterministic pass.
4. Make meeting B non-overlapping; confirm the e2e fails; revert.

## Performance Considerations

- The CI delta is one fast `vitest run --project unit` (sub-second suite) — negligible.
- Pre-push adds the same sub-second unit run to the existing typecheck — push stays fast.
- The e2e (build + workerd preview + browser) is minutes; deliberately kept off CI and pre-push.

## Migration Notes

- `npx playwright install chromium` is a one-time per-machine step (and would be per-CI-run if e2e ever moves to CI — out of scope now). Document it; don't automate.

## References

- Research: `context/changes/testing-secret-isolation-gates-e2e/research.md`
- Reference e2e driver: `.verify-evidence/phase-3/verify.mjs` (untracked; wrong password to fix)
- Test plan: `context/foundation/test-plan.md` (§2 Risk #6, §3 Phase 4, §5 gates, §6.3 cookbook)
- Admin client: `src/lib/supabase-admin.ts:18-28`; sole importer `src/worker.ts:3`
- Conflict warning: `src/components/meetings/PendingInvitationsList.tsx:82`
- Overlap math: `src/lib/conflicts.ts:24-49`
- Seed: `supabase/seed.sql` (Alice/Bob accepted, `test1234`)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Secret-Isolation Unit Test

#### Automated

- [x] 1.1 Secret-isolation test passes today (`npm run test:unit`)
- [x] 1.2 Test fails on an introduced violation, then reverted
- [x] 1.3 Full unit suite green (`npx vitest run --project unit`)
- [x] 1.4 Typecheck passes (`npm run typecheck`)
- [x] 1.5 Touched files lint clean (`npx eslint tests/unit/secret-isolation.test.ts`)

#### Manual

- [x] 1.6 Failure message names which vector broke (import vs schema) + offending file

### Phase 2: CI + Pre-Push Gate Wiring

#### Automated

- [ ] 2.1 `npm run test:unit` exits 0 locally
- [ ] 2.2 `npm run typecheck` exits 0
- [ ] 2.3 CI workflow YAML valid (pushed run or validator)
- [ ] 2.4 Simulated pre-push runs both commands (`sh .husky/pre-push`)

#### Manual

- [ ] 2.5 Branch push triggers CI; unit step green in Actions tab
- [ ] 2.6 `git push` blocked on a failing secret test, unblocked when reverted
- [ ] 2.7 CI logs contain no secret values

### Phase 3: North-Star E2E (Playwright)

#### Automated

- [ ] 3.1 Browser installed (`npx playwright install chromium`)
- [ ] 3.2 E2e passes with local Supabase up (`npm run test:e2e`)
- [ ] 3.3 Conflict-warning assertion is load-bearing (non-overlapping → test fails, then reverted)
- [ ] 3.4 Touched files lint clean
- [ ] 3.5 Typecheck passes

#### Manual

- [ ] 3.6 Trace/screenshot on failure shows the rendered warning
- [ ] 3.7 Deterministic across 3 consecutive runs
- [ ] 3.8 No secret values in Playwright output/report

### Phase 4: Test-Plan Doc Reconciliation

#### Automated

- [ ] 4.1 Markdown parses / no broken table syntax
- [ ] 4.2 No remaining "TBD — see Phase 4" stub in §6.3

#### Manual

- [ ] 4.3 §5 gate locations match implemented CI + pre-push wiring
- [ ] 4.4 §6.3 reads as a usable how-to
