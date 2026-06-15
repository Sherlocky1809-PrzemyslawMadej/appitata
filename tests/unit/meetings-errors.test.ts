import { describe, expect, it } from "vitest";
import { mapCreateMeetingError } from "@/lib/meetings-errors";

// Pure unit tests for the POST /api/meetings error mapper. The route handler
// itself can't be imported in the node env (it pulls `astro:env/server`), so the
// error ladder is extracted here as a pure function and pinned deterministically.
//
// Expectations are derived from the contract (test-plan §6.4 errcode→HTTP table,
// §6.6 raw-500 leak, the sibling friends/request.ts 23503→404) — NOT copied from
// the implementation. The 23503 + fallthrough cases are the regression lock for
// the leak this change closes.

/** A supabase-js PostgrestError-shaped object (only the fields the mapper reads). */
function pgError(code: string | null, message: string) {
  return { code, message };
}

const LEAK_MARKERS = /constraint|relation|violates|sqlstate|23503|pg_|postgres/i;

describe("mapCreateMeetingError", () => {
  it("maps a 23503 FK violation to 404 without leaking DB internals", () => {
    const raw =
      'insert or update on table "meeting_invitations" violates foreign key ' +
      'constraint "meeting_invitations_invitee_id_fkey"';
    const { status, body } = mapCreateMeetingError(pgError("23503", raw));

    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toMatch(LEAK_MARKERS);
  });

  it("maps any unmapped errcode to a safe generic 500 without leaking the raw message", () => {
    const raw = "could not serialize access due to concurrent update";
    const { status, body } = mapCreateMeetingError(pgError("40001", raw));

    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain(raw);
    expect(JSON.stringify(body)).not.toMatch(LEAK_MARKERS);
  });

  it("preserves the existing native-code mappings", () => {
    expect(mapCreateMeetingError(pgError("23505", "duplicate key")).status).toBe(422);
    expect(mapCreateMeetingError(pgError("23514", "check violation")).status).toBe(400);
  });

  it("preserves the RPC message-string mappings (matched before SQLSTATE fallback)", () => {
    expect(mapCreateMeetingError(pgError("42501", "invitee not connected")).status).toBe(403);
    expect(mapCreateMeetingError(pgError("42501", "authentication required")).status).toBe(401);
    expect(mapCreateMeetingError(pgError("22023", "at least one invitee required")).status).toBe(400);
    expect(mapCreateMeetingError(pgError("22023", "too many invitees (max 50)")).status).toBe(400);
  });

  it("falls back to HTTP class by SQLSTATE when the RAISE message text changes", () => {
    // A renamed RAISE message must still degrade to the right class, not 500.
    expect(mapCreateMeetingError(pgError("42501", "some renamed authz message")).status).toBe(403);
    expect(mapCreateMeetingError(pgError("22023", "some renamed validation message")).status).toBe(400);
  });
});
