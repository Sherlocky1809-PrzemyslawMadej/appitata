import { describe, it, expect } from "vitest";
import { serviceClient } from "../helpers/supabase";

/**
 * Connectivity smoke test — proves the Vitest harness reaches local Supabase
 * and the env wiring is correct, independent of the seed-password fix (Phase 2).
 *
 * Fails loudly (does not skip) when env vars are unset, so a misconfigured
 * environment can never masquerade as a pass.
 */
describe("local Supabase connectivity (smoke)", () => {
  it("has the required test env vars", () => {
    expect(process.env.SUPABASE_URL, "SUPABASE_URL must be set in .env.test").toBeTruthy();
    expect(process.env.SUPABASE_KEY, "SUPABASE_KEY must be set in .env.test").toBeTruthy();
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY must be set in .env.test").toBeTruthy();
  });

  it("reaches local Supabase and sees the seeded parents", async () => {
    const svc = serviceClient();
    const { count, error } = await svc.from("parents").select("*", { count: "exact", head: true });

    expect(error, error?.message).toBeNull();
    expect(count ?? 0).toBeGreaterThanOrEqual(2);
  });
});
