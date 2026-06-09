import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { signInOverHttp, type Jar } from "../../helpers/http";
import { serviceClient } from "../../helpers/supabase";

/**
 * API input-validation + error-mapping contract suite — test-plan Risk #4.
 *
 * Proves that the in-scope mutating routes:
 *   (1) reject malformed payloads/params with **400** (zod is the gate), exercised
 *       through an AUTHENTICATED jar so the request actually reaches validation
 *       rather than short-circuiting at the 401 guard;
 *   (2) map real RPC/constraint failures to the right HTTP class with a SAFE,
 *       mapped error body — never a raw Postgres message (the anti-leak contract);
 *   (3) pin the load-bearing `meetings/index.ts` error-mapper on its message-string
 *       branch (the F1 regression guard — archived `meeting-creation-and-invite`
 *       impl-review F1).
 *
 * Per the locked convention (research.md §"Open Questions" #6, test-plan §2 Risk #4
 * anti-pattern) tests assert **status** for zod rejections — the per-route error
 * bodies legitimately diverge (`zod message` vs hardcoded `"invalid id"`) and pinning
 * them would be the "assert the literal error string" anti-pattern. Bodies are
 * asserted ONLY where load-bearing: the `meetings` create message-strings and the
 * `friends/search` `{found}` shape (which IS the contract).
 *
 * Fixtures are built at runtime via `serviceClient()` and torn down, leaving the
 * shared seed untouched — the Phase 1 shared-state lesson.
 */

const PW = "test1234";
const ALICE = { email: "alice@example.com", id: "00000000-0000-0000-0000-000000000a01" } as const;
const BOB = { email: "bob@example.com", id: "00000000-0000-0000-0000-000000000b01" } as const;
const CAROL = { email: "carol@example.com", id: "00000000-0000-0000-0000-000000000c01" } as const;
const DAVE = { email: "dave@example.com", id: "00000000-0000-0000-0000-000000000d01" } as const;

// A syntactically valid UUID that no seeded row uses — passes zod's UUID_SHAPE so
// the request reaches the DB/RLS path (used where we need "well-formed but absent").
const ABSENT_UUID = "00000000-0000-0000-0000-0000000000ff";

let alice: Jar;
let dave: Jar;

// Runtime fixture: a pending FC Dave -> Carol so the same-direction duplicate
// `friends/request` hits the UNIQUE constraint (23505 → 409 "already requested").
let dupeFcId: string;
const fcIdsToCleanup: string[] = [];

/** A complete, valid `POST /api/meetings` body; spread + override per-case. */
function validMeetingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // `z.iso.datetime()` defaults to offset:false — only a `Z` suffix is accepted,
    // a `+00:00` offset would itself fail zod and mask the field under test.
    starts_at: "2026-08-01T12:00:00Z",
    duration_minutes: 60,
    street: "Validation St 1",
    city: "Warsaw",
    postal_code: "00-001",
    country: "PL",
    description: "validation-suite payload",
    invitee_ids: [BOB.id],
    ...overrides,
  };
}

/**
 * Assert a mapped error body carries NO raw Postgres internals — the anti-leak
 * contract. Catches a leaked SQLSTATE code, a relation/constraint name, or the
 * raw "violates …"/"duplicate key" driver text that an unmapped raw-500 would
 * surface. The safe mapped strings (e.g. "duplicate invitee in request") pass.
 */
function expectNoRawDbLeak(body: unknown, ctx: string): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  expect(text, `${ctx}: must not leak a SQLSTATE code`).not.toMatch(/\b\d{5}\b/);
  expect(text, `${ctx}: must not leak Postgres relation/constraint internals`).not.toMatch(
    /relation|constraint|violates|duplicate key|search_path|pg_catalog/i,
  );
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
  [alice, dave] = await Promise.all([signInOverHttp(ALICE.email, PW), signInOverHttp(DAVE.email, PW)]);
  // Pending FC Dave -> Carol: Dave re-requesting Carol must collide on the UNIQUE
  // (requester, addressee) pair → 23505 → 409 "already requested".
  dupeFcId = await seedPendingFc(DAVE.id, CAROL.id);
});

afterAll(async () => {
  const svc = serviceClient();
  for (const id of fcIdsToCleanup) {
    await svc.from("friend_connections").delete().eq("id", id);
  }
  const f = await svc.from("friend_connections").select("id").in("id", fcIdsToCleanup);
  expect(f.data ?? [], "no residual fixture friend_connections after teardown").toHaveLength(0);
});

describe("zod-rejection matrix → 400 (status only; bodies diverge by route)", () => {
  it("POST /api/friends/request — missing addressee_id → 400", async () => {
    const { status } = await alice.postJson("/api/friends/request", {});
    expect(status).toBe(400);
  });

  it("POST /api/friends/request — garbage addressee_id → 400", async () => {
    const { status } = await alice.postJson("/api/friends/request", { addressee_id: "not-a-uuid" });
    expect(status).toBe(400);
  });

  it("POST /api/friends/respond — non-UUID request_id → 400", async () => {
    const { status } = await alice.postJson("/api/friends/respond", { request_id: "nope", action: "accept" });
    expect(status).toBe(400);
  });

  it("POST /api/friends/respond — action outside {accept,decline} → 400", async () => {
    const { status } = await alice.postJson("/api/friends/respond", { request_id: ABSENT_UUID, action: "maybe" });
    expect(status).toBe(400);
  });

  it("POST /api/meetings — non-ISO starts_at → 400", async () => {
    const { status } = await alice.postJson("/api/meetings", validMeetingBody({ starts_at: "next tuesday" }));
    expect(status).toBe(400);
  });

  it("POST /api/meetings — duration_minutes out of [1,1440] → 400", async () => {
    const { status } = await alice.postJson("/api/meetings", validMeetingBody({ duration_minutes: 5000 }));
    expect(status).toBe(400);
  });

  it("POST /api/meetings — empty invitee_ids → 400", async () => {
    const { status } = await alice.postJson("/api/meetings", validMeetingBody({ invitee_ids: [] }));
    expect(status).toBe(400);
  });

  it("POST /api/meetings — over-long street (>200) → 400", async () => {
    const { status } = await alice.postJson("/api/meetings", validMeetingBody({ street: "x".repeat(201) }));
    expect(status).toBe(400);
  });

  it("POST /api/meetings/invitations/respond — non-UUID invitation_id → 400", async () => {
    const { status } = await alice.postJson("/api/meetings/invitations/respond", {
      invitation_id: "nope",
      action: "accept",
    });
    expect(status).toBe(400);
  });

  it("POST /api/meetings/invitations/respond — bad action → 400", async () => {
    const { status } = await alice.postJson("/api/meetings/invitations/respond", {
      invitation_id: ABSENT_UUID,
      action: "perhaps",
    });
    expect(status).toBe(400);
  });

  it("DELETE /api/meetings/[id] — non-UUID id → 400", async () => {
    const res = await alice.fetch("/api/meetings/not-a-uuid", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/friends/requests/[id] — non-UUID id → 400", async () => {
    const res = await alice.fetch("/api/friends/requests/not-a-uuid", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});

describe("meetings create error-mapper (F1 guard) — status + safe body, no raw-DB leak", () => {
  it("empty invitee_ids → 400 (zod gate; the RPC's 22023 is the deeper defense-in-depth guard)", async () => {
    // zod's `invitee_ids.min(1)` rejects first; the RPC would also raise 22023
    // "at least one invitee required" if the body bypassed zod. Both map to 400.
    const { status } = await alice.postJson("/api/meetings", validMeetingBody({ invitee_ids: [] }));
    expect(status).toBe(400);
  });

  it("duplicate invitee UUID in invitee_ids → 422 (23505, mapped body)", async () => {
    // Bob is accepted-connected to Alice, so the connection loop passes; the two
    // identical (meeting, invitee) rows then collide on the UNIQUE pair → 23505.
    // The RPC is atomic, so the meeting rolls back — no fixture to tear down.
    const { status, body } = await alice.postJson("/api/meetings", validMeetingBody({ invitee_ids: [BOB.id, BOB.id] }));
    expect(status).toBe(422);
    expect((body as { error?: string }).error).toBe("duplicate invitee in request");
    expectNoRawDbLeak(body, "meetings duplicate-invitee 422");
  });

  it("non-connected invitee → 403 via the MESSAGE-STRING path (the F1 branch)", async () => {
    // Alice inviting Dave (unconnected): the RPC raises 42501 'invitee not
    // connected', which the route maps by message string to 403. This pins the
    // fragile message-string branch — if the RPC text is renamed, the SQLSTATE
    // fallback still yields 403 (manual check 3.6) but this body assertion is the
    // canary that the message branch itself still fires.
    const { status, body } = await alice.postJson("/api/meetings", validMeetingBody({ invitee_ids: [DAVE.id] }));
    expect(status).toBe(403);
    expect((body as { error?: string }).error).toBe("one or more invitees are not connected friends");
    expectNoRawDbLeak(body, "meetings non-connected 403");
  });
});

describe("friends/request authz-validation edges (the only inline-JS authz route)", () => {
  it("self-request (addressee_id == own id) → 422", async () => {
    const { status } = await dave.postJson("/api/friends/request", { addressee_id: DAVE.id });
    expect(status).toBe(422);
  });

  it("requesting an already-accepted-connected parent (Alice→Bob) → 409 'already connected'", async () => {
    const { status, body } = await alice.postJson("/api/friends/request", { addressee_id: BOB.id });
    expect(status).toBe(409);
    expect((body as { error?: string }).error).toBe("already connected");
  });

  it("duplicate same-direction pending request (Dave→Carol again) → 409 'already requested' (23505)", async () => {
    const { status, body } = await dave.postJson("/api/friends/request", { addressee_id: CAROL.id });
    expect(status).toBe(409);
    expect((body as { error?: string }).error).toBe("already requested");
    expectNoRawDbLeak(body, "friends/request duplicate 409");
    // The seeded pending row is unchanged (the duplicate INSERT rolled back).
    const svc = serviceClient();
    const row = await svc.from("friend_connections").select("status").eq("id", dupeFcId).single();
    expect(row.data?.status).toBe("pending");
  });
});

describe("friends/search — validation + {found} smoke (read-only, always 200 on valid input)", () => {
  it("empty handle → 400", async () => {
    const { status } = await alice.postJson("/api/friends/search", { handle: "" });
    expect(status).toBe(400);
  });

  it("over-long handle (>256) → 400", async () => {
    const { status } = await alice.postJson("/api/friends/search", { handle: "x".repeat(257) });
    expect(status).toBe(400);
  });

  it("exact match for a seeded handle → 200 {found:true, id, display_name}", async () => {
    const { status, body } = await alice.postJson("/api/friends/search", { handle: BOB.email });
    expect(status).toBe(200);
    const payload = body as { found: boolean; id?: string; display_name?: string };
    expect(payload.found).toBe(true);
    expect(payload.id).toBe(BOB.id);
    expect(typeof payload.display_name).toBe("string");
    expect(payload.display_name).toBeTruthy();
  });

  it("no match → 200 {found:false}", async () => {
    const { status, body } = await alice.postJson("/api/friends/search", { handle: "nobody@no-match.invalid" });
    expect(status).toBe(200);
    expect(body).toEqual({ found: false });
  });

  it("searching own handle → 200 {found:false} (self-exclusion)", async () => {
    const { status, body } = await alice.postJson("/api/friends/search", { handle: ALICE.email });
    expect(status).toBe(200);
    expect(body).toEqual({ found: false });
  });
});
