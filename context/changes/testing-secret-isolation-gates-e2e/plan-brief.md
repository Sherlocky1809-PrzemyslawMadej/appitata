# Phase 4 — Secret Isolation, Gates & North-Star E2E — Plan Brief

> Full plan: `context/changes/testing-secret-isolation-gates-e2e/plan.md`
> Research: `context/changes/testing-secret-isolation-gates-e2e/research.md`

## What & Why

Final phase of the test-plan rollout: lock the testing floor. Prove the Supabase service-role key can never reach a client/request path (Risk #6), wire the quality gates that have only ever existed on paper, and make one browser-level test of the north-star co-care flow durable so the conflict warning's rendering is protected from regression.

## Starting Point

Risk #6 isolation already holds — the admin key is read from the Worker `env` binding and imported by exactly one file (`src/worker.ts`), absent from `astro.config.mjs`. But CI is lint+build only: the 10 test files from Phases 1–3 have never run in CI, pre-push runs typecheck only, and Playwright isn't a dependency. The north-star flow has a working but throwaway reference driver in `.verify-evidence/`.

## Desired End State

Every PR runs the unit suite — including a static secret-isolation test that fails on either leak vector. `git push` runs that test + typecheck. `npm run test:e2e` builds, serves, and drives one Playwright spec proving the conflict warning renders on an overlapping invitation. The test-plan doc accurately states where each gate runs.

## Key Decisions Made

| Decision               | Choice                                          | Why (1 sentence)                                                            | Source   |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- | -------- |
| CI scope               | Unit + secret-check only (no Supabase in CI)    | MVP cost×signal — cheap leak-lock on every PR without Supabase-in-CI burden | Plan     |
| Secret-check mechanism | One Vitest unit test covering both vectors      | CI-portable, zero deps, no CRLF issue, both vectors in one place            | Research |
| E2e tooling            | Standalone `@playwright/test` + own `webServer` | Conventional, self-contained, official trace/retry tooling                  | Plan     |
| Pre-push composition   | secret-check + typecheck (keep push fast)       | Push stays seconds; integration/e2e are manual local gates                  | Plan     |
| E2e fidelity           | Hybrid: API setup, UI accept + render assert    | Deterministic fixtures while still exercising the hydrated click + warning  | Plan     |
| Test-plan doc          | Reconcile §4/§5/§6.3/§6.6                       | Stop the doc describing gates that don't run                                | Research |

## Scope

**In scope:** secret-isolation unit test (both vectors); CI unit step; pre-push wiring; one Playwright e2e; `.gitignore` + scripts; test-plan §4/§5/§6 reconciliation.

**Out of scope:** service-role key rotation; Supabase-in-CI; integration/e2e on CI or pre-push; ESLint import rule; tracking `.verify-evidence/`; the latent `23503`→raw-500 leak; vision review; e2e of any other page.

## Architecture / Approach

Four independently-verifiable phases: (1) the static two-vector secret test in the existing `unit` Vitest project; (2) wire it into CI (`npm run test:unit`) and `.husky/pre-push`; (3) a standalone Playwright spec with its own build+preview `webServer`, hybrid fidelity (HTTP signin + API meeting setup, UI accept click, UI warning assertion with an absence control); (4) reconcile the test-plan doc. Light CI means the preview server never runs in CI, so the workerd `.dev.vars`-echo leak risk dissolves.

## Phases at a Glance

| Phase                    | What it delivers                                   | Key risk                                                          |
| ------------------------ | -------------------------------------------------- | ----------------------------------------------------------------- |
| 1. Secret-isolation test | Two-vector regression lock + `test:unit` script    | A deny-list scan that misses a new leak path — use allow-list     |
| 2. CI + pre-push wiring  | Unit suite on CI; secret-check+typecheck on push   | Workflow YAML error; only provable by a real CI run               |
| 3. North-star e2e        | One Playwright spec asserting the conflict warning | `client:visible` hydration flake on the accept click              |
| 4. Doc reconciliation    | Accurate §4/§5/§6 in test-plan                     | Stale wording slipping through — verify against implemented gates |

**Prerequisites:** local Supabase up (`npx supabase start`) + `.dev.vars` for Phase 3; `npx playwright install chromium` once.
**Estimated effort:** ~2–3 sessions across 4 phases.

## Open Risks & Assumptions

- The e2e's hydration timing (`client:visible`) is the main flake source — mitigated by scroll-into-view + wait, proven by a 3-run determinism check.
- CI YAML correctness is only fully verified by a pushed run.
- Assumes the seed's Alice→Bob accepted FC and `test1234` password remain stable.

## Success Criteria (Summary)

- A service-role leak (either vector) fails the unit suite locally, on push, and in CI.
- The north-star e2e proves the conflict warning renders — and fails if it doesn't (load-bearing, verified by the non-overlapping control).
- `context/foundation/test-plan.md` describes the gates that actually run.
