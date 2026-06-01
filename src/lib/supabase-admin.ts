import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/db/database.types";

/**
 * Service-role Supabase client for background jobs (e.g. the Cloudflare
 * scheduled() cron handler) that must bypass RLS to act across all users.
 *
 * Kept separate from the cookie-based request-path client in `./supabase.ts`
 * so the service-role key never enters the SSR/cookie path or the client
 * bundle. Reads its config from the Worker `env` binding passed by the caller,
 * NOT from `astro:env/server` (which is wired for the request pipeline).
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is typed possibly-missing on purpose: in
 * production it is set via `wrangler secret put` and is not part of the
 * generated `Env`. Returns null when either value is absent so the caller can
 * log and no-op rather than throw.
 */
export function createAdminClient(env: {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}): SupabaseClient<Database> | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
