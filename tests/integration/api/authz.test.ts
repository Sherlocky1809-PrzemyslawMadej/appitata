import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { signInOverHttp, anonymousJar, type Jar } from "../../helpers/http";
import { serviceClient, signInAs } from "../../helpers/supabase";

/**
 * API authorization / IDOR contract suite — test-plan Risk #2.
 *
 * Proves the in-scope mutate-by-id routes reject NON-OWNERS over the real HTTP +
 * RLS path. The routes delegate authorization to the database: a non-owner's row
 * is filtered to null by the RLS `USING` clause, so the route returns **404**
 * (not 403). A 404 is therefore only meaningful when it runs against a REAL
 * other-owned fixture row AND the acting jar is proven authenticated — a
 * no-session 404 is byte-identical to a non-owner 404 (the HTTP silent-pass
 * trap). Every deny case below is paired with (1) an `assertAuthenticated` probe
 * on the acting jar and (2) an owner-success control proving the route is not
 * trivially always-404.
 *
 * Fixtures are built at runtime (a real Alice-owned meeting + pending invitation
 * to Bob, plus two pending friend_connections) and torn down via `serviceClient()`,
 * leaving the shared seed untouched — the Phase 1 shared-state lesson.
 */

const PW = "test1234";
const ALICE = { email: "alice@example.com", id: "00000000-0000-0000-0000-000000000a01" } as const;
const BOB = { email: "bob@example.com", id: "00000000-0000-0000-0000-000000000b01" } as const;
const CAROL = { email: "carol@example.com", id: "00000000-0000-0000-0000-000000000c01" } as const;
const DAVE = { email: "dave@example.com", id: "00000000-0000-0000-0000-000000000d01" } as const;

// Per-user HTTP cookie jars — one independent authenticated session each.
let alice: Jar;
let bob: Jar;
let carol: Jar;
let dave: Jar;

// Runtime fixtures.
let m1Id: string; // Alice-owned meeting, Bob invited (pending invitation).
let m1InvitationId: string; // Bob's pending invitation on m1.
let respondFcId: string; // pending FC Bob -> Dave (Dave is the addressee → may respond).
let deleteFcId: string; // pending FC Carol -> Dave (Carol is the requester → may delete).

// Everything created during the run, deleted (and asserted-zero) in afterAll.
const meetingIdsToCleanup: string[] = [];
const fcIdsToCleanup: string[] = [];

/**
 * Prove a jar is authenticated before trusting any 404 it receives. `POST
 * /api/friends/search` returns 200 `{found:false}` for ANY authenticated caller
 * and 401 for an anonymous one, so it is a clean, side-effect-free liveness
 * probe — the HTTP edition of the silent-pass identity guard.
 */
async function assertAuthenticated(jar: Jar, who: string): Promise<void> {
  const { status } = await jar.postJson("/api/friends/search", { handle: "nobody@no-match.invalid" });
  expect(status, `${who}'s jar must be authenticated (search → 200, not 401)`).toBe(200);
}

/** Create a real Alice-owned meeting over the full RLS path; register for teardown. */
async function createAliceMeeting(inviteeId: string): Promise<string> {
  const { client, userId } = await signInAs(ALICE.email, PW);
  expect(userId, "fixture creator must be Alice").toBe(ALICE.id);
  const { data, error } = await client.rpc("create_meeting_with_invitations", {
    p_starts_at: "2026-07-15T14:00:00+00:00",
    p_duration_minutes: 60,
    p_street: "Authz St 1",
    p_city: "Warsaw",
    p_postal_code: "00-001",
    p_country: "PL",
    p_description: "authz-suite fixture meeting",
    p_invitee_ids: [inviteeId],
  });
  expect(error, error?.message).toBeNull();
  if (!data) throw new Error("create_meeting_with_invitations returned no meeting id");
  meetingIdsToCleanup.push(data);
  return data;
}

/** Insert a pending friend_connection directly (RLS-bypass); register for teardown. */
async function seedPendingFc(requesterId: string, addresseeId: string): Promise<string> {
  const svc = serviceClient();
  // Idempotency across consecutive runs: clear any leftover same-pair row first.
  await svc.from("friend_connections").delete().eq("requester_id", requesterId).eq("addressee_id", addresseeId);
  const { data, error } = await svc
    .from("friend_connections")
    .insert({ requester_id: requesterId, addressee_id: addresseeId, status: "pending" })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  if (!data) throw new Error("seedPendingFc returned no id");
  fcIdsToCleanup.push(data.id);
  return data.id;
}

beforeAll(async () => {
  // Authenticate all four identities over the real signin route (throws loudly
  // on bad credentials — no silent anonymous jar).
  [alice, bob, carol, dave] = await Promise.all([
    signInOverHttp(ALICE.email, PW),
    signInOverHttp(BOB.email, PW),
    signInOverHttp(CAROL.email, PW),
    signInOverHttp(DAVE.email, PW),
  ]);

  // m1: real Alice-owned meeting with a pending invitation to Bob.
  m1Id = await createAliceMeeting(BOB.id);
  const svc = serviceClient();
  const inv = await svc.from("meeting_invitations").select("id").eq("meeting_id", m1Id).single();
  expect(inv.error, inv.error?.message).toBeNull();
  if (!inv.data) throw new Error("m1 invitation row not found");
  m1InvitationId = inv.data.id;

  // Friend-connection fixtures for the friend mutate-by-id routes.
  respondFcId = await seedPendingFc(BOB.id, DAVE.id); // Dave is addressee → can respond.
  deleteFcId = await seedPendingFc(CAROL.id, DAVE.id); // Carol is requester → can delete.
});

afterAll(async () => {
  const svc = serviceClient();
  for (const id of meetingIdsToCleanup) {
    await svc.from("meetings").delete().eq("id", id); // FK cascade clears invitations.
  }
  for (const id of fcIdsToCleanup) {
    await svc.from("friend_connections").delete().eq("id", id);
  }
  // Teardown must leave zero residual fixture rows (success criterion 2.5).
  const m = await svc.from("meetings").select("id").in("id", meetingIdsToCleanup);
  expect(m.data ?? [], "no residual fixture meetings after teardown").toHaveLength(0);
  const f = await svc.from("friend_connections").select("id").in("id", fcIdsToCleanup);
  expect(f.data ?? [], "no residual fixture friend_connections after teardown").toHaveLength(0);
});

describe("IDOR: DELETE /api/meetings/[id]", () => {
  it("Bob (invitee, non-creator) → 404 against Alice's real meeting", async () => {
    await assertAuthenticated(bob, "Bob");
    const res = await bob.fetch(`/api/meetings/${m1Id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    // Control: the row is untouched (still exists) — the 404 filtered, didn't delete.
    const svc = serviceClient();
    const still = await svc.from("meetings").select("id").eq("id", m1Id).maybeSingle();
    expect(still.data?.id, "non-owner DELETE must not remove the row").toBe(m1Id);
  });

  it("Alice (creator) → 204 (owner-success control, disposable meeting)", async () => {
    const m2 = await createAliceMeeting(BOB.id);
    const res = await alice.fetch(`/api/meetings/${m2}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const svc = serviceClient();
    const gone = await svc.from("meetings").select("id").eq("id", m2).maybeSingle();
    expect(gone.data, "creator DELETE removes the meeting").toBeNull();
  });
});

// ORDER-DEPENDENT BLOCK: these `it`s share one pending invitation (m1InvitationId)
// and must run top-to-bottom. The non-invitee deny cases (Carol/Dave → 404) rely on
// the invitation still being `pending`; Bob's accept then permanently flips it to
// `accepted`, which is the precondition for the one-shot 404 below. Vitest runs
// in-file tests in declaration order and fileParallelism is off, so this holds — but
// do NOT reorder, add `.only`, or mark these `concurrent`, or the deny cases would
// silently 404 for the wrong reason. To make a case order-independent, seed it its
// own invitation.
describe("IDOR: POST /api/meetings/invitations/respond", () => {
  it("Carol (non-invitee) → 404", async () => {
    await assertAuthenticated(carol, "Carol");
    const { status } = await carol.postJson("/api/meetings/invitations/respond", {
      invitation_id: m1InvitationId,
      action: "accept",
    });
    expect(status).toBe(404);
  });

  it("Dave (non-invitee) → 404", async () => {
    await assertAuthenticated(dave, "Dave");
    const { status } = await dave.postJson("/api/meetings/invitations/respond", {
      invitation_id: m1InvitationId,
      action: "accept",
    });
    expect(status).toBe(404);
  });

  it("Bob (invitee) accept → 200 and stamps the side-effect (owner-success control)", async () => {
    const { status, body } = await bob.postJson("/api/meetings/invitations/respond", {
      invitation_id: m1InvitationId,
      action: "accept",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "accepted" });
    expect((body as { responded_at: unknown }).responded_at, "responded_at stamped").not.toBeNull();
    // Verify the side-effect out-of-band against the DB.
    const svc = serviceClient();
    const row = await svc.from("meeting_invitations").select("status, responded_at").eq("id", m1InvitationId).single();
    expect(row.data?.status).toBe("accepted");
    expect(row.data?.responded_at, "responded_at persisted").not.toBeNull();
  });

  it("Bob second accept of the same invitation → 404 (one-shot, no longer pending)", async () => {
    const { status } = await bob.postJson("/api/meetings/invitations/respond", {
      invitation_id: m1InvitationId,
      action: "accept",
    });
    expect(status).toBe(404);
  });
});

describe("IDOR: POST /api/friends/respond", () => {
  it("Carol (non-addressee) → 404 against a real pending request", async () => {
    await assertAuthenticated(carol, "Carol");
    const { status } = await carol.postJson("/api/friends/respond", {
      request_id: respondFcId,
      action: "accept",
    });
    expect(status).toBe(404);
  });

  it("Dave (addressee) accept → 200 (owner-success control)", async () => {
    const { status, body } = await dave.postJson("/api/friends/respond", {
      request_id: respondFcId,
      action: "accept",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "accepted" });
    const svc = serviceClient();
    const row = await svc.from("friend_connections").select("status").eq("id", respondFcId).single();
    expect(row.data?.status).toBe("accepted");
  });
});

describe("IDOR: DELETE /api/friends/requests/[id]", () => {
  it("Bob (non-requester) → 404 against a real pending request", async () => {
    await assertAuthenticated(bob, "Bob");
    const res = await bob.fetch(`/api/friends/requests/${deleteFcId}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    // The row survives — the 404 filtered, didn't delete.
    const svc = serviceClient();
    const still = await svc.from("friend_connections").select("id").eq("id", deleteFcId).maybeSingle();
    expect(still.data?.id, "non-requester DELETE must not remove the row").toBe(deleteFcId);
  });

  it("Carol (requester) → 204 (owner-success control)", async () => {
    const res = await carol.fetch(`/api/friends/requests/${deleteFcId}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const svc = serviceClient();
    const gone = await svc.from("friend_connections").select("id").eq("id", deleteFcId).maybeSingle();
    expect(gone.data, "requester DELETE removes the pending request").toBeNull();
  });
});

describe("create authorization: POST /api/meetings (connection precondition)", () => {
  it("Alice inviting Dave (unconnected) → 403", async () => {
    const { status } = await alice.postJson("/api/meetings", {
      starts_at: "2026-07-20T10:00:00Z",
      street: "Conn St 1",
      city: "Warsaw",
      postal_code: "00-001",
      country: "PL",
      description: "invite unconnected Dave",
      invitee_ids: [DAVE.id],
    });
    expect(status).toBe(403);
  });

  it("Alice inviting Carol (pending FC, not accepted) → 403 (pending ≠ connected)", async () => {
    const { status } = await alice.postJson("/api/meetings", {
      starts_at: "2026-07-20T10:00:00Z",
      street: "Conn St 2",
      city: "Warsaw",
      postal_code: "00-001",
      country: "PL",
      description: "invite pending Carol",
      invitee_ids: [CAROL.id],
    });
    expect(status).toBe(403);
  });

  it("Alice inviting Bob (accepted-connected) → 201 (owner-success control)", async () => {
    const { status, body } = await alice.postJson("/api/meetings", {
      starts_at: "2026-07-20T10:00:00Z",
      street: "Conn St 3",
      city: "Warsaw",
      postal_code: "00-001",
      country: "PL",
      description: "invite connected Bob",
      invitee_ids: [BOB.id],
    });
    expect(status).toBe(201);
    const meetingId = (body as { meeting_id?: string }).meeting_id;
    expect(meetingId, "201 returns the new meeting id").toBeTruthy();
    if (meetingId) meetingIdsToCleanup.push(meetingId); // tear down the control's meeting
  });
});

describe("unauthenticated rejection (the cookie is what authorizes)", () => {
  it("POST /api/meetings without a cookie → 401", async () => {
    const anon = anonymousJar();
    const { status } = await anon.postJson("/api/meetings", {
      starts_at: "2026-07-20T10:00:00Z",
      street: "X",
      city: "Y",
      postal_code: "00-001",
      country: "PL",
      description: "no cookie",
      invitee_ids: [BOB.id],
    });
    expect(status).toBe(401);
  });

  it("DELETE /api/meetings/[id] without a cookie → 401", async () => {
    const anon = anonymousJar();
    const res = await anon.fetch(`/api/meetings/${m1Id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});
