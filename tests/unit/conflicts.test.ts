import { describe, expect, it } from "vitest";
import { computeConflictsByInvitationId, endsAt, overlaps } from "@/lib/conflicts";
import type { MeetingRow, PendingInvitation } from "@/components/meetings/types";

// Pure unit tests for the conflict-overlap algorithm extracted from
// meetings.astro. Expectations are derived from the documented behaviour
// (test-plan §2 Risk #3; S-03 plan: equal-start overlaps, back-to-back does
// not, half-open [start, end) intervals) — NOT copied from the predicate.

// A fixed base instant keeps every span deterministic. 2026-07-15T12:00:00Z.
const BASE = "2026-07-15T12:00:00.000Z";
const baseMs = Date.parse(BASE);

/** Build a MeetingRow with only the fields the math reads; rest are filler. */
function meeting(id: string, startsAt: string, durationMinutes: number): MeetingRow {
  return {
    id,
    starts_at: startsAt,
    duration_minutes: durationMinutes,
    street: "",
    city: "",
    postal_code: "",
    country: "",
    description: "",
    created_at: BASE,
    creator: null,
    invitations: [],
  };
}

/** ISO string `minutes` after the base instant. */
function at(minutes: number): string {
  return new Date(baseMs + minutes * 60_000).toISOString();
}

function pendingFor(invitationId: string, m: MeetingRow): PendingInvitation {
  return { invitation_id: invitationId, meeting: m };
}

describe("endsAt", () => {
  it("returns starts_at + duration in epoch ms", () => {
    expect(endsAt(meeting("m", BASE, 60))).toBe(baseMs + 60 * 60_000);
  });

  it("honours a non-default duration (not the 60-minute DB default)", () => {
    expect(endsAt(meeting("m", BASE, 90))).toBe(baseMs + 90 * 60_000);
    expect(endsAt(meeting("m", BASE, 15))).toBe(baseMs + 15 * 60_000);
  });
});

describe("overlaps", () => {
  it("flags an equal start as a clash", () => {
    const a = meeting("a", at(0), 60);
    const b = meeting("b", at(0), 30);
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(b, a)).toBe(true);
  });

  it("does NOT flag back-to-back meetings (touching endpoints)", () => {
    // a: [0, 60), b: [60, 120) — a ends exactly when b starts.
    const a = meeting("a", at(0), 60);
    const b = meeting("b", at(60), 60);
    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(b, a)).toBe(false);
  });

  it("flags a one-minute overlap", () => {
    // a: [0, 60), b: [59, 119) — overlap on [59, 60).
    const a = meeting("a", at(0), 60);
    const b = meeting("b", at(59), 60);
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(b, a)).toBe(true);
  });

  it("does NOT flag fully disjoint meetings", () => {
    const a = meeting("a", at(0), 60);
    const b = meeting("b", at(120), 60);
    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(b, a)).toBe(false);
  });

  it("uses each span's own duration when deciding overlap", () => {
    // a: [0, 90) thanks to the 90-min duration; b: [80, 110) overlaps.
    const a = meeting("a", at(0), 90);
    const b = meeting("b", at(80), 30);
    expect(overlaps(a, b)).toBe(true);
  });
});

describe("computeConflictsByInvitationId", () => {
  it("returns one entry per pending invitation, empty array when no clash", () => {
    const proposed = meeting("proposed", at(0), 60);
    const disjoint = meeting("other", at(120), 60);
    const result = computeConflictsByInvitationId([pendingFor("inv-1", proposed)], [disjoint]);

    expect(Object.keys(result)).toEqual(["inv-1"]);
    expect(result["inv-1"]).toEqual([]);
  });

  it("excludes the proposed meeting itself (self-exclusion by id)", () => {
    // The proposed meeting is also in the schedule (the viewer is its creator).
    // It overlaps itself trivially but must be filtered out by id.
    const proposed = meeting("proposed", at(0), 60);
    const result = computeConflictsByInvitationId([pendingFor("inv-1", proposed)], [proposed]);

    expect(result["inv-1"]).toEqual([]);
  });

  it("reports a clash with its summary fields", () => {
    const proposed = meeting("proposed", at(0), 60);
    const clashing = meeting("busy", at(30), 60);
    const result = computeConflictsByInvitationId([pendingFor("inv-1", proposed)], [clashing]);

    expect(result["inv-1"]).toEqual([{ id: "busy", starts_at: at(30), duration_minutes: 60 }]);
  });

  it("returns multiple clashes for a single invitation", () => {
    const proposed = meeting("proposed", at(0), 120);
    const clashA = meeting("busyA", at(10), 30);
    const clashB = meeting("busyB", at(90), 60);
    const noClash = meeting("free", at(300), 60);
    const result = computeConflictsByInvitationId([pendingFor("inv-1", proposed)], [clashA, clashB, noClash]);

    expect(result["inv-1"].map((c) => c.id).sort()).toEqual(["busyA", "busyB"]);
  });

  it("computes conflicts independently for each pending invitation", () => {
    const proposed1 = meeting("p1", at(0), 60);
    const proposed2 = meeting("p2", at(300), 60);
    const clashWith1 = meeting("busy", at(30), 60);
    const result = computeConflictsByInvitationId(
      [pendingFor("inv-1", proposed1), pendingFor("inv-2", proposed2)],
      [clashWith1],
    );

    expect(result["inv-1"].map((c) => c.id)).toEqual(["busy"]);
    expect(result["inv-2"]).toEqual([]);
  });
});
