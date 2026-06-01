/* eslint-disable no-console -- Worker console output is the cron observability surface, surfaced via `wrangler tail`. */
import { handle } from "@astrojs/cloudflare/handler";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Custom Worker entrypoint (wrangler.jsonc `main`). `fetch` delegates to the
 * Astro request pipeline (middleware, API routes, SSR, assets) via the
 * adapter's `handle`. `scheduled` is the S-04 cron backstop: on each Cron
 * Trigger firing it runs the 24h invitation-expiry sweep. Sweep errors are
 * logged, never rethrown — a failed sweep must not crash the runtime, and the
 * next daily run retries idempotently.
 */
async function runExpirySweep(env: Env): Promise<void> {
  const admin = createAdminClient(env);
  if (!admin) {
    console.error("expiry sweep skipped: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
    return;
  }
  const { data, error } = await admin.rpc("expire_stale_invitations");
  if (error) console.error("expiry sweep failed", error.message);
  else console.log(`expiry sweep: ${data} invitation(s) expired`);
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(runExpirySweep(env));
  },
} satisfies ExportedHandler<Env>;
