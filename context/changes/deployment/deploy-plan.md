# AppiTata — First Production Deploy (Cloudflare Workers + Supabase Cloud)

## Context

This is the Plan-Mode deploy step from the 10xDevs Module 1 Lesson 5 workflow. `/10x-infra-research` just finished and produced [../../foundation/infrastructure.md](../../foundation/infrastructure.md) (untracked in git), which picked **Cloudflare Workers** as the MVP platform with **Render** as the runner-up. The app is the auth scaffold from `10x-astro-starter` — Astro 6 SSR on `@astrojs/cloudflare` v13, Supabase email/password auth, no domain tables yet (no friends/meetings/invitations).

The goal of this plan is the audit trail Plan Mode is meant to produce: an explicit human gate between "agent has a deploy plan" and "agent mutates production." Nothing in this plan runs until you approve.

**Confirmed inputs (from clarifying questions):**

- Cloudflare: nothing set up — full path including account creation + `wrangler login`
- Supabase: no cloud project — create one on supabase.com and capture URL + anon key
- CI: stays as-is (lint + build only). No deploy step added to `.github/workflows/ci.yml` this round
- Worker name: rename `10x-astro-starter` → `appitata` in `wrangler.jsonc`

**Out of scope (deferred):** Hyperdrive wiring (no Postgres pressure yet), Cron Trigger for FR-008 lazy-expiry (no `invitations` table yet), CI deploy job, custom domain, Supabase migrations / RLS (no domain tables exist).

**Plan storage:** This file (`context/changes/deployment/deploy-plan.md`) is the git-tracked audit trail of "what was supposed to happen." A working copy also lives in `~/.claude/plans/` for the active session.

---

## Prerequisites

All three sections below are setup work that must be complete before the deploy sequence starts. They're separated out because they're one-time-per-machine / one-time-per-project gates that the deploy itself shouldn't have to re-explain.

### P1. Local environment

- **Node v22.14.0** — pinned in [../../../.nvmrc](../../../.nvmrc). Verify with `node --version`; if you use `nvm-windows` or `volta`, switch to the pinned version. CI uses the same version, so dev/CI/prod stay aligned.
- **npm dependencies installed** — `npm install` if you haven't yet. `wrangler` v4.90.0 and the Supabase JS clients are already devDependencies in [../../../package.json](../../../package.json), so no global installs are needed.
- **Git** — assumed (repo is already a git repo).
- **Docker** — not required for this deploy. Only needed if you later run `npx supabase start` for local-DB development; the cloud project we'll create today doesn't need it.

### P2. Cloudflare account + `wrangler` CLI

**Why:** The deploy target is Cloudflare Workers; `wrangler` is the official CLI and is already in the project's devDependencies, so we use `npx wrangler` (no global install).

**Steps:**

1. **Create the account.** Open `https://dash.cloudflare.com/sign-up`, sign up with email, verify the address. The free tier covers Workers (100k requests/day, 10ms CPU per request) — comfortably enough for an MVP.
2. **Authenticate `wrangler` on this machine.** Two paths:

   **Path A — OAuth (recommended for interactive use):**

   ```powershell
   npx wrangler login
   ```

   A browser tab opens; approve the OAuth scope. The callback lands on `http://localhost:8976`.

   **Path B — API token (fallback if OAuth misbehaves on Windows, or for unattended use):**
   - Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token**
   - Use the **"Edit Cloudflare Workers"** template (grants Workers Scripts: Edit, Account: Read, User: Read — minimum needed to deploy)
   - Continue → Create → copy the token (shown once)
   - In PowerShell:
     ```powershell
     $env:CLOUDFLARE_API_TOKEN = "<paste-token>"
     ```
     This is session-scoped; for persistence, set it via System Environment Variables in Windows settings.

3. **Verify.**
   ```powershell
   npx wrangler whoami
   ```
   Should print your email and account ID. If it prints "You are not authenticated," repeat step 2.

### P3. Supabase account + cloud project

**Why:** Supabase provides Postgres + email/password auth. Even though no domain tables exist yet, the auth scaffold ([../../../src/lib/supabase.ts](../../../src/lib/supabase.ts), [../../../src/middleware.ts](../../../src/middleware.ts)) reads `SUPABASE_URL` and `SUPABASE_KEY` from `astro:env/server` and will silently no-op without them.

**Optional:** Supabase CLI. `supabase` is in devDependencies (v2.49.5), so `npx supabase ...` works without a global install. Useful for migrations once we add domain tables — **not required today**.

**Steps:**

1. **Create the account.** Open `https://supabase.com/dashboard`, sign up (GitHub OAuth is the fastest path). Free tier: 500 MB DB, 2 projects — fine for MVP.
2. **Create the project.**
   - Click **New Project**
   - Organization: Personal (default)
   - Name: `appitata`
   - **Database Password:** generate a strong one and save it to your password manager. Not used by the app (the anon key is what the app uses); you'll want it for `psql` debugging later.
   - **Region:** pick one geographically close. Workers run at the edge globally, but Postgres lives in one region. For EU, `eu-central-1` (Frankfurt) is a sensible default. Region is hard to change later.
   - Plan: Free
   - Click **Create new project** and wait ~2 min for provisioning.
3. **Capture credentials** (you'll paste these as Workers Secrets in step 3 of the sequence below).
   - Project sidebar → **Project Settings** → **API**
   - Copy two values to a scratchpad:
     - **Project URL** (e.g. `https://abcdefghij.supabase.co`) → will become `SUPABASE_URL`
     - **Project API keys → `anon` `public`** (long JWT starting with `eyJ...`) → will become `SUPABASE_KEY`
   - **Do NOT copy the `service_role` key.** That key bypasses Row-Level Security and is for server-to-server admin work only — it should never end up in code reachable from a browser, even in SSR. The `anon` key is the right one for an SSR app; RLS policies on the tables (once they exist) are what gate access per user.
4. **Add the redirect URL — DEFERRED until after first deploy.** Auth confirmation links need an allow-listed redirect, and the Worker URL isn't known until step 4 of the sequence runs. We come back to **Authentication → URL Configuration** and add `https://appitata.<your-subdomain>.workers.dev/**` once we have the subdomain.

---

## Sequence

### 0. Persist this plan into the repo — AGENT-EXECUTABLE

Create `context/changes/deployment/` and write this plan's contents to `context/changes/deployment/deploy-plan.md`. No commit yet — leaves the file untracked alongside the also-untracked `context/foundation/infrastructure.md` so you can review both and stage them together when ready.

### 1. Pre-flight: local workerd smoke test — AGENT-EXECUTABLE

```powershell
npm run build
npx wrangler dev
```

Open `http://localhost:8787`. Click `/`, `/auth/signin`, `/auth/signup`. Without secrets, `createClient` returns `null` ([../../../src/lib/supabase.ts:6](../../../src/lib/supabase.ts#L6)) and middleware sets `locals.user = null` ([../../../src/middleware.ts:6](../../../src/middleware.ts#L6)) — that's expected. The point is to catch any `workerd` runtime gap (`node:fs`, unsupported Node API) in the **current** build before touching the cloud. Ctrl+C when green.

### 2. Edit [../../../wrangler.jsonc](../../../wrangler.jsonc) — MANUAL GATE (single file, two lines)

| Line | From                                  | To                                    |
| ---- | ------------------------------------- | ------------------------------------- |
| 3    | `"name": "10x-astro-starter",`        | `"name": "appitata",`                 |
| 5    | `"compatibility_date": "2026-05-08",` | `"compatibility_date": "2026-05-23",` |

Leave the rest alone — `main`, `nodejs_compat`, the `ASSETS` binding, and `observability` are all already correct.

### 3. Set Workers Secrets — MANUAL GATE (interactive paste)

Using the `SUPABASE_URL` and `SUPABASE_KEY` you captured in prerequisite P3.3:

```powershell
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_KEY
```

Each command prompts for the value. **Watch for `\r\n` and surrounding quotes** — Windows clipboard is the classic foot-gun. The first `secret put` may auto-create the Worker if it doesn't exist yet; accept.

### 4. First deploy — AGENT-EXECUTABLE

```powershell
npm run build
npx wrangler deploy
```

Wrangler prints `https://appitata.<your-subdomain>.workers.dev`. **Save this URL** — and at this point, hop back into the Supabase dashboard to finish prerequisite P3.4: **Authentication → URL Configuration** → add `https://appitata.<your-subdomain>.workers.dev/**` to the allowed redirect URLs. Auth confirmation links will 404 until this is set.

### 5. Verification — MANUAL GATE

See the **Verification** section below.

### 6. Document rollback (do not run today) — AGENT-EXECUTABLE (read-only)

```powershell
npx wrangler deployments list
```

Note the current version ID. For future use, the rollback command is `npx wrangler rollback <VERSION_ID>`. Per [../../foundation/infrastructure.md](../../foundation/infrastructure.md), rollback reverts the Worker only — Supabase schema changes stay applied. Not relevant today (no schema yet), but worth knowing.

---

## Files modified

Only one file in the project is touched by the deploy sequence (step 2):

- [../../../wrangler.jsonc](../../../wrangler.jsonc) — `name` (line 3) and `compatibility_date` (line 5)

Plus one file created (step 0):

- `context/changes/deployment/deploy-plan.md` — the persisted plan (this file)

No edits to:

- [../../../astro.config.mjs](../../../astro.config.mjs) — env schema for `SUPABASE_URL` / `SUPABASE_KEY` is already correct
- [../../../src/middleware.ts](../../../src/middleware.ts) — already handles missing secrets gracefully
- [../../../src/lib/supabase.ts](../../../src/lib/supabase.ts) — already consumes `astro:env/server`
- [../../../.github/workflows/ci.yml](../../../.github/workflows/ci.yml) — manual deploy chosen; CI stays lint + build only

---

## Verification

Replace `<URL>` with the deployed `https://appitata.<your-subdomain>.workers.dev`. Run these in order; if any fails, stop and triage before continuing.

- [ ] `GET <URL>/` → 200, landing renders, no console errors.
- [ ] `GET <URL>/dashboard` (incognito, signed-out) → 302 to `/auth/signin`. Exercises [../../../src/middleware.ts:18-22](../../../src/middleware.ts#L18-L22). Pass = redirect.
- [ ] `<URL>/auth/signup` → submit a real email + password → Supabase confirmation email arrives.
- [ ] Click the confirm link → redirect handled, lands signed-in. (If this 404s, prerequisite P3.4 wasn't done — go back and add the Worker URL to Supabase's allowed redirects.)
- [ ] `<URL>/auth/signin` with same creds → reaches `/dashboard` (no redirect loop). Confirms both secrets are wired and the cookie round-trips. Pass = `/dashboard` 200.
- [ ] Sign out → `/dashboard` again redirects to `/auth/signin`. Pass = cookie cleared.
- [ ] In a second terminal during the flow: `npx wrangler tail` shows request lines for the URLs you just hit, no `Error` lines, no `exceeded CPU` warnings.

---

## Execution risks (narrowed to this run)

From the [../../foundation/infrastructure.md](../../foundation/infrastructure.md) risk register, the three most likely to bite during _this specific first deploy_:

1. **`wrangler login` browser OAuth fails on Windows.** Symptom: browser opens but the callback to `http://localhost:8976` hangs. Recovery: cancel and retry once; if still failing, switch to Path B (API token) from prerequisite P2.2 — `wrangler` picks up `$env:CLOUDFLARE_API_TOKEN` automatically and skips OAuth.

2. **Secret paste with trailing `\r\n` or surrounding quotes.** Symptom: deploy succeeds but every request 500s, or auth silently no-ops because `SUPABASE_URL` is literally `"https://....supabase.co\r"`. Recovery: re-run `npx wrangler secret put SUPABASE_URL` and paste cleanly (PowerShell right-click paste, not chord-paste from a wrapper terminal that injects `\r`).

3. **`workerd` catches a Node API that `astro dev` hid.** Symptom: build OK, deploy OK, runtime 500 on first request with a `TypeError` referencing `node:` or `unenv`. Step 1 (`wrangler dev`) is meant to surface this pre-deploy. Recovery: reproduce locally with `npx wrangler dev`, identify the offending dependency in the stack trace, swap for a Web-API-first equivalent or gate it behind a check. Fix forward — no prior good version to roll back to on a first deploy.
