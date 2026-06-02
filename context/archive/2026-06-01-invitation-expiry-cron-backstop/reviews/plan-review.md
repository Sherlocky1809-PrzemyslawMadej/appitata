<!-- PLAN-REVIEW-REPORT -->

# Plan Review: 24h Invitation Expiry Cron Backstop

- **Plan**: context/changes/invitation-expiry-cron-backstop/plan.md
- **Mode**: Deep
- **Date**: 2026-06-01
- **Verdict**: REVISE → SOUND (after fixes)
- **Findings**: 0 critical, 1 warning, 1 observation

## Verdicts

| Dimension             | Verdict |
| --------------------- | ------- |
| End-State Alignment   | PASS    |
| Lean Execution        | PASS    |
| Architectural Fitness | PASS    |
| Blind Spots           | PASS    |
| Plan Completeness     | WARNING |

## Grounding

7/7 paths ✓, symbols ✓ (`handle` export + signature, `meeting_invitations_update` policy, `invited_at`, partial index all confirmed against installed packages/migrations), brief↔plan ✓.

## Findings

### F1 — Worker typing assumes an `Env` / Cloudflare runtime types not in scope

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 2, change #2 (src/worker.ts) + criterion 2.3
- **Detail**: The entrypoint was typed `satisfies ExportedHandler<Env>`, but `Env`/`ExportedHandler`/`ExecutionContext`/`ScheduledController` are not in the project type scope (no `worker-configuration.d.ts`, no `@cloudflare/workers-types` dep; `src/env.d.ts` defines only `App.Locals`). The `handle` export and its `(request, env, context)` signature were verified present in v13.5. As written, criterion 2.3 ("type checking passes") would fail.
- **Fix A ⭐ Recommended**: Add a `npx wrangler types` step (new change #0) generating `worker-configuration.d.ts`; adjust criterion 2.3 to run after it.
  - Strength: Idiomatic; wrangler already a dep; makes the typed contract compile with full runtime globals.
  - Tradeoff: One setup step + commit/gitignore decision; secret-only vars not auto-typed in `Env`.
  - Confidence: HIGH — verified missing types directly.
  - Blind spot: Whether the generated d.ts needs an explicit tsconfig reference under astro strict.
- **Fix B**: Loosen worker.ts typing with a minimal local env interface.
- **Decision**: FIXED via Fix A — added Phase 2 change #0 (`wrangler types`), updated worker.ts contract to source `Env` from the generated d.ts and note the `SUPABASE_SERVICE_ROLE_KEY` is `string | undefined`, renumbered Phase 2 automated criteria (2.1 types-gen … 2.4 typecheck) and Progress (2.1–2.7).

### F2 — Plan doesn't say where to get the local service_role key

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2, change #4 (.dev.vars wiring)
- **Detail**: Phase 2 said add `SUPABASE_SERVICE_ROLE_KEY` to .dev.vars without naming the source (`npx supabase status`).
- **Fix**: Add the `npx supabase status` pointer to change #4.
- **Decision**: FIXED — pointer added to change #4 contract.
