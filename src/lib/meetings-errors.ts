// Error mapper for POST /api/meetings (the create_meeting_with_invitations RPC).
//
// Extracted from the route handler so it can be unit-tested without `astro:env`
// (test-plan §6.2/§6.4). Maps every error the RPC can surface to a safe HTTP
// status + body. Two rules drive the shape:
//   1. Match RPC RAISE message strings BEFORE the SQLSTATE fallback, so a renamed
//      message degrades to the right HTTP class instead of a 500 (§6.4 F1 guard).
//   2. Any UNMAPPED errcode must still return a safe generic body — never the raw
//      Postgres message (which leaks relation/constraint/SQLSTATE text). The raw
//      error is logged server-side instead (lessons.md: log, don't swallow, don't
//      leak). This closes the §6.6 raw-500 leak class, of which 23503 was one case.

export interface MappedError {
  status: number;
  body: { error: string };
}

interface RpcError {
  code?: string | null;
  message?: string | null;
}

export function mapCreateMeetingError(error: RpcError): MappedError {
  const code = error.code ?? "";
  const message = error.message ?? "";

  // Postgres-native constraint violations.
  if (code === "23505") return { status: 422, body: { error: "duplicate invitee in request" } };
  if (code === "23514") return { status: 400, body: { error: "invalid field shape" } };
  // FK violation — a parent (creator/invitee) vanished between the RPC's
  // is_connected check and the FK insert (mid-tx race). Mirror friends/request.ts.
  if (code === "23503") return { status: 404, body: { error: "not found" } };

  // RPC-raised exceptions disambiguated by message (same SQLSTATE 42501/22023).
  if (message === "invitee not connected") {
    return { status: 403, body: { error: "one or more invitees are not connected friends" } };
  }
  if (message === "authentication required") {
    // Defense-in-depth: the route's locals.user guard should catch this first.
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (message === "at least one invitee required") {
    return { status: 400, body: { error: "at least one invitee required" } };
  }
  if (message === "too many invitees (max 50)") {
    return { status: 400, body: { error: "too many invitees (max 50)" } };
  }

  // SQLSTATE fallback: a renamed RAISE message degrades to the right class, not 500.
  if (code === "42501") return { status: 403, body: { error: "unauthorized" } };
  if (code === "22023") return { status: 400, body: { error: "invalid request" } };

  // Unmapped: log the raw error server-side, return a safe generic body.
  // eslint-disable-next-line no-console -- deliberate server-side observability; the raw error must NOT reach the client body (lessons.md: log, don't swallow, don't leak).
  console.error("[meetings] unmapped RPC error", error);
  return { status: 500, body: { error: "unexpected error" } };
}
