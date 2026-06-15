# AppiTata

A co-care web app for parents: connect with friends you already know and trust, then schedule meetups and arrange mutual childcare. The trust gate is an explicit friend request/accept handshake — **AppiTata never matches strangers.**

**Live:** https://appitata.przemomad55.workers.dev

## What it does

- **Parents** sign in with email + password. Every surface sits behind auth — only sign-in / sign-up are reachable when logged out.
- **Friend connections** — find a parent by email or phone and send a friend request; the two connect only after the recipient explicitly accepts. Only connected parents can invite each other.
- **Meetings** — a parent creates a meeting (date, time, structured address, description) and invites one or more connected friends.
- **Invitations** — accept / decline; unanswered invitations expire after 24h. A meeting is confirmed only once an invited friend accepts.
- **Conflict check** — reactive, at accept-time: if the proposed time overlaps a meeting the invited friend already has, a conflict warning is shown before they confirm.

Two invariants hold for every feature that touches parent data:

1. **Privacy boundary** — a parent's meetings, friends list, and child details are visible _only_ to explicitly connected friends. Enforced in the database with Supabase RLS, not just UI filtering.
2. **No silent double-booking** — a time conflict is always surfaced before a meeting is confirmed; never hidden or silently resolved.

Full spec: [`context/foundation/prd.md`](context/foundation/prd.md). Agent/architecture guidance lives in [`AGENTS.md`](AGENTS.md).

## Tech Stack

- [Astro](https://astro.build/) v6 — server-first rendering (`output: "server"`, full SSR)
- [React](https://react.dev/) v19 — interactive islands
- [TypeScript](https://www.typescriptlang.org/) v5
- [Tailwind CSS](https://tailwindcss.com/) v4 + [shadcn/ui](https://ui.shadcn.com/) ("new-york" variant)
- [Supabase](https://supabase.com/) — auth + Postgres with row-level security
- [Cloudflare Workers](https://workers.cloudflare.com/) — edge deployment runtime (`workerd`)

## Prerequisites

- Node.js v22.14.0 (see `.nvmrc`)
- [Docker](https://www.docker.com/) (~7 GB RAM) for the local Supabase stack
- npm (comes with Node.js)

## Getting Started

1. Clone and install:

   ```bash
   git clone https://github.com/Sherlocky1809-PrzemyslawMadej/appitata.git
   cd appitata
   npm install
   ```

2. Start the local Supabase stack (downloads Docker images on first run):

   ```bash
   npx supabase start
   ```

3. Configure environment variables — copy `.env.example` to both `.env` (Node) and `.dev.vars` (Cloudflare local dev), then paste the credentials the CLI printed:

   ```
   SUPABASE_URL=http://127.0.0.1:54321
   SUPABASE_KEY=<anon key from `npx supabase start` output>
   ```

4. Run the dev server (Cloudflare `workerd` runtime, not plain Node):

   ```bash
   npm run dev
   ```

Local Supabase Studio is at `http://localhost:54323`. Stop the stack with `npx supabase stop`.

> **Email confirmation in local dev:** Supabase requires email confirmation before sign-in by default. To skip it locally, open Studio → **Authentication → Email → Confirm email** and toggle it off.

## Available Scripts

| Script              | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `npm run dev`       | Start dev server (Cloudflare `workerd` runtime)                              |
| `npm run build`     | Build for production                                                         |
| `npm run preview`   | Preview the production build                                                 |
| `npm run typecheck` | Type-check with `astro check`                                                |
| `npm run lint`      | Run ESLint with type-checked rules                                           |
| `npm run lint:fix`  | Auto-fix ESLint issues                                                       |
| `npm run format`    | Run Prettier (incl. `prettier-plugin-astro` + `prettier-plugin-tailwindcss`) |
| `npm run test`      | Run the full Vitest suite once                                               |
| `npm run test:unit` | Run the unit project only                                                    |
| `npm run test:e2e`  | Run Playwright E2E tests                                                     |
| `npm run db:reset`  | Drop the local DB, replay every migration, apply `supabase/seed.sql`         |
| `npm run db:types`  | Regenerate `src/db/database.types.ts` from the running local schema          |

> **Windows / CRLF note:** the repo has `core.autocrlf=true` with no `.gitattributes`, so a full `npm run lint` fails on pre-existing CRLF debt. On Windows, lint only the paths you touched (`npx eslint <files>`) or run `npm run lint:fix` first.

## Database

The data foundation covers parents, friend connections, and meetings, all behind Supabase RLS.

- **Migrations** live in `supabase/migrations/` (`YYYYMMDDHHmmss_short_description.sql`). Always enable RLS on new tables with granular per-operation, per-role policies.
- After adding a migration, re-run `npm run db:types` (do not hand-edit `src/db/database.types.ts`).
- The RLS template and the SECURITY DEFINER helper conventions (`is_connected`, cross-table visibility, atomic multi-table RPCs) are documented in [`AGENTS.md`](AGENTS.md) — read it before touching the schema.

## Routes

| Route                 | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| `/auth/signin`        | Email/password sign-in (reachable when logged out)             |
| `/auth/signup`        | Email/password sign-up (reachable when logged out)             |
| `/auth/confirm-email` | Post-signup "check your inbox" page                            |
| `/dashboard`          | Protected landing page                                         |
| `/meetings`           | Pending invitations (with conflict warnings) → Upcoming → Past |

Route protection lives in `src/middleware.ts` (`PROTECTED_ROUTES`).

## Deployment

Deployed to [Cloudflare Workers](https://workers.cloudflare.com/) (Worker name `appitata`, config in `wrangler.jsonc`). A daily Cron Trigger (`0 3 * * *`) runs the invitation-expiry sweep.

1. Build:

   ```bash
   npm run build
   ```

2. Deploy with Wrangler:

   ```bash
   npx wrangler deploy
   ```

The Worker needs three secrets — set them via `npx wrangler secret put <NAME>` or the Cloudflare dashboard:

- `SUPABASE_URL` — hosted project URL (`https://<ref>.supabase.co`)
- `SUPABASE_KEY` — `anon` public key (request path)
- `SUPABASE_SERVICE_ROLE_KEY` — service-role key (cron sweep; bypasses RLS)

The deploy that produced the live URL is recorded in [`context/deployment/deploy-plan.md`](context/deployment/deploy-plan.md); the platform decision and risk register are in [`context/foundation/infrastructure.md`](context/foundation/infrastructure.md).

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs lint + build on every push and PR to `master`. Configure `SUPABASE_URL` and `SUPABASE_KEY` as repository secrets for the build step.

## License

MIT
