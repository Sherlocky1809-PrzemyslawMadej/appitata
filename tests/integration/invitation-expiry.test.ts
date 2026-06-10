import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { signInOverHttp, type Jar } from "../helpers/http";
import { serviceClient, signInAs } from "../helpers/supabase";

/**
 * 24h invitation-expiry contract suite — test-plan Risk #5.
 *
 * Spec: `supabase/tests/invitation-expiry.md` (the behavioural oracle these
 * assertions cite — expectations come from the documented observables, not from
 * the sweep/RLS SQL).
 *
 * Proves the three coupled expiry layers against local Supabase with RLS on:
 *   - the `expire_stale_invitations()` sweep RPC (via `serviceClient().rpc`),
 *   - the lazy `meeting_invitations_update` RLS accept-block (via the real
 *     `POST /api/meetings/invitations/respond` over an HTTP cookie jar), and
 *   - the strict 24h boundary on both predicates.
 *
 * Fixtures: Alice creates meetings inviting Bob (accepted-connected in the seed)
 * via `create_meeting_with_invitations` (real validation), then each invitation's
 * `invited_at` is aged by `serviceClient().update` — RLS-bypass, fixture-only,
 * never an isolation assertion (test-plan §6.2). Torn down via `serviceClient()`
 * with a residual-row assertion.
 *
 * Silent-pass guards: a no-session 404 is byte-identical to an expired-invite
 * 404, so every 404 is paired with (1) `signInOverHttp` asserting `302 → /` at
 * signin, (2) an `assertAuthenticated` liveness probe on Bob's jar, and (3) the
 * live fresh-invite 200 control proving the route is not trivially always-404.
 */

const PW = "test1234";
const ALICE = { email: "alice@example.com", id: "00000000-0000-0000-0000-000000000a01" } as const;
const BOB = { email: "bob@example.com", id: "00000000-0000-0000-0000-000000000b01" } as const;

const HOUR_MS = 60 * 60 * 1000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

let bob: Jar;

// One meeting per ageing scenario; each carries a single pending invitation to Bob.
// We track meeting ids (DELETE cascades to invitations) and the invitation ids the
// assertions filter on.
let staleInvitationId: string; // now()-25h  → swept; lazy-blocked
let boundaryInvitationId: string; // now()-24h → fail-closed (un-acceptable)
let underInvitationId: string; // now()-23h  → NOT swept (strict lower edge)
let freshInvitationId: string; // now()      → accepts (positive control)

const meetingIdsToCleanup: string[] = [];

/**
 * Prove Bob's jar is authenticated before trusting any 404. `POST
 * /api/friends/search` returns 200 for any authenticated caller and 401 for an
 * anonymous one — a side-effect-free liveness probe (the HTTP silent-pass guard).
 */
async function assertAuthenticated(jar: Jar, who: string): Promise<void> {
  const { status } = await jar.postJson("/api/friends/search", { handle: "nobody@no-match.invalid" });
  expect(status, `${who}'s jar must be authenticated (search → 200, not 401)`).toBe(200);
}

/**
 * Create an Alice-owned meeting inviting Bob over the full RLS path, optionally
 * age the resulting invitation, and return the invitation id. Registers the
 * meeting for teardown.
 */
async function createAgedInvitation(label: string, agedMsAgo: number | null): Promise<string> {
  const { client, userId } = await signInAs(ALICE.email, PW);
  expect(userId, "fixture creator must be Alice").toBe(ALICE.id);

  const { data: meetingId, error } = await client.rpc("create_meeting_with_invitations", {
    p_starts_at: "2026-08-15T14:00:00+00:00",
    p_duration_minutes: 60,
    p_street: "Expiry St 1",
    p_city: "Warsaw",
    p_postal_code: "00-001",
    p_country: "PL",
    p_description: `expiry-suite ${label}`,
    p_invitee_ids: [BOB.id],
  });
  expect(error, error?.message).toBeNull();
  if (!meetingId) throw new Error(`create_meeting_with_invitations(${label}) returned no meeting id`);
  meetingIdsToCleanup.push(meetingId);

  const svc = serviceClient();
  const inv = await svc.from("meeting_invitations").select("id").eq("meeting_id", meetingId).single();
  expect(inv.error, inv.error?.message).toBeNull();
  if (!inv.data) throw new Error(`invitation row for ${label} not found`);
  const invitationId = inv.data.id;

  if (agedMsAgo !== null) {
    // RLS-bypass fixture write: back-date invited_at only (the RPC has no backdate
    // param). service_role bypasses the column-level GRANT and RLS by design.
    const upd = await svc
      .from("meeting_invitations")
      .update({ invited_at: iso(agedMsAgo) })
      .eq("id", invitationId);
    expect(upd.error, upd.error?.message).toBeNull();
  }
  return invitationId;
}

beforeAll(async () => {
  // Bob signs in over the real auth route (throws unless 302 → /, the signin-side
  // silent-pass guard — no silent anonymous jar).
  bob = await signInOverHttp(BOB.email, PW);

  staleInvitationId = await createAgedInvitation("stale (now-25h)", 25 * HOUR_MS);
  boundaryInvitationId = await createAgedInvitation("boundary (now-24h)", 24 * HOUR_MS);
  underInvitationId = await createAgedInvitation("under (now-23h)", 23 * HOUR_MS);
  freshInvitationId = await createAgedInvitation("fresh (now)", null);
});

afterAll(async () => {
  const svc = serviceClient();
  for (const id of meetingIdsToCleanup) {
    await svc.from("meetings").delete().eq("id", id); // FK cascade clears invitations.
  }
  // Teardown must leave zero residual fixture rows.
  const m = await svc.from("meetings").select("id").in("id", meetingIdsToCleanup);
  expect(m.data ?? [], "no residual fixture meetings after teardown").toHaveLength(0);
});

// ORDER-DEPENDENT BLOCK: the lazy-block tests below MUST run before the sweep
// block — they prove RLS blocks a stale invite *independently of the cron*, which
// only holds while the stale/boundary rows are still `pending` (unswept). The
// sweep block then flips them. Vitest runs in-file tests in declaration order and
// fileParallelism is off (vitest.config.ts), so this holds — do NOT reorder, add
// `.only`, or mark these `concurrent`, or the lazy-block proof would run against
// already-`expired` rows for the wrong reason.
describe("lazy RLS accept-block — enforced before any sweep runs (oracle blocks 5, 6)", () => {
  it("Bob accepting a stale (>24h) unswept invite → 404 (lazy RLS block)", async () => {
    await assertAuthenticated(bob, "Bob");
    const { status } = await bob.postJson("/api/meetings/invitations/respond", {
      invitation_id: staleInvitationId,
      action: "accept",
    });
    expect(status, "stale invite is un-acceptable via RLS freshness predicate, no sweep needed").toBe(404);
    // Control: the row was filtered, not mutated — still pending, responded_at null.
    const svc = serviceClient();
    const row = await svc
      .from("meeting_invitations")
      .select("status, responded_at")
      .eq("id", staleInvitationId)
      .single();
    expect(row.data?.status, "stale invite stays pending (404 filtered, did not flip)").toBe("pending");
    expect(row.data?.responded_at, "blocked accept never stamps responded_at").toBeNull();
  });

  it("Bob accepting a boundary (≈24h) unswept invite → 404 (fail-closed)", async () => {
    const { status } = await bob.postJson("/api/meetings/invitations/respond", {
      invitation_id: boundaryInvitationId,
      action: "accept",
    });
    expect(status, "a boundary-aged invite has crossed the strict accept window → fail-closed").toBe(404);
  });

  it("Bob accepting a fresh (<24h) invite → 200 and stamps the side-effect (positive control)", async () => {
    const { status, body } = await bob.postJson("/api/meetings/invitations/respond", {
      invitation_id: freshInvitationId,
      action: "accept",
    });
    expect(status, "a fresh invite is acceptable — proves the route is not trivially always-404").toBe(200);
    expect(body).toMatchObject({ status: "accepted" });
    expect((body as { responded_at: unknown }).responded_at, "responded_at stamped on accept").not.toBeNull();
    // Verify the side-effect out-of-band against the DB.
    const svc = serviceClient();
    const row = await svc
      .from("meeting_invitations")
      .select("status, responded_at")
      .eq("id", freshInvitationId)
      .single();
    expect(row.data?.status).toBe("accepted");
    expect(row.data?.responded_at, "responded_at persisted").not.toBeNull();
  });
});

describe("sweep RPC expire_stale_invitations (oracle blocks 1-4)", () => {
  it("sweeps the stale invite to expired (count includes it) and leaves the under-24h invite pending", async () => {
    const svc = serviceClient();
    const { data: count, error } = await svc.rpc("expire_stale_invitations");
    expect(error, error?.message).toBeNull();
    // The sweep is global (cross-user); assert on the specific row, not a bare count.
    expect(count ?? 0, "sweep returns the number of rows expired, including ours").toBeGreaterThanOrEqual(1);

    const stale = await svc.from("meeting_invitations").select("status").eq("id", staleInvitationId).single();
    expect(stale.data?.status, "stale (>24h) invite is swept to expired").toBe("expired");

    const under = await svc.from("meeting_invitations").select("status").eq("id", underInvitationId).single();
    expect(under.data?.status, "under-24h invite is untouched (strict < lower edge)").toBe("pending");
  });

  it("does not stamp responded_at on the expired invite (expiry is not a user response)", async () => {
    const svc = serviceClient();
    const row = await svc.from("meeting_invitations").select("responded_at").eq("id", staleInvitationId).single();
    expect(row.data?.responded_at, "sweep leaves responded_at null").toBeNull();
  });

  it("is idempotent — a second sweep returns 0 and re-touches nothing", async () => {
    const svc = serviceClient();
    const { data: count, error } = await svc.rpc("expire_stale_invitations");
    expect(error, error?.message).toBeNull();
    expect(count, "no pending rows remain older than 24h, so the second sweep expires nothing").toBe(0);

    const stale = await svc.from("meeting_invitations").select("status").eq("id", staleInvitationId).single();
    expect(stale.data?.status, "already-expired row is unchanged by the re-run").toBe("expired");
  });
});
