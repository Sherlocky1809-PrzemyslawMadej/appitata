import { describe, it, expect } from "vitest";
import { signInAs } from "../helpers/supabase";

/**
 * Auth-enablement test — proves the Phase 2 seed-password fix works and two
 * seeded identities get distinct, real sessions over the full HTTP auth path.
 *
 * This is the foundation the Phase 3 isolation suite stands on: without two
 * distinct authenticated identities, no cross-circle isolation assertion is
 * trustworthy (an unauthenticated client returns zero rows for everything).
 */

const ALICE = {
  email: "alice@example.com",
  password: "test1234",
  id: "00000000-0000-0000-0000-000000000a01",
} as const;

const BOB = {
  email: "bob@example.com",
  password: "test1234",
  id: "00000000-0000-0000-0000-000000000b01",
} as const;

describe("auth enablement (signInWithPassword over HTTP)", () => {
  it("Alice signs in and resolves to her expected UUID", async () => {
    const { userId } = await signInAs(ALICE.email, ALICE.password);
    expect(userId).toBe(ALICE.id);
  });

  it("Bob signs in and resolves to his expected UUID", async () => {
    const { userId } = await signInAs(BOB.email, BOB.password);
    expect(userId).toBe(BOB.id);
  });

  it("the two identities are distinct sessions", async () => {
    const [alice, bob] = await Promise.all([signInAs(ALICE.email, ALICE.password), signInAs(BOB.email, BOB.password)]);
    expect(alice.userId).not.toBe(bob.userId);
  });
});
