---
project: AppiTata
researched_at: 2026-05-22
recommended_platform: Cloudflare Workers
runner_up: Render
context_type: mvp
tech_stack:
  language: TypeScript
  framework: Astro 6 (+ React 19)
  runtime: Cloudflare Workers (workerd)
---

## Recommendation

**Deploy on Cloudflare Workers.**

AppiTata is already scaffolded for Cloudflare (`@astrojs/cloudflare` v13.5 adapter, `wrangler.jsonc`, CI wired for the `SUPABASE_*` secrets) — picking anything else means swapping the Astro adapter and reworking the build. Cloudflare also wins on its own merits for this MVP: $0 at expected traffic (10k–100k req/mo sits inside the free tier — 100k req/day, 10ms CPU/invocation), GA MCP servers for observability and Workers, the strongest agent-readable docs of the six platforms researched (dedicated "Docs for agents" portal + `llms.txt` + `llms-full.txt`), and `wrangler` covers the full deploy / rollback / tail loop without a dashboard. The interview answers (single region, cost-vs-DX roughly equal, no platform familiarity) don't pull the decision away from the project's existing default.

## Platform Comparison

Scored against the five criteria in `references/agent-friendly-criteria.md`. No hard filter applied — PRD `has_realtime: false` plus the lazy-expiry plan for FR-008 means the "persistent connections = don't know" answer doesn't disqualify any serverless platform.

| Platform | CLI-first | Managed/Serverless | Agent docs | Deploy API | MCP / Integration | Score |
|---|---|---|---|---|---|---|
| **Cloudflare Workers** | Pass | Pass | Pass | Pass | Pass (GA) | **5 Pass** |
| **Render** | Pass | Pass | Pass | Pass | Pass (GA) | **5 Pass** |
| **Railway** | Pass | Pass | Pass | Pass | Pass (beta) | **5 Pass** |
| Vercel | Pass | Pass | Pass | Pass | Pass (beta) | 5 Pass |
| Netlify | Partial¹ | Pass | Pass | Pass | Pass (GA) | 4P / 1Pa |
| Fly.io | Pass | Pass | Partial² | Partial³ | Partial⁴ | 2P / 3Pa |

¹ Netlify rollback has no CLI command — needs the dashboard "Publish deploy" button.
² Fly publishes no `llms.txt` (community mirrors only).
³ Fly rollback isn't deterministic — redeploy an old image; config/secrets/migrations don't revert.
⁴ `fly mcp server` is explicitly experimental.

### Shortlisted Platforms

#### 1. Cloudflare Workers (Recommended)

Already the project's deployment target — zero migration. Free tier comfortably absorbs MVP traffic (100k req/day, 10ms CPU/invocation). Wrangler 4 covers `deploy`, `rollback`, `tail`, `deployments list` end-to-end. Hosts GA MCP servers (docs, Workers, observability). Cloudflare's `llms.txt` / "Docs for agents" portal is the best of the six. Tradeoff: the runtime is `workerd`, not Node — see the cross-check.

#### 2. Render

Persistent Node process via `@astrojs/node`, so none of the edge-runtime gaps. Render MCP is GA with 20+ structured tools (services, deploys, logs, metrics). REST API exposes a dedicated Rollback endpoint. Realistic MVP cost: ~$7/mo on Starter (the free tier's 30–60s cold starts on spin-down rule it out for production UX). The clean fallback if the workerd runtime or the serverless model itself proves wrong.

#### 3. Railway

The other persistent-Node PaaS. Railpack builder, good DX, full CLI loop (`up` / `redeploy` / `logs`). Railway MCP server exists (Aug 2025) but is **beta**. Single-region origin (no edge for SSR). Pricing: ~$5–15/mo usage-based. A real alternative to Render — different curve but same risk profile reduction vs Cloudflare.

(Vercel scored 5 Pass too but didn't make the top 3: its serverless model shares Cloudflare's main constraint class without the "already scaffolded" advantage, and the Hobby tier forbids commercial use.)

## Anti-Bias Cross-Check: Cloudflare Workers

### Devil's Advocate — Weaknesses

1. **`workerd` is not Node.** `@astrojs/cloudflare` v13 runs on `workerd`. Any dependency reaching for `node:fs`, a native addon, or a Node API not exposed via `nodejs_compat` fails — often only at runtime on the deployed Worker, not in `astro dev`.
2. **Supabase-from-the-edge is a moving part.** Connecting Workers to Supabase Postgres wants Hyperdrive, and the Supabase guide specifies the *direct* connection string, not the pooler. Misconfigure → connection exhaustion or latency.
3. **The 24h invitation expiry (FR-008).** `tech-stack.md` already conceded the edge runtime doesn't carry scheduled work first-class and the plan is "lazy expiry on read." Cron Triggers (GA) exist but a Cron Trigger is a separate Worker invocation with its own constraints.
4. **Pages → Workers mismatch.** `tech-stack.md` says `deployment_target: cloudflare-pages`, but adapter v13 *dropped Pages* — SSR now targets Workers. The "already scaffolded" advantage carries an asterisk.
5. **Local-dev fidelity gap.** `astro dev` runs on Vite/Node; production runs on `workerd`. Runtime-gap bugs are invisible in the local loop unless dev is deliberately run against the Workers runtime (`wrangler dev`).

### Pre-Mortem — How This Could Fail

The team deployed Astro 6 SSR on Cloudflare Workers for AppiTata's MVP. Six months later it was a mess. First crack: a friends-search feature pulled in a CommonJS-only library that used `node:fs` — it worked in `astro dev`, failed silently on the Worker as production-only 500s, and cost a weekend to trace. Then Supabase: Hyperdrive was wired with the pooled connection string instead of the direct one, so the meetings list intermittently timed out — invisible at 1 user, painful at 20. The 24h expiry shipped as "lazy expiry on read," but never-opened invitations never expired, quietly violating FR-008; a late Cron Trigger added a second buggy code path. None of this was strictly Cloudflare's fault — but a solo after-hours developer had picked the runtime with the most ways to diverge from a plain-Node mental model, and every divergence cost disproportionate time.

### Unknown Unknowns

- The foundation docs say "Pages," but you actually operate a **Worker** — Pages and Workers converged and adapter v13 dropped Pages.
- **`astro dev` doesn't run on `workerd`** — runtime-gap bugs surface only after a production 500 unless you deliberately exercise the Workers runtime locally with `wrangler dev`.
- The free tier is **CPU-metered** (10 ms CPU/invocation), not just request-metered — a heavy SSR render can blow the per-request CPU budget long before the request count.
- **Secrets aren't in `wrangler.jsonc`** — `SUPABASE_URL` / `SUPABASE_KEY` go through `wrangler secret put` (or `.dev.vars` locally). Mixing these up is a classic first-deploy stumble.
- `wrangler login` requires a browser one-time OAuth — fine on a dev laptop, awkward in CI; CI must use `CLOUDFLARE_API_TOKEN` env var instead.

## Operational Story

- **Preview deploys**: branch builds via **Workers Builds** (GitHub-integrated — connect the repo, every PR gets its own `*.workers.dev` preview URL). Ad-hoc: `npx wrangler versions upload` creates an unattached version with a preview URL without promoting it. Preview environments need their own `SUPABASE_*` secrets — either share with prod (acceptable at MVP since traffic is private) or wire a staging Supabase project per `wrangler.jsonc` environment.
- **Secrets**: `npx wrangler secret put SUPABASE_URL` and `npx wrangler secret put SUPABASE_KEY` — stored in Cloudflare's Workers Secrets vault, never in `wrangler.jsonc`. Local dev reads from `.dev.vars` (already in `.gitignore`). Read access: anyone with the Cloudflare account at the Worker scope. Rotation: re-run `wrangler secret put` (replaces on next deploy).
- **Rollback**: `npx wrangler rollback` reverts to the immediately-prior version (interactive prompt); `npx wrangler rollback <VERSION_ID>` for a specific one. Typical time-to-revert: <30 s. **Caveat**: rolling back the Worker does *not* revert Supabase schema changes — DB migrations stay applied. Keep migrations forward-compatible, or have a manual revert script ready before each migration.
- **Approval (human-only)**: initial Cloudflare account + API-token setup, first `wrangler secret put` of each secret, rotating `SUPABASE_KEY`, anything destructive on Supabase (drop table, DROP DATABASE). **Agent may run unattended**: `wrangler deploy`, `wrangler tail`, `wrangler rollback` to a prior version, `wrangler versions upload`.
- **Logs**: `npx wrangler tail` live-tails the Worker (filters: `--status`, `--method`, `--search`, `--sampling-rate`). Historical: Workers Logs in the Cloudflare dashboard or via the Observability MCP server (`https://observability.mcp.cloudflare.com/mcp`) for structured agent access — install with `claude mcp add cloudflare-observability --transport http https://observability.mcp.cloudflare.com/mcp` if log analysis becomes a recurring task.

## Risk Register

Each risk names the lens that surfaced it so the register is auditable.

| Risk | Source | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| A future dependency uses `node:fs` / native addons / unsupported Node API and fails only on production Worker | Devil's advocate | M | M | Before adding a dep, run `npx wrangler dev` locally to exercise it on workerd; check the dep for `node:fs` / native imports; prefer Web-API-first libraries. |
| Supabase via Hyperdrive misconfigured with the pooled connection string instead of the direct one | Pre-mortem · Unknown unknowns | M | H | Follow the Cloudflare Hyperdrive + Supabase guide exactly; use the *direct* connection string; verify under light load before merging the feature that needs Postgres. |
| FR-008 "lazy expiry" leaks: never-opened invitations never expire | Pre-mortem | M | M | Add a Cron Trigger (GA, free-tier eligible) that sweeps expired invitations daily as a backstop to lazy expiry; keep the check idempotent. |
| Foundation docs say "Pages," but the live deploy target is Workers — drift between `tech-stack.md` and reality | Devil's advocate | High (already true) | L | Update `tech-stack.md` `deployment_target` from `cloudflare-pages` to `cloudflare-workers` before the deploy plan is built. |
| `astro dev` hides workerd-only bugs until production | Unknown unknowns | M | M | Run `npx wrangler dev` as a pre-deploy gate (manual or as a CI step before `wrangler deploy`). |
| Per-request CPU budget (10 ms on free tier) exceeded by a heavy SSR render | Unknown unknowns | L | M | Profile the friends/meetings list rendering when the data set grows; if any page approaches 10 ms CPU, upgrade to the $5/mo Standard plan (much higher CPU ceiling). |
| Worker rollback doesn't revert Supabase migrations | Research finding | M | H | Keep migrations forward-compatible (additive only); for any destructive migration, write a forward-compatible revert before merging. |
| `wrangler login` requires browser — breaks unattended CI | Unknown unknowns | High (one-time) | L | Generate a scoped `CLOUDFLARE_API_TOKEN` ("Workers Scripts: Edit" + "User Details: Read") and set it as a GitHub Actions secret; never rely on `wrangler login` in CI. |

## Getting Started

Specific to this stack (`@astrojs/cloudflare` 13.5, `wrangler` 4.90, Astro 6 SSR, Supabase). The first-time deploy fits in five steps; everything after is `wrangler deploy`.

1. **Cloudflare account + scoped API token.** Create a Cloudflare account if needed. In the dashboard, create an API token with **Workers Scripts: Edit** + **Account: Read** permissions for this project only; copy `CLOUDFLARE_ACCOUNT_ID` from the dashboard sidebar. Save both as GitHub Actions secrets for CI.
2. **Authenticate Wrangler locally.** From `C:\Users\Przemek\10x-lesson-project`: `npx wrangler login` (browser OAuth, one-time). Verify with `npx wrangler whoami`.
3. **Set Workers Secrets.** `npx wrangler secret put SUPABASE_URL` then `npx wrangler secret put SUPABASE_KEY` — paste the values from your Supabase project (Settings → API). Secrets land in the Worker named in `wrangler.jsonc`.
4. **First deploy.** `npm run build && npx wrangler deploy`. Confirm the printed `*.workers.dev` URL serves the app, sign-in flow works, and `/dashboard` redirects to `/auth/signin` when unauthenticated (the middleware path).
5. **(Optional) Wire branch previews and observability.** Connect the GitHub repo in the Cloudflare dashboard → Workers Builds for automatic per-branch preview deploys. If log analysis becomes recurring, `claude mcp add cloudflare-observability --transport http https://observability.mcp.cloudflare.com/mcp` for structured log/metric access.

Pre-deploy discipline: run `npx wrangler dev` (not just `npm run dev`) at least once before each deploy that adds a new dependency — this catches workerd runtime gaps that `astro dev` hides.

## Out of Scope

The following were not evaluated in this research:
- Docker image configuration (Cloudflare Workers is serverless — no image)
- CI/CD pipeline setup beyond noting the `CLOUDFLARE_API_TOKEN` requirement
- Production-scale architecture (multi-region, HA, DR — MVP is single-region per the interview)
- Custom domain + DNS routing (post-MVP concern)
- Cost projections beyond MVP traffic (10k–100k req/mo)
