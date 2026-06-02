# Deploy Plan — First Production Deploy + S-04 Cron Backstop

**Purpose:** First production deploy of AppiTata to Cloudflare Workers, and the step that closes roadmap **S-04 / plan step 2.7** — confirming the daily Cron Trigger fires `scheduled()` and the invitation-expiry sweep runs against the **production** database.

**Status:** prepared 2026-06-02 — _not yet executed_. Every step below is **human-run**; this is first-time setup (account, token, first secrets) and a production mutation, which the project posture (CLAUDE.md production-access boundary, `infrastructure.md` §Operational Story) keeps human-only.

**Authoritative source:** `context/foundation/infrastructure.md` §Operational Story + §Minimal Permissions. This runbook is consistent with it and adds the S-04-specific DB + cron-verification steps.

**Facts (from the repo, do not re-derive):**

- Worker name: `appitata` (`wrangler.jsonc:3`)
- Entry: `./src/worker.ts` exporting `{ fetch, scheduled }` (`wrangler.jsonc:4`)
- Cron: `0 3 * * *` — daily 03:00 **UTC** (`wrangler.jsonc:7-9`)
- Build: `npm run build` (`astro build`); wrangler `^4.90`; adapter `@astrojs/cloudflare` v13.5 → **Workers** (not Pages)
- Runtime secrets the Worker needs: `SUPABASE_URL`, `SUPABASE_KEY` (anon, request path), `SUPABASE_SERVICE_ROLE_KEY` (cron sweep, bypasses RLS)
- Sweep RPC: `public.expire_stale_invitations()`, EXECUTE granted only to `service_role`; latest migration `supabase/migrations/20260601120000_invitation_expiry_sweep.sql`

---

## ⚠️ Critical prerequisite — production DB must have the sweep migration

The cron handler calls `public.expire_stale_invitations()`. If the **production** Supabase database hasn't had `20260601120000_invitation_expiry_sweep.sql` applied, every cron run logs `expiry sweep failed` (function does not exist). Local Supabase having it is **not** enough — Part A pushes it to prod. Do Part A **before** relying on the cron.

---

## Part A — Production Supabase (DB + keys)

> Skip A1–A2 if a hosted Supabase project already exists and is linked. `supabase` is **not** linked locally (checked 2026-06-02), so assume first-time.

1. **Create / identify the hosted project** at https://supabase.com/dashboard (region close to your users; single region is fine per `prd.md` scale). Note the **Project Ref** (e.g. `abcdwxyz...`).
2. **Link the local repo to it:**
   ```
   npx supabase link --project-ref <PROJECT_REF>
   ```
   (Prompts for the DB password — the one set at project creation.)
3. **Apply all migrations to production:**
   ```
   npx supabase db push
   ```
   Confirm the output lists `20260601120000_invitation_expiry_sweep.sql` as applied. This is the load-bearing step for S-04.
4. **Verify the RPC + grants exist in prod** (Supabase dashboard → SQL Editor):
   ```sql
   select proname, prosecdef from pg_proc
     where proname = 'expire_stale_invitations';                -- 1 row, prosecdef = t
   select grantee, privilege_type from information_schema.routine_privileges
     where routine_name = 'expire_stale_invitations';           -- service_role + owner only
   ```
5. **Collect the three values** from dashboard → **Project Settings → API**:
   - `SUPABASE_URL` = Project URL (`https://<ref>.supabase.co`)
   - `SUPABASE_KEY` = **anon / public** key
   - `SUPABASE_SERVICE_ROLE_KEY` = **service_role** key — the **secret** one. **NOT** the local `npx supabase status` value; that key only works against the local Docker stack. Treat this like a root password (see Security note).

---

## Part B — Cloudflare auth (human-only, one-time)

Per `infrastructure.md`: scoped token, never master key.

1. **Create the account** (if needed) at https://dash.cloudflare.com.
2. **Authenticate Wrangler.** Either:
   - Interactive (laptop): `npx wrangler login` (browser OAuth), then `npx wrangler whoami` to confirm; **or**
   - Scoped token (preferred posture): create an API token with **Workers Scripts: Edit** + **Account: Read** for this account only (no DNS, no billing), then set it for the session — PowerShell:
     ```
     $env:CLOUDFLARE_API_TOKEN = "<token>"
     npx wrangler whoami
     ```

---

## Part C — Worker secrets (first put = human-only)

Run from the repo root. Each prompts for the value (paste from Part A5). Secrets land on the Worker named `appitata` and take effect live (no redeploy needed to update).

```
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

> If the Worker doesn't exist yet, do **Part D (first deploy) first**, then set secrets — wrangler needs the Worker to exist to attach secrets. Order: **D → C** on a brand-new Worker; **C → D** once it exists. Confirm with `npx wrangler secret list` (should show all three names; values are never displayed).

---

## Part D — Build & deploy

```
npm run build
npx wrangler deploy
```

- `npm run build` exercises `astro build`; if a dependency reaches for `node:fs` / a native addon it can fail only here or at runtime on `workerd` (see `infrastructure.md` cross-check) — watch the build output.
- `wrangler deploy` output **must list the cron schedule**, e.g.:
  ```
  Uploaded appitata (x.xx sec)
  Published appitata
    https://appitata.<subdomain>.workers.dev
    schedule: 0 3 * * *
  ```
  Seeing `schedule: 0 3 * * *` **registers** the trigger — this alone satisfies the literal wording of plan step 2.7. Part E confirms it actually _fires_.
- Troubleshooting: if wrangler can't find the entry, the adapter may have emitted a generated config under `dist/` — deploy with `npx wrangler deploy -c dist/wrangler.json` (the v13.5 vite-plugin wraps, not replaces, the root `main`).

---

## Part E — Confirm the cron actually fires (closes 2.7 for real)

The roadmap S-04 bar: _"mark done only after a real expired-but-unopened invitation is observed to be cleared by the cron run."_ Pick the depth you want:

**E1 — Registration only (fast):** the `schedule:` line in Part D output. Good enough for "trigger registered."

**E2 — Observe a real firing (recommended).** You don't have to wait until 03:00 UTC — temporarily speed up the cron:

1. In `wrangler.jsonc` set `"crons": ["*/2 * * * *"]` (every 2 min). `npm run build && npx wrangler deploy`.
2. In a second terminal: `npx wrangler tail --format pretty` (filter with `--search "expiry sweep"`).
3. Within ~2 min you should see `expiry sweep: N invitation(s) expired` from a `scheduled` event.
4. **Revert** `"crons": ["0 3 * * *"]`, then `npm run build && npx wrangler deploy` again. _(Do not leave the 2-minute cron deployed.)_

   > Note: `wrangler dev --remote --test-scheduled` + `curl /cdn-cgi/handler/scheduled` is documented to **not** work with this adapter's v13.5 dev server (see the archived change.md note) — use E2's temporary-cron method instead.

**E3 — End-to-end with a real stale row (gold standard, careful — touches prod data).** Using two test accounts on the production app: create a meeting + invitation, then in the SQL Editor backdate it so it's stale, and let the cron clear it:

```sql
-- backdate ONE test invitation to make it stale (use a known test invitee/meeting)
update public.meeting_invitations
   set invited_at = now() - interval '25 hours'
 where id = '<test-invitation-id>' and status = 'pending';
```

Wait for the next firing (or use E2's fast cron), then confirm `status = 'expired'` and that the invite no longer appears in the invitee's `/meetings` Pending section. Only do this with throwaway test data.

---

## Part F — Web-app regression check (through the new entrypoint)

The deploy repoints `main` to the custom `worker.ts`; confirm `fetch` still runs the full Astro pipeline:

- Home page loads at the `*.workers.dev` URL.
- Sign-in / sign-up work against the production Supabase.
- An unauthenticated request to `/dashboard` redirects to `/auth/signin` (middleware path).

---

## Rollback

```
npx wrangler rollback            # to immediately-prior version (interactive)
npx wrangler rollback <VERSION>  # specific version (npx wrangler deployments list)
```

**Caveat (from `infrastructure.md`):** a Worker rollback does **not** revert Supabase migrations. The sweep migration is forward-compatible (the old Worker without `scheduled` runs fine against the new schema; the tightened RLS only narrows accept-eligibility of already-stale rows), so no DB rollback is needed if you revert the Worker.

---

## After a successful deploy — record it

Plan step 2.7 lives in the now-**archived** change `context/archive/2026-06-01-invitation-expiry-cron-backstop/` (read-only by convention — do **not** edit the archived plan). Record the close here instead:

- Tick the box below, and
- Add a one-line note to `context/foundation/infrastructure.md` (e.g. under Operational Story) that the cron sweep is live in production as of `<date>`, with the observed `expiry sweep: N` evidence.

**Deploy checklist:**

- [ ] A — prod Supabase linked, `db push` applied, RPC+grants verified
- [ ] C — all three Worker secrets set (`wrangler secret list` shows them)
- [ ] D — `wrangler deploy` succeeded, output shows `schedule: 0 3 * * *`
- [ ] E — cron firing observed (`expiry sweep: N invitation(s) expired` in `wrangler tail`)
- [ ] F — home loads, auth works, `/dashboard` redirects when logged out
- [ ] 2.7 closed — recorded in `infrastructure.md`

---

## Security reminders (non-negotiable)

- **`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS.** It is set only via `wrangler secret put` (Workers Secrets vault) and read only by `scheduled()` through the Worker `env` binding — never in `wrangler.jsonc`, never in `.env`/`.env.example` (placeholder only), never in the request/client path. `src/lib/supabase-admin.ts` is imported only by `src/worker.ts` (verified in review). Keep it that way.
- **`.dev.vars` is gitignored** — the local service_role key never gets committed. The prod key never goes in any file in the repo.
- **Destructive Supabase ops stay human-only** (drop table, drop database, rotate the service_role/anon key) — panel-by-hand, even if an agent suggests them.
