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

1. **Privacy boundary** — a parent's meetings, friends list, and child details are visible _only_ to explicitly connected friends; nothing is public or reachable across circles. Enforce in the database with Supabase RLS, not only in UI filtering.
2. **No silent double-booking** — a time conflict is always surfaced before a meeting is confirmed; never hide or silently resolve a clash.

### Current state

The auth scaffold from the 10x-astro-starter (email/password sign-in/up/out, protected-route middleware, placeholder `/dashboard`) is in place. The data foundation now covers parents + friend connections + meetings: `public.parents` (1:1 with `auth.users` via the `on_auth_user_created` trigger; `display_name` + `phone` are populated from `raw_user_meta_data` at signup), `public.friend_connections` (directional `pending` / `accepted` / `declined` rows), and `public.meetings` + `public.meeting_invitations`. `public.is_connected(viewer, owner)` returns true when viewer = owner OR an accepted FC exists in either direction. Available RPCs: `public.find_parent_by_handle(handle)` searches parents by exact email (case-insensitive) or phone (digits + leading `+`), excluding the caller; `public.list_my_friends()` returns `(id, display_name)` for accepted-connected parents, excluding self; `public.create_meeting_with_invitations(starts_at, duration_minutes, street, city, postal_code, country, description, invitee_ids)` atomically inserts a meeting (creator = `auth.uid()`) plus one `pending` invitation per invitee, validating that every invitee is accepted-connected. The `parents_select` policy also exposes parents involved in a pending FC with the viewer, so domain queries that should return accepted-only parents must use `list_my_friends()` (or an equivalent `is_connected` filter) rather than a bare `SELECT FROM parents`. Meeting visibility is cross-table: a meeting is visible to its creator OR any invitee; an invitation row is visible to its invitee OR the meeting's creator (implemented via `public.user_is_meeting_invitee` / `public.user_is_meeting_creator` SECURITY DEFINER helpers — see §Key conventions). Meetings themselves are immutable after create — there is no UPDATE policy on `meetings`; the creator can DELETE a meeting (FK cascades to invitations). Accept/decline transitions on invitations are gated by a `meeting_invitations_update` RLS policy (one-shot, `pending → accepted|declined`), and `POST /api/meetings/invitations/respond` stamps a `responded_at` audit column via a column-level GRANT on `(status, responded_at)`. The `meeting_invitation_status` enum carries all four values (`pending` / `accepted` / `declined` / `expired`) from day one; the cron writer of `expired` lands in S-04. The `/meetings` page renders three sections (Pending invitations with inline conflict warning → Upcoming → Past, the latter two sourced from a unified creator-OR-accepted-invitee meetings query, with conflict math computed in the page frontmatter from the same dataset).

## Commands

npm scripts live in `@package.json`. Two non-obvious details: `npm run dev` runs on the Cloudflare `workerd` runtime (not plain Node), and `npm run format` applies the `prettier-plugin-astro` and `prettier-plugin-tailwindcss` Prettier plugins.

**DB dev loop** (requires Docker — `npx supabase start` brings up the local stack):

- `npm run db:reset` — drops the local DB, replays every migration in `supabase/migrations/`, then applies `supabase/seed.sql`.
- `npm run db:types` — regenerates `src/db/database.types.ts` from the running local schema. Re-run after every migration; do not hand-edit the file.

Pre-commit hooks (husky + lint-staged) auto-run `eslint --fix` and `prettier --write` on staged files; config is in `@package.json`.

**Windows / CRLF note.** The repo has `core.autocrlf=true` with no `.gitattributes`, so Windows checkouts pick up CRLF line endings while Prettier expects LF — `npm run lint` over the full tree fails on pre-existing files. On Windows, lint only the paths you touched (`npx eslint <files>`) or run `npm run lint:fix` to normalise before a full check.

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
- **RLS template**: every domain table that holds parent-owned data writes its SELECT policy as `using ( public.is_connected(auth.uid(), <owner_column>) )`. `public.is_connected(viewer, owner)` is the SECURITY DEFINER helper (locked `search_path = public, pg_temp`) that centralises the "viewer is the owner, or is a connected friend" check — see the canonical example in `supabase/migrations/20260526120000_parents_foundation.sql`. Do not inline the connection logic per-table; extend `is_connected` instead.
- **Search/list RPCs**: when a domain query needs to bypass `parents_select` (e.g., finding a not-yet-connected parent by handle, or listing accepted-only parents when the policy also exposes pending), implement it as a `SECURITY DEFINER` SQL/PLPGSQL function with `set search_path = public, pg_temp`, exclude `auth.uid()` inside the function where appropriate, and `grant execute … to authenticated`. Canonical examples: `public.find_parent_by_handle(text)` and `public.list_my_friends()` in the `friend_connections` foundation migration.
- **Cross-table visibility via RLS — wrap cross-table EXISTS in a SECURITY DEFINER helper**. When two tables' SELECT policies reference each other (e.g., `meetings_select` needs to know "is the viewer invited?" and `meeting_invitations_select` needs to know "is the viewer the meeting's creator?"), inline EXISTS subqueries trip Postgres's infinite-recursion guard (`ERROR: infinite recursion detected in policy for relation "..."`) on every SELECT. Fix: wrap each cross-table check in a `SECURITY DEFINER` helper with `set search_path = public, pg_temp`, returning `boolean`. The definer call bypasses RLS during the lookup, breaking the cycle. Canonical examples: `public.user_is_meeting_invitee(p_meeting_id, p_user_id)` and `public.user_is_meeting_creator(p_meeting_id, p_user_id)` in the `meetings_foundation` migration, consumed by `meetings_select` and `meeting_invitations_select`. For a one-directional cross-table check (no recursion partner), a bare inline EXISTS is still fine — but qualify the outer-table column (e.g., `ot.<fk> = public.<this_table>.id`, not bare `<fk> = id`) per the `parents_select` lesson, or the inner alias silently shadows.
- **Cross-table mutation via SECURITY DEFINER RPC**: when a single user action must mutate two or more tables atomically (e.g., create a meeting AND insert N invitation rows in one transaction), implement it as a `SECURITY DEFINER` plpgsql function rather than chaining supabase-js calls (supabase-js does not expose multi-statement transactions). Required shape: `set search_path = public, pg_temp`; first statement validates `auth.uid() is not null` (raise `42501` if null); then validate inputs explicitly (cardinality, ranges, cross-row preconditions like `is_connected`) and raise typed exceptions with specific `errcode` values the API layer maps to HTTP statuses (e.g., `42501` → 403, `22023` → 400, Postgres native `23505` → 422). `grant execute … to authenticated`. Canonical example: `public.create_meeting_with_invitations(timestamptz, int, text, text, text, text, text, uuid[])` in the `meetings_foundation` migration. Reach for this pattern instead of two supabase-js calls whenever the second call's failure would leave the first call's row stranded in a useless state.
- **Column-level partial-UPDATE GRANT (REVOKE-first on Supabase)**: RLS `WITH CHECK` only validates the resulting row, not which columns were written. When a policy must restrict _which_ columns are mutable, pair the UPDATE policy with `revoke update on <table> from authenticated; grant update (<col>, …) on <table> to authenticated;`. The REVOKE is load-bearing — Supabase pre-grants ALL on every `public` table to `authenticated`, so without the REVOKE the column GRANT is additive and the partial restriction silently breaks. Canonical example: `friend_connections` revokes the broad UPDATE and grants UPDATE only on `status`. Verify via `\dp <table>`: post-fix the table-level row shows `authenticated=ardDxtm/postgres` (no `w`), with `status: authenticated=w/postgres` in the Column privileges column.
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
