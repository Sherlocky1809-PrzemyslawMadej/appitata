import type { ClashingMeetingSummary, MeetingRow, PendingInvitation } from "@/components/meetings/types";

/**
 * Conflict-overlap detection, extracted verbatim from the `meetings.astro`
 * frontmatter so the algorithm is pure, deterministic, and unit-testable
 * without rendering the page (test-plan §6.1). Behaviour is identical to the
 * original inline math — equal-start overlaps, back-to-back (touching
 * endpoints) does not, half-open `[start, end)` intervals.
 */

/** A meeting-shaped value carrying the two fields the overlap math needs. */
type TimeSpan = Pick<MeetingRow, "starts_at" | "duration_minutes">;

/** Meeting end as epoch ms: `starts_at` parsed to ms plus the duration. */
export function endsAt(m: TimeSpan): number {
  return new Date(m.starts_at).getTime() + m.duration_minutes * 60_000;
}

/**
 * Half-open interval overlap: two spans clash iff one starts strictly before
 * the other ends, in both directions. Touching endpoints (`aEnd === bStart`)
 * do not clash; an equal start does.
 */
export function overlaps(a: TimeSpan, b: TimeSpan): boolean {
  const aStart = new Date(a.starts_at).getTime();
  const bStart = new Date(b.starts_at).getTime();
  return aStart < endsAt(b) && bStart < endsAt(a);
}

/**
 * For each pending invitation, the subset of the viewer's existing schedule
 * that overlaps the proposed meeting — excluding the proposed meeting itself.
 * Returns one entry per pending invitation (empty array when no clash), keyed
 * by `invitation_id`.
 */
export function computeConflictsByInvitationId(
  pending: PendingInvitation[],
  schedule: MeetingRow[],
): Record<string, ClashingMeetingSummary[]> {
  return Object.fromEntries(
    pending.map((pi) => {
      const clashes: ClashingMeetingSummary[] = schedule
        .filter((m) => m.id !== pi.meeting.id)
        .filter((m) => overlaps(m, pi.meeting))
        .map((m) => ({ id: m.id, starts_at: m.starts_at, duration_minutes: m.duration_minutes }));
      return [pi.invitation_id, clashes];
    }),
  );
}
