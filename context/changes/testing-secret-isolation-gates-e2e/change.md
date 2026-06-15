---
change_id: testing-secret-isolation-gates-e2e
title: Secret-isolation static check, CI quality-gate wiring, and north-star co-care e2e
status: implemented
created: 2026-06-10
updated: 2026-06-15
archived_at: null
---

## Notes

Rollout Phase 4 (final) of `context/foundation/test-plan.md`: "Secret isolation + quality-gates wiring + north-star e2e".

Risks covered: **#6** (service-role/admin key leakage onto a client or request/log path), plus **cross-cutting** quality-gate wiring.

Test types planned: static secret-isolation check + CI quality gates + one Playwright e2e of the north-star co-care flow.

Risk response intent (from test-plan §2 Risk Response Guidance):

- **Risk #6** — prove the admin/service-role key is never imported onto a client or request-handling path. Cheapest layer is a deterministic static import/grep check, NOT a runtime test (avoid the anti-pattern of a test that needs the real service-role key to run). Key _rotation_ is explicitly out of scope (ops to-do in test-plan §7) — this phase tests _isolation_ only.
- **Cross-cutting** — wire the §5 quality gates (lint+typecheck and unit+integration already in CI; this phase adds the e2e gate and the secret-isolation gate) and make one Playwright e2e of the full co-care flow durable, asserting the conflict warning renders. Per §3: deterministic DOM/CSS selectors only — no multimodal/vision review, and e2e only the single co-care flow, not every page.
