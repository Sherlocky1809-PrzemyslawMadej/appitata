# 24h Invitation Expiry Cron Backstop — Plan Brief

> Full plan: `context/changes/invitation-expiry-cron-backstop/plan.md`

## What & Why

FR-008 says an unanswered meeting invitation expires after 24 hours — but today nothing enforces it. The `expired` enum value exists and is never written; the `/meetings` read path and the accept endpoint both gate only on `status = 'pending'` with no time check. This slice (roadmap S-04) makes the 24h expiry real for **every** invitation, including ones no parent ever opens, closing the "lazy-expiry leak" flagged in `infrastructure.md`.

## Starting Point

S-02/S-03 shipped the meetings + invitations tables, the accept/decline flow, and the three-section `/meetings` page. `invited_at` (the 24h basis) is stored and selected but unused for expiry. The app deploys as a Cloudflare Worker with no `scheduled()` handler and no service-role Supabase client.

## Desired End State

A daily Cloudflare Cron Trigger sweeps stale `pending` invitations to `expired` via a privileged DB function. Independently, the read and accept paths enforce the same 24h cutoff, so a stale invitation is never shown in Pending and can't be accepted even between sweeps — FR-008 holds at all times, not just at cron granularity.

## Key Decisions Made

| Decision            | Choice                                                           | Why (1 sentence)                                                                                            | Source |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| Sweep mechanism     | Cloudflare Cron Trigger → SECURITY DEFINER RPC                   | Matches the decision already recorded in infrastructure.md and exercises the lesson's deploy story          | Plan   |
| FR-008 scope        | Cron sweep **+** close the read/accept gap                       | Lazy-expiry-on-read was never actually implemented, so a strict guard is needed for a must-have requirement | Plan   |
| Cadence             | Daily (03:00 UTC)                                                | infrastructure.md's free-tier recommendation; ample once the read guard covers the user-visible path        | Plan   |
| Background-job auth | New `SUPABASE_SERVICE_ROLE_KEY` secret + `service_role`-only RPC | Standard Supabase background-job posture; secret stays Worker-only and human-gated                          | Plan   |

## Scope

**In scope:** sweep RPC `expire_stale_invitations()`; tightened `meeting_invitations_update` RLS guard; custom `src/worker.ts` entrypoint with `scheduled()`; daily cron in `wrangler.jsonc`; service-role client + secret wiring; 24h read filter in `meetings.astro`.

**Out of scope:** queues/retry infrastructure; multi-region scheduling; any `expired`-state UI; `pg_cron`; CI `wrangler dev` gating; changes to the meetings tables or create/list RPCs.

## Architecture / Approach

Daily Cron Trigger → `scheduled()` on the Worker → service-role supabase-js client → `rpc("expire_stale_invitations")` → single indexed `UPDATE pending→expired` past the cutoff (idempotent, logs count). In parallel, RLS (`invited_at > now() - 24h` in the update policy) and the page read filter enforce the cutoff for the user-facing paths.

## Phases at a Glance

| Phase                      | What it delivers                                                                         | Key risk                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1. DB sweep + accept guard | Migration: `expire_stale_invitations()` RPC + tightened update policy; regenerated types | Default `EXECUTE to PUBLIC` must be revoked so only `service_role` can sweep                    |
| 2. Cron worker entrypoint  | `src/worker.ts` (`fetch`+`scheduled`), daily cron, service-role client + secret          | Repointing `main` must preserve middleware/auth/assets — regression-verify under `wrangler dev` |
| 3. Read-path guard (UI)    | `meetings.astro` hides >24h-old pending invites                                          | Trivial; must agree with the server-side 404 guard                                              |

**Prerequisites:** F-01, S-03 (both done); local Supabase stack (Docker); a Cloudflare account for the deploy step (human-gated).
**Estimated effort:** ~1–2 sessions across 3 phases.

## Open Risks & Assumptions

- The custom worker entrypoint is the only structural change to how the app is served — its regression check (middleware redirect still works) is the gate before relying on it.
- The service-role key is a powerful secret; it must never reach client code or the request path. Production secret is set by hand, not by the agent.
- Daily cadence means up to ~24h of DB-level staleness for never-read rows — invisible to users because the read/accept guard covers the user-facing paths.

## Success Criteria (Summary)

- A pending invitation older than 24h is never shown in Pending and returns 404 on accept.
- The daily sweep flips never-opened stale invitations to `expired` and logs the count (visible in `wrangler tail`).
- The web app still serves and redirects correctly through the new entrypoint.
