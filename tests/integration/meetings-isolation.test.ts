import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { serviceClient, signInAs } from "../helpers/supabase";

/**
 * Cross-table meetings + invitations READ isolation — test-plan Risk #1 and
 * Risk #2's read path (cross-table visibility). NOTE: this file covers reads
 * only; the "no silent double-booking" invariant (AGENTS.md load-bearing
 * invariant #2 / conflict-overlap) is NOT tested here — it is deferred to
 * test-plan §3 Phase 3.
 *
 * `meetings_select` and `meeting_invitations_select` reference each other and
 * route through two SECURITY DEFINER helpers (`user_is_meeting_invitee` /
 * `user_is_meeting_creator`) to break Postgres's infinite-recursion guard.
 * This suite proves the 1 / 1 / 0 visibility model (creator sees / invitee
 * sees / uninvolved sees zero) AND that the SELECTs return WITHOUT error — a
 * recursion regression would surface as a 500, not as a wrong count.
 *
 * Fixture is created in setup (one meeting, Alice creator, Bob invited) via the
 * atomic `create_meeting_with_invitations` RPC — not chained client calls,
 * which cannot span a transaction — and torn down with the service client.
 * Every zero-row assertion is preceded by an identity guard.
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

const DAVE = {
  email: "dave@example.com",
  password: "test1234",
  id: "00000000-0000-0000-0000-000000000d01",
} as const;

// The meeting id created in setup; queries filter on it so a parallel test
// file cannot perturb the counts.
let meetingId: string;

beforeAll(async () => {
  // Create as Alice over the full RLS path: WITH CHECK pins creator = auth.uid()
  // and the RPC validates Bob is accepted-connected before inserting.
  const { client, userId } = await signInAs(ALICE.email, ALICE.password);
  expect(userId, "fixture creator must be Alice").toBe(ALICE.id);

  const { data, error } = await client.rpc("create_meeting_with_invitations", {
    p_starts_at: "2026-07-15T14:00:00+00:00",
    p_duration_minutes: 60,
    p_street: "Test St 1",
    p_city: "Warsaw",
    p_postal_code: "00-001",
    p_country: "PL",
    p_description: "isolation-suite co-care meeting",
    p_invitee_ids: [BOB.id],
  });
  expect(error, error?.message).toBeNull();
  // Runtime guard (not a type assertion): narrows `data` to a non-null string
  // for TS while loudly failing setup if the RPC returned nothing.
  if (!data) throw new Error("create_meeting_with_invitations returned no meeting id");
  meetingId = data;
});

afterAll(async () => {
  if (!meetingId) return;
  // DELETE cascades to meeting_invitations via the FK. Service client bypasses
  // RLS so cleanup never depends on the policy under test. Surface a failed
  // teardown loudly — a silently-leaked fixture row would corrupt later runs.
  const { error } = await serviceClient().from("meetings").delete().eq("id", meetingId);
  // Intentional teardown diagnostic: a leaked fixture row must be visible.
  // eslint-disable-next-line no-console
  if (error) console.warn(`meetings-isolation teardown failed to delete ${meetingId}: ${error.message}`);
});

describe("meeting cross-table visibility (creator / invitee / uninvolved)", () => {
  it("Alice (creator) sees the meeting and the invitation", async () => {
    const { client, userId } = await signInAs(ALICE.email, ALICE.password);
    expect(userId, "session must resolve to Alice").toBe(ALICE.id);

    const m = await client.from("meetings").select("id").eq("id", meetingId);
    expect(m.error, m.error?.message).toBeNull();
    expect(m.data, "creator must see her meeting").toHaveLength(1);

    const inv = await client.from("meeting_invitations").select("id").eq("meeting_id", meetingId);
    expect(inv.error, inv.error?.message).toBeNull();
    expect(inv.data, "creator must see the invitation (creator branch)").toHaveLength(1);
  });

  it("Bob (invitee) sees the meeting and the invitation", async () => {
    const { client, userId } = await signInAs(BOB.email, BOB.password);
    expect(userId, "session must resolve to Bob").toBe(BOB.id);

    const m = await client.from("meetings").select("id").eq("id", meetingId);
    expect(m.error, m.error?.message).toBeNull();
    expect(m.data, "invitee must see the meeting (invitee branch)").toHaveLength(1);

    const inv = await client.from("meeting_invitations").select("id").eq("meeting_id", meetingId);
    expect(inv.error, inv.error?.message).toBeNull();
    expect(inv.data, "invitee must see his invitation").toHaveLength(1);
  });

  it("Dave (uninvolved) sees neither the meeting nor the invitation", async () => {
    const { client, userId } = await signInAs(DAVE.email, DAVE.password);
    // Identity guard: prove the session is Dave's before trusting the zeros.
    expect(userId, "session must resolve to Dave").toBe(DAVE.id);

    const m = await client.from("meetings").select("id").eq("id", meetingId);
    expect(m.error, m.error?.message).toBeNull();
    expect(m.data, "uninvolved Dave must see zero meetings").toHaveLength(0);

    const inv = await client.from("meeting_invitations").select("id").eq("meeting_id", meetingId);
    expect(inv.error, inv.error?.message).toBeNull();
    expect(inv.data, "uninvolved Dave must see zero invitations").toHaveLength(0);
  });
});
