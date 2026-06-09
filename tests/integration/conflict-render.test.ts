import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceClient, signInAs } from "../helpers/supabase";
import { signInOverHttp } from "../helpers/http";

/**
 * Conflict-overlap RENDER wiring — test-plan Risk #3, the "+ one integration"
 * arm. The pure overlap math is proved in tests/unit/conflicts.test.ts; this
 * file proves the /meetings page actually FEEDS that helper the right datasets
 * and renders its result. A wiring regression (page stops calling the helper,
 * or passes the wrong dataset) is invisible to the unit test and would only
 * surface here or in the Phase 4 e2e.
 *
 * Fixture (all via the atomic RPC, torn down with the service client):
 *   - bobOwned        : Bob creates a meeting (invites Alice) at [10:00, 11:00).
 *                       Bob is the creator → it sits in his conflict schedule.
 *   - aliceToBobClash : Alice creates a meeting inviting Bob at [10:30, 11:30),
 *                       left pending → Bob's pending invite, OVERLAPS bobOwned.
 *   - aliceToBobFree  : Alice creates a meeting inviting Bob far in the future,
 *                       left pending → Bob's pending invite, overlaps NOTHING.
 *
 * Loaded as Bob, /meetings must show the conflict warning on the clashing
 * invite and NOT on the free one — present AND absent in one page, the
 * grant/deny pair that a one-sided assertion would miss.
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

const meetingIdsToCleanup: string[] = [];
let clashInvitationId: string;
let freeInvitationId: string;

/** Fetch the invitation row id for a given meeting + invitee (service client). */
async function invitationIdFor(meetingId: string, inviteeId: string): Promise<string> {
  const svc = serviceClient();
  const { data, error } = await svc
    .from("meeting_invitations")
    .select("id")
    .eq("meeting_id", meetingId)
    .eq("invitee_id", inviteeId)
    .single();
  expect(error, error?.message).toBeNull();
  if (!data) throw new Error(`no invitation for meeting ${meetingId} / invitee ${inviteeId}`);
  return data.id;
}

beforeAll(async () => {
  // Bob's own meeting (creator branch of the conflict schedule).
  const bob = await signInAs(BOB.email, BOB.password);
  expect(bob.userId, "fixture creator must be Bob").toBe(BOB.id);
  const bobOwned = await bob.client.rpc("create_meeting_with_invitations", {
    p_starts_at: "2026-09-01T10:00:00+00:00",
    p_duration_minutes: 60,
    p_street: "Conflict St 1",
    p_city: "Warsaw",
    p_postal_code: "00-001",
    p_country: "PL",
    p_description: "conflict-render: Bob-owned meeting",
    p_invitee_ids: [ALICE.id],
  });
  expect(bobOwned.error, bobOwned.error?.message).toBeNull();
  if (!bobOwned.data) throw new Error("bobOwned RPC returned no meeting id");
  meetingIdsToCleanup.push(bobOwned.data);

  // Alice's two invitations to Bob: one clashing, one free.
  const alice = await signInAs(ALICE.email, ALICE.password);
  expect(alice.userId, "fixture inviter must be Alice").toBe(ALICE.id);

  const clash = await alice.client.rpc("create_meeting_with_invitations", {
    p_starts_at: "2026-09-01T10:30:00+00:00", // [10:30, 11:30) overlaps bobOwned
    p_duration_minutes: 60,
    p_street: "Conflict St 2",
    p_city: "Warsaw",
    p_postal_code: "00-001",
    p_country: "PL",
    p_description: "conflict-render: clashing pending invite",
    p_invitee_ids: [BOB.id],
  });
  expect(clash.error, clash.error?.message).toBeNull();
  if (!clash.data) throw new Error("clash RPC returned no meeting id");
  meetingIdsToCleanup.push(clash.data);
  clashInvitationId = await invitationIdFor(clash.data, BOB.id);

  const free = await alice.client.rpc("create_meeting_with_invitations", {
    p_starts_at: "2026-12-01T10:00:00+00:00", // far future, overlaps nothing
    p_duration_minutes: 60,
    p_street: "Conflict St 3",
    p_city: "Warsaw",
    p_postal_code: "00-001",
    p_country: "PL",
    p_description: "conflict-render: free pending invite",
    p_invitee_ids: [BOB.id],
  });
  expect(free.error, free.error?.message).toBeNull();
  if (!free.data) throw new Error("free RPC returned no meeting id");
  meetingIdsToCleanup.push(free.data);
  freeInvitationId = await invitationIdFor(free.data, BOB.id);
});

afterAll(async () => {
  const svc = serviceClient();
  for (const id of meetingIdsToCleanup) {
    const { error } = await svc.from("meetings").delete().eq("id", id);
    // Intentional teardown diagnostic: a leaked fixture row must be visible.
    // eslint-disable-next-line no-console
    if (error) console.warn(`conflict-render teardown failed to delete ${id}: ${error.message}`);
  }
  const residual = await svc.from("meetings").select("id").in("id", meetingIdsToCleanup);
  expect(residual.data ?? [], "no residual fixture meetings").toHaveLength(0);
});

/**
 * Split the rendered HTML into one segment per pending-invitation `<li>` and
 * map each invitation id → whether its segment carries the conflict warning.
 * Render order is starts_at-ascending, but we key by id so order is irrelevant.
 */
function conflictByInvitationId(html: string): Record<string, boolean> {
  const segments = html.split('data-testid="pending-invitation"').slice(1);
  const map: Record<string, boolean> = {};
  for (const seg of segments) {
    const idMatch = /data-invitation-id="([^"]+)"/.exec(seg);
    if (!idMatch) continue;
    map[idMatch[1]] = seg.includes('data-testid="conflict-warning"');
  }
  return map;
}

describe("/meetings conflict-warning render wiring (Risk #3)", () => {
  it("warns on the overlapping pending invite and not on the free one", async () => {
    // Real cookie auth; signInOverHttp throws unless the route returns 302 → /
    // (the HTTP silent-pass guard — a broken login must not degrade to anon).
    const bob = await signInOverHttp(BOB.email, BOB.password);

    const res = await bob.fetch("/meetings");
    // An anonymous request would be redirected to /auth/signin (302); a 200 with
    // the page proves we are authenticated as Bob on a protected route.
    expect(res.status, "authenticated Bob should load /meetings").toBe(200);
    const html = await res.text();
    expect(html).toContain("Pending invitations");

    // Bob's own data is present — guards against a misroute rendering an empty
    // or someone else's page passing the conflict assertion vacuously.
    expect(html, "clashing invitation must render").toContain(clashInvitationId);
    expect(html, "free invitation must render").toContain(freeInvitationId);

    const byId = conflictByInvitationId(html);
    expect(byId[clashInvitationId], "overlapping pending invite must show the conflict warning").toBe(true);
    expect(byId[freeInvitationId], "non-overlapping pending invite must NOT show a conflict warning").toBe(false);

    // Exactly one warning on the page — the free invite does not spuriously warn.
    const warningCount = (html.match(/data-testid="conflict-warning"/g) ?? []).length;
    expect(warningCount, "exactly one conflict warning rendered").toBe(1);
  });

  it("renders all three sections and the endsAt-driven upcoming/past split", async () => {
    // Guards the second consequence of the refactor: the imported `endsAt` also
    // drives the upcoming/past split (meetings.astro), not just the conflict
    // scan. bobOwned (2026-09-01) is in the future relative to render-time, so
    // it must land under Upcoming — between the Upcoming and Past headers.
    const bob = await signInOverHttp(BOB.email, BOB.password);
    const res = await bob.fetch("/meetings");
    expect(res.status).toBe(200);
    const html = await res.text();

    const pendingIdx = html.indexOf("Pending invitations");
    const upcomingIdx = html.indexOf("Upcoming meetings");
    const pastIdx = html.indexOf("Past meetings");
    expect(pendingIdx, "Pending invitations section renders").toBeGreaterThan(-1);
    expect(upcomingIdx, "Upcoming meetings section renders").toBeGreaterThan(-1);
    expect(pastIdx, "Past meetings section renders").toBeGreaterThan(-1);
    expect(pendingIdx, "sections render in order").toBeLessThan(upcomingIdx);
    expect(upcomingIdx).toBeLessThan(pastIdx);

    // bobOwned is future → its description must appear inside the Upcoming
    // block (after the Upcoming header, before the Past header), proving the
    // endsAt(m) >= now split still classifies it correctly post-refactor.
    const ownedDescIdx = html.indexOf("conflict-render: Bob-owned meeting");
    expect(ownedDescIdx, "Bob's future meeting renders under Upcoming").toBeGreaterThan(upcomingIdx);
    expect(ownedDescIdx, "Bob's future meeting is not in Past").toBeLessThan(pastIdx);
  });
});
