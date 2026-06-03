import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/db/database.types";

/**
 * Test-only Supabase client factories.
 *
 * Built plain from `process.env` (sourced from `.env.test`), mirroring
 * `src/lib/supabase-admin.ts` — deliberately NOT importing `src/lib/supabase.ts`
 * or `astro:env/server`, which only resolve inside the Astro/Vite build and
 * would break a plain Vitest run.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required test env var: ${name}. Populate .env.test from \`npx supabase status\`.`);
  }
  return value;
}

/**
 * Anonymous (publishable-key) client — RLS applies. Use as the base for a
 * per-identity `signInWithPassword` in later phases; on its own it is an
 * unauthenticated client (`auth.uid()` is null).
 */
export function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Service-role client — bypasses RLS. Use for fixture reads/setup only, never
 * to assert isolation (a service-role read sees everything by design).
 */
export function serviceClient(): SupabaseClient<Database> {
  return createClient<Database>(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
