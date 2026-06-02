---
project: AppiTata
version: 1
status: draft
created: 2026-05-25
updated: 2026-06-02
prd_version: 1
main_goal: speed
top_blocker: time
---

# Roadmap: AppiTata

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline (2026-05-25).
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

Parents already have friends they trust; what they lack is a low-effort way to coordinate mutual childcare with those specific people. AppiTata replaces ad-hoc text threads with a small set of deliberate primitives — explicit friend connection, a created meeting, an invitation that must be accepted (and that warns about clashes before it is). The MVP succeeds when one parent runs the full co-care loop end-to-end with a real friend; the secondary signal is that the same parent later grows a circle of three or more connected friends.

## North star

**S-03: A parent accepts a meeting invitation (with conflict warning) and the confirmed meeting appears in both parents' lists.** This is the closing slice of PRD §Success Criteria Primary — the step where the contract is actually proven, and the only point at which the "no silent double-booking" guardrail is exercised end-to-end. Its named prerequisite is S-02 (create + invite), so "ship the north star" in practice means "ship S-02 then S-03".

> "North star" here means the smallest end-to-end slice whose successful delivery proves the core product hypothesis — placed as early as Prerequisites allow because everything else only matters if this works.

## At a glance

| ID   | Change ID                             | Outcome (user can …)                                                              | Prerequisites | PRD refs                                      | Status |
| ---- | ------------------------------------- | --------------------------------------------------------------------------------- | ------------- | --------------------------------------------- | ------ |
| F-01 | parents-profile-and-rls-foundation    | (foundation) every domain table FKs to `parents`; RLS pattern enforces privacy    | —             | FR-001, NFR §Privacy boundary, Access Control | done   |
| S-01 | friend-connection-handshake           | search a parent by email/phone, request → accept/decline, see connected friends   | F-01          | US-02, FR-001, FR-002, FR-003, FR-004, FR-005 | done   |
| S-02 | meeting-creation-and-invite           | create a meeting (date, time, structured address, description) and invite friends | F-01, S-01    | US-01 (partial), FR-006, FR-007               | done   |
| S-03 | meeting-accept-with-conflict-and-list | accept/decline an invitation (with conflict warning) and see upcoming/past list   | F-01, S-02    | US-01 (completes), FR-008, FR-009, FR-010     | done   |
| S-04 | invitation-expiry-cron-backstop       | never see a stale invitation past 24h — expiry is sweep-enforced, not only lazy   | F-01, S-03    | FR-008 (hardening)                            | done   |

## Baseline

What's already in place in the codebase as of 2026-05-25 (auto-researched + user-confirmed). Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present — Astro 6.3.1 + React 19 islands, Tailwind 4, shadcn/ui scaffold (`src/components/ui/`). Auth pages (`/auth/{signin,signup,confirm-email}`) and a placeholder `/dashboard.astro` exist.
- **Backend / API:** partial — Astro SSR (`output: "server"`), only three POST endpoints under `src/pages/api/auth/`. `zod` is declared in `package.json` but is not yet imported in handlers (AGENTS.md convention: validate every API payload with `zod`).
- **Data:** absent — `@supabase/{ssr,supabase-js}` clients are installed and `supabase/config.toml` exists, but `supabase/migrations/` does not exist and zero domain tables are referenced from `src/`. README explicitly states "no DB tables required" because only `auth.users` is consumed today.
- **Auth:** present — Supabase SSR client in `src/lib/supabase.ts:9`; `src/middleware.ts` populates `context.locals.user` and redirects unauthenticated requests off `PROTECTED_ROUTES=["/dashboard"]`. FR-001 (account login with email + password) is delivered by this scaffold and therefore has no dedicated slice — it is referenced from F-01 (which extends it with the `parents` profile trigger).
- **Deploy / infra:** partial — Cloudflare Workers wired (`@astrojs/cloudflare` 13.5, `wrangler.jsonc`); the live app was first deployed manually via `wrangler deploy` (commit 2db9727 — see `context/foundation/infrastructure.md`). CI (`.github/workflows/ci.yml`) lints + builds on push/PR to `master` but has no deploy step. Adding deploy-on-merge is parked, not roadmapped.
- **Observability:** absent — no logging library, no error tracking, no health-check endpoint, no structured logging anywhere in `src/`. Not gated by any PRD NFR; parked, not roadmapped.

## Foundations

### F-01: parents profile and Supabase RLS pattern

- **Outcome:** (foundation) every parent who signs up has a corresponding row in a domain `parents` table linked to `auth.users`; every later domain table FKs to `parents.id`; a reusable RLS policy template enforces the "visible only to me and to my connected friends" rule that every later table will inherit.
- **Change ID:** parents-profile-and-rls-foundation
- **PRD refs:** FR-001 (extends the existing auth scaffold), NFR §Privacy boundary, §Access Control (multi-user, flat roles)
- **Unlocks:** S-01 (needs `parents` to FK from `friend_connections`), S-02 (needs `parents` to FK from `meetings`/`meeting_invitations`), S-03 (RLS template is what makes accept-time visibility correct end-to-end). Also unlocks the verification path "an INSERT from one parent is invisible to a non-connected parent" used by every later slice.
- **Prerequisites:** —
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** —
- **Risk:** The only NFR (privacy boundary) is wholly carried by this foundation. Getting the RLS template wrong silently leaks private data — and it only becomes visible after two parents and one connection exist, which is not until S-01 ships. Verify the template with two seeded parents and one connection row before declaring F-01 done.
- **Status:** done

## Slices

### S-01: A parent connects with another parent

- **Outcome:** a parent can search for another parent by email or phone, send a friend request, accept or decline an incoming request, and see their list of connected friends.
- **Change ID:** friend-connection-handshake
- **PRD refs:** US-02, FR-001 (authenticated session is a usage prerequisite), FR-002, FR-003, FR-004, FR-005
- **Prerequisites:** F-01
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Should phone search match on exact normalized E.164 only, or also accept partial / un-normalized input? — Owner: user. Block: no (default exact-E.164 for MVP; revisit if real friends complain).
- **Risk:** This slice introduces the `friend_connections` table that S-02's invite-picker filters against. If the connection-state model is wrong (e.g., bidirectional vs directional rows) the meetings slice has to reshape it. Pick a shape compatible with "given parent A, list all B such that A and B are connected" in one query.
- **Status:** done

### S-02: A parent creates a meeting and invites connected friends

- **Outcome:** a parent can create a meeting with a date, time, structured place address, and description, and invite one or more of their connected friends.
- **Change ID:** meeting-creation-and-invite
- **PRD refs:** US-01 (partial — creation + invitation half), FR-006, FR-007
- **Prerequisites:** F-01, S-01
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Which fields make up the "structured address" beyond street / city / postal code / country? — Owner: user. Block: no (default to those four free-text fields for MVP; revisit if a real address fails to fit).
- **Risk:** The meeting created here is the row S-03's accept-with-conflict logic reads against. The shape of the time field (single `starts_at` vs `starts_at` + `duration_minutes`) determines how FR-009's overlap test in S-03 can be expressed — settle this in S-02's `/10x-plan`, not deferred into S-03.
- **Status:** done

### S-03: A parent accepts a meeting invitation (with conflict warning) and sees upcoming/past meetings

- **Outcome:** a parent can accept or decline a meeting invitation; on accept, if the meeting time overlaps an existing meeting on their schedule a conflict warning is shown before they confirm; an unanswered invitation auto-expires after 24 hours on read; confirmed meetings appear in both parents' upcoming-meetings list, separated into upcoming and past.
- **Change ID:** meeting-accept-with-conflict-and-list
- **PRD refs:** US-01 (completes), FR-008, FR-009, FR-010
- **Prerequisites:** F-01, S-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Does FR-009's "overlap" mean point-in-time identical-start, or interval-overlap given an assumed duration? — Owner: user. Block: no (default to interval-overlap with `duration_minutes = 60` if S-02 chose `starts_at + duration`; otherwise identical-start. Pick consistently with S-02.).
- **Risk:** This slice closes the only guardrail in PRD §Success Criteria ("no silent double-booking"). The lazy-expiry strategy for FR-008 (filter expired on read) is correct for any user-visible read path but leaks against direct DB queries — that gap is addressed in S-04 and noted here only so the launch posture is conscious.
- **Status:** done

### S-04: 24h invitation expiry cron backstop

- **Outcome:** invitations that no one ever opens still expire — a Cloudflare Cron Trigger sweeps expired invitations daily, so FR-008's "auto-expires after 24 hours" holds even for never-read rows. Closes the "lazy expiry leak" flagged in `infrastructure.md` §Risk Register.
- **Change ID:** invitation-expiry-cron-backstop
- **PRD refs:** FR-008 (hardening)
- **Prerequisites:** F-01, S-03
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Cron cadence — every 6 h vs daily? `infrastructure.md` suggests daily for free-tier comfort. — Owner: user. Block: no (default daily; tighten if the user complains about a long stale window).
- **Risk:** This slice is the only post-north-star work in the roadmap. Under `main_goal: speed` it is shippable but not launch-gating — the Primary flow does not depend on it. Genuinely skippable for the first ship if `mvp_weeks: 3` runs hot; mark it `Status: done` only after a real expired-but-unopened invitation is observed to be cleared by the cron run.
- **Status:** done

## Backlog Handoff

| Roadmap ID | Change ID                             | Suggested issue title                                                  | Ready for `/10x-plan` | Notes                                                      |
| ---------- | ------------------------------------- | ---------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------- |
| F-01       | parents-profile-and-rls-foundation    | Foundation: parents profile + Supabase RLS pattern                     | yes                   | Run `/10x-plan parents-profile-and-rls-foundation`         |
| S-01       | friend-connection-handshake           | Friend connection handshake (request / accept / decline / list)        | no                    | Becomes ready when F-01 is `done`                          |
| S-02       | meeting-creation-and-invite           | Create a meeting and invite connected friends                          | no                    | Becomes ready when S-01 is `done`                          |
| S-03       | meeting-accept-with-conflict-and-list | Accept meeting invitation (with conflict warning) + upcoming/past list | no                    | North star. Becomes ready when S-02 is `done`              |
| S-04       | invitation-expiry-cron-backstop       | 24h invitation expiry cron backstop                                    | no                    | Becomes ready when S-03 is `done`. Optional for v1 launch. |

## Open Roadmap Questions

None — PRD §Open Questions is empty and no cross-cutting question was surfaced during framing. Per-slice unknowns live in their respective slice bodies above and are non-blocking.

## Parked

- **Proactive availability-matching** — Why parked: PRD §Non-Goals (intended v2 evolution of the conflict-check rule; MVP is reactive).
- **In-app messaging / chat** — Why parked: PRD §Non-Goals (out of MVP surface; AppiTata coordinates meetings, not conversations).
- **Visual calendar grid** — Why parked: PRD §Non-Goals (MVP presents meetings as a date-sorted list; calendar grid deferred).
- **Social login** — Why parked: PRD §Non-Goals (MVP sign-in is email + password only).
- **CI auto-deploy to Cloudflare Workers** — Why parked: `main_goal: speed` posture — current CI lints + builds; manual `wrangler deploy` is acceptable for the first ship per `infrastructure.md` §Operational Story. Revisit post-launch when manual deploys become friction.
- **Observability (Sentry / Cloudflare Observability MCP)** — Why parked: no PRD NFR demands it; `infrastructure.md` notes the MCP server is opt-in "if log analysis becomes a recurring task". Revisit after the first real-user incident.
- **Per-meeting duration as a first-class user input** — Why parked: PRD FR-006 lists date, time, structured address, description — duration is not in scope. A default duration may be picked by `/10x-plan` for S-02/S-03 internally without exposing it to the user.
- **Blocking decline of friend requests** — Why parked: PRD FR-004 chose accept/decline without block as the MVP minimum; blocking is a v2 concern.

## Done

- **F-01: (foundation) every parent who signs up has a corresponding row in a domain `parents` table linked to `auth.users`; every later domain table FKs to `parents.id`; a reusable RLS policy template enforces the "visible only to me and to my connected friends" rule that every later table will inherit.** — Archived 2026-05-27 → `context/archive/2026-05-26-parents-profile-and-rls-foundation/`. Lesson: —.
- **S-01: a parent can search for another parent by email or phone, send a friend request, accept or decline an incoming request, and see their list of connected friends.** — Archived 2026-05-28 → `context/archive/2026-05-27-friend-connection-handshake/`. Lesson: —.
- **S-02: a parent can create a meeting with a date, time, structured place address, and description, and invite one or more of their connected friends.** — Archived 2026-05-29 → `context/archive/2026-05-28-meeting-creation-and-invite/`. Lesson: —.
- **S-03: a parent can accept or decline a meeting invitation; on accept, if the meeting time overlaps an existing meeting on their schedule a conflict warning is shown before they confirm; an unanswered invitation auto-expires after 24 hours on read; confirmed meetings appear in both parents' upcoming-meetings list, separated into upcoming and past.** — Archived 2026-06-01 → `context/archive/2026-05-29-meeting-accept-with-conflict-and-list/`. Lesson: —.
- **S-04: invitations that no one ever opens still expire — a Cloudflare Cron Trigger sweeps expired invitations daily, so FR-008's "auto-expires after 24 hours" holds even for never-read rows. Closes the "lazy expiry leak" flagged in `infrastructure.md` §Risk Register.** — Archived 2026-06-02 → `context/archive/2026-06-01-invitation-expiry-cron-backstop/`. Lesson: —.
