# AGENTS.md

Single source of truth for AI agents (Claude Code, Cursor, Codex, etc.) working with code in this repository. `CLAUDE.md` imports this file — edit guidance here, not there.

## About AppiTata

A co-care web app for parents: connect with friends you already know and trust, then schedule meetups and arrange mutual childcare. The trust gate is an explicit friend request/accept handshake — AppiTata never matches strangers.

Core domain (greenfield — see **Current state**):

- **Parents** sign in with email + password; every surface sits behind auth (only sign-in/sign-up are reachable when logged out).
- **Friend connections** — find a parent by email or phone, send a friend request; the two connect only after the recipient explicitly accepts. Only connected parents can invite each other.
- **Meetings** — a parent creates a meeting (date, time, structured address, description) and invites one or more connected friends.
- **Invitations** — accept/decline; unanswered invitations expire after 24h. A meeting is confirmed only once an invited friend accepts.
- **Conflict check** — reactive, at accept-time: if the proposed time overlaps a meeting the invited friend already has, show a conflict warning before they confirm.

Full spec: `context/foundation/prd.md`. The `context/` directory holds the project's planning artifacts (PRD, shaping notes, tech-stack hand-off, bootstrap log); read it before non-trivial feature work. Never write to `context/archive/`.

### Load-bearing invariants

Both must hold for every feature that touches parent data:

1. **Privacy boundary** — a parent's meetings, friends list, and child details are visible *only* to explicitly connected friends; nothing is public or reachable across circles. Enforce in the database with Supabase RLS, not only in UI filtering.
2. **No silent double-booking** — a time conflict is always surfaced before a meeting is confirmed; never hide or silently resolve a clash.

### Current state

Only the auth scaffold from the 10x-astro-starter is built: email/password sign-in/up/out, protected-route middleware, and a placeholder `/dashboard`. The AppiTata domain — friends, meetings, invitations, conflict checking — does not exist yet, so expect to add Supabase tables, migrations, pages, and API routes.

## Commands

npm scripts live in `@package.json`. Two non-obvious details: `npm run dev` runs on the Cloudflare `workerd` runtime (not plain Node), and `npm run format` applies the `prettier-plugin-astro` and `prettier-plugin-tailwindcss` Prettier plugins.

Pre-commit hooks (husky + lint-staged) auto-run `eslint --fix` and `prettier --write` on staged files; config is in `@package.json`.

## Architecture

**Astro 6 SSR app** with React 19 islands, Tailwind 4, Supabase auth, and shadcn/ui components. Deployed to Cloudflare Workers.

### Rendering mode

Full server-side rendering (`output: "server"` in astro.config.mjs). All pages and API routes are rendered on-demand by default.

### Auth flow

- `src/lib/supabase.ts` — creates a Supabase SSR client using `@supabase/ssr` with cookie-based sessions. Uses `astro:env/server` for `SUPABASE_URL` and `SUPABASE_KEY` (server-only secrets declared in astro.config.mjs `env.schema`).
- `src/middleware.ts` — runs on every request, resolves the current user, attaches to `context.locals.user`. Redirects unauthenticated users away from routes listed in `PROTECTED_ROUTES`.
- API endpoints: `src/pages/api/auth/{signin,signup,signout}.ts`
- Auth pages: `src/pages/auth/{signin,signup,confirm-email}.astro`
- Protected page example: `src/pages/dashboard.astro`

### Key conventions

- **Path alias**: `@/*` maps to `./src/*` (tsconfig paths).
- **Astro components** for static content/layout; **React components** only when interactivity is needed.
- **Tailwind class merging**: use the `cn()` helper from `@/lib/utils` (clsx + tailwind-merge) for conditional/merged class names. Do not concatenate class strings manually.
- **shadcn/ui**: components live in `src/components/ui/`, "new-york" style variant. Install new ones with `npx shadcn@latest add [name]`.
- **API input validation**: validate request payloads (form data, JSON bodies) in `src/pages/api/` routes with `zod` schemas — never trust raw `formData()` / `request.json()` values.
- **Supabase migrations**: `supabase/migrations/` using naming format `YYYYMMDDHHmmss_short_description.sql`. Always enable RLS on new tables with granular per-operation, per-role policies.
- **React**: no Next.js directives ("use client" etc.). Extract hooks to `src/hooks/` (the `hooks` alias in `components.json`).
- **Services/helpers** go in `src/lib/` (or `src/lib/services/` for extracted business logic).
- **Shared types** (entities, DTOs) go in `src/types.ts`.

### Environment

- Node.js v22.14.0 (see `.nvmrc`)
- Env vars: `SUPABASE_URL`, `SUPABASE_KEY` (copy `.env.example` to `.env` for Node, or `.dev.vars` for Cloudflare local dev)
- Local Supabase: `npx supabase start` (requires Docker)
- Cloudflare local dev: secrets go in `.dev.vars` (gitignored)
- Deploy: `npx wrangler deploy` (requires Cloudflare account + `wrangler` auth)

## CI

GitHub Actions workflow (`.github/workflows/ci.yml`) runs lint + build on every push and PR to master. Requires `SUPABASE_URL` and `SUPABASE_KEY` repository secrets for the build step.
