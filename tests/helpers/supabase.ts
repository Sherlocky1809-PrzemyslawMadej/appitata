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

/**
 * Sign in as a seeded test identity and return the authenticated client.
 *
 * Builds a fresh anon client, calls `signInWithPassword`, and asserts the
 * session resolves to a non-null user id — the FIRST line of defence against
 * the silent-pass trap (a query run without a real identity makes every RLS
 * policy branch false and returns zero rows, indistinguishable from correct
 * isolation). Throws loudly on any auth error so a broken login can never
 * masquerade as an empty isolation result.
 *
 * @returns `{ client, userId }` — the RLS-scoped client plus the resolved id,
 *          so callers can assert the impersonated identity before trusting any
 *          zero-row count.
 */
export async function signInAs(
  email: string,
  password: string,
): Promise<{ client: SupabaseClient<Database>; userId: string }> {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`signInAs(${email}) failed: ${error.message}`);
  }
  // After the `error` ladder above, supabase-js narrows `data.user` to non-null
  // on a successful password sign-in — so no optional chain here. The `!userId`
  // guard still catches the degenerate empty-string id (the silent-pass trap).
  const userId = data.user.id;
  if (!userId) {
    throw new Error(`signInAs(${email}) returned no user id — session did not resolve to an identity`);
  }
  return { client, userId };
}
