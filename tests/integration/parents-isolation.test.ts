import { describe, it, expect } from "vitest";
import { anonClient, signInAs } from "../helpers/supabase";

/**
 * Privacy-boundary isolation at the `parents` surface (Risk #1).
 *
 * Proves the connected / pending / unconnected matrix holds over the full
 * HTTP + PostgREST + RLS path, plus the subtle two-faces-of-connected
 * distinction (`parents_select` exposes pending FCs; `list_my_friends()` is
 * accepted-only).
 *
 * Silent-pass guard (non-negotiable): a query run without a real authenticated
 * identity makes every `parents_select` branch false and returns ZERO rows —
 * indistinguishable from a correct isolation result. So every zero-row
 * assertion is preceded by (a) `signInAs` asserting the session resolves to the
 * expected id, and (b) a positive self-visibility control proving the session
 * actually carries that identity into PostgREST. Only then is a zero trusted.
 *
 * Expectations come from the SCENARIO (the `supabase/tests/parents-rls.md`
 * behavioural spec), never from re-deriving the policy USING clause.
 */

const ALICE = {
  email: "alice@example.com",
  password: "test1234",
  id: "00000000-0000-0000-0000-000000000a01",
} as const;

// Bob — accepted FC with Alice (connected arm). Visible via parents AND
// list_my_friends().
const BOB_ID = "00000000-0000-0000-0000-000000000b01";
// Carol — pending FC with Alice (pending arm). Visible via parents_select's
// pending branch, but NOT via list_my_friends() (accepted-only).
const CAROL_ID = "00000000-0000-0000-0000-000000000c01";
// Dave — no FC with Alice (unconnected arm). Invisible at the parents surface.
const DAVE_ID = "00000000-0000-0000-0000-000000000d01";

describe("parents isolation matrix (Risk #1, read path)", () => {
  it("Alice sees Bob (accepted FC)", async () => {
    const { client, userId } = await signInAs(ALICE.email, ALICE.password);
    // Identity guard: the session must resolve to Alice before any count is
    // trustworthy.
    expect(userId, "session must resolve to Alice's id").toBe(ALICE.id);
    // Positive self-visibility control: if this is zero, the identity is not
    // reaching PostgREST and every downstream zero would be a false pass.
    const self = await client.from("parents").select("id").eq("id", ALICE.id);
    expect(self.error, self.error?.message).toBeNull();
    expect(self.data, "Alice must see her own row — proves the identity is live").toHaveLength(1);

    const { data, error } = await client.from("parents").select("id").eq("id", BOB_ID);
    expect(error, error?.message).toBeNull();
    expect(data, "accepted-connected Bob must be visible to Alice").toHaveLength(1);
  });

  it("Alice does NOT see Dave (no FC — unconnected arm)", async () => {
    const { client, userId } = await signInAs(ALICE.email, ALICE.password);
    expect(userId, "session must resolve to Alice's id").toBe(ALICE.id);
    // Identity is proven live by the self-visibility control, so the following
    // zero is a real isolation result, not the silent-pass trap.
    const self = await client.from("parents").select("id").eq("id", ALICE.id);
    expect(self.data, "self-visibility control before trusting a zero").toHaveLength(1);

    const { data, error } = await client.from("parents").select("id").eq("id", DAVE_ID);
    expect(error, error?.message).toBeNull();
    expect(data, "unconnected Dave must be invisible to Alice").toHaveLength(0);
  });

  it("Alice sees Carol (pending FC widens parents_select)", async () => {
    const { client, userId } = await signInAs(ALICE.email, ALICE.password);
    expect(userId, "session must resolve to Alice's id").toBe(ALICE.id);

    const { data, error } = await client.from("parents").select("id").eq("id", CAROL_ID);
    expect(error, error?.message).toBeNull();
    // Scenario expectation: a pending FC makes the counterpart VISIBLE at the
    // parents surface (the load-bearing trap the next test pins down).
    expect(data, "pending-FC Carol must be visible via parents").toHaveLength(1);
  });
});

describe("two-faces-of-connected: parents vs list_my_friends() (Risk #1)", () => {
  it("list_my_friends() includes accepted Bob but excludes pending Carol", async () => {
    const { client, userId } = await signInAs(ALICE.email, ALICE.password);
    expect(userId, "session must resolve to Alice's id").toBe(ALICE.id);

    const { data, error } = await client.rpc("list_my_friends");
    expect(error, error?.message).toBeNull();
    const friendIds = (data ?? []).map((f) => f.id);

    // Accepted FC → present in the accepted-only friends list.
    expect(friendIds, "accepted Bob must appear in list_my_friends()").toContain(BOB_ID);
    // Pending FC → visible via parents (asserted above) but ABSENT here. This
    // is the highest-value behavioural difference: do not collapse the two.
    expect(friendIds, "pending Carol must NOT appear in list_my_friends()").not.toContain(CAROL_ID);
  });
});

describe("silent-pass negative control (Risk #1)", () => {
  it("a no-session client sees zero parents — the documented unauthenticated behaviour", async () => {
    // No signInAs: this client has no identity, so `auth.uid()` is null and
    // every parents_select branch is false. The zero below is the EXPECTED
    // unauthenticated result — it is documented here precisely so that a zero
    // from an *authenticated* isolation assertion (above) is never trusted
    // without its identity guard. A zero alone proves nothing.
    const anon = anonClient();
    const who = await anon.auth.getUser();
    expect(who.data.user, "the negative control must have NO session").toBeNull();

    const { data, error } = await anon.from("parents").select("id");
    expect(error, error?.message).toBeNull();
    expect(data, "an unauthenticated client must see zero parents").toHaveLength(0);
  });
});
