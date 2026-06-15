# Map 23503 FK-violation to a safe 404 in POST /api/meetings — Implementation Plan

## Overview

Close the latent raw-500 secret-leak in `POST /api/meetings` (test-plan §6.6; `lessons.md` "Map every errcode an RPC/RLS path can raise, or it leaks a raw-500"). Drive it via the m3l5 **debugging-as-test** cycle: extract the route's inline error ladder into a pure, importable `mapCreateMeetingError(error)` so the bug becomes a deterministic **unit** test (the route itself can't be unit-imported — it pulls `astro:env/server`); prove `23503` currently leaks the raw Postgres message (RED); then map `23503` → 404 **and** harden the generic fallthrough to return a safe generic 500 (logging the raw error server-side, not returning it) — closing the whole leak class, not just this one code (GREEN).

## Current State Analysis

- **The leak**: [src/pages/api/meetings/index.ts:66-88](../../../src/pages/api/meetings/index.ts#L66) maps `23505`→422, `23514`→400, the RPC message strings (`invitee not connected`→403, etc.), and the SQLSTATE fallbacks `42501`→403 / `22023`→400 — but has **no `23503` branch**. An unmapped error falls through to `return json({ error: error.message }, 500)` ([line 87](../../../src/pages/api/meetings/index.ts#L87)), leaking the raw Postgres message (`relation`/`constraint`/SQLSTATE text).
- **The sibling does it right**: [src/pages/api/friends/request.ts:79](../../../src/pages/api/friends/request.ts#L79) maps `23503`→404 (`{ error: "not found" }`). Proves the gap is an oversight.
- **How `23503` is raised**: the RPC `create_meeting_with_invitations` validates `is_connected(caller, invitee)` for every invitee _before_ the FK inserts ([migration:184-188](../../../supabase/migrations/20260528105428_meetings_foundation.sql#L184)); the inserts touch `meetings.creator_id → parents(id)` and `meeting_invitations.invitee_id → parents(id)`. With `parents → auth.users on delete cascade` and `friend_connections → parents on delete cascade`, a passing `is_connected` **guarantees** the parent exists at check time — so a `23503` is only reachable via a parent deleted in the window between the check and the FK insert (a mid-transaction race). **Not deterministically reproducible** through the public RPC in one transaction.
- **Why a unit test, not integration**: per test-plan §6.2/§6.4 the route handler can't be imported in the node test env (it pulls `astro:env/server`, a virtual module). Extracting the pure mapper makes the contract deterministically testable without a server, DB, or the race.

## Desired End State

- A pure `mapCreateMeetingError(error)` in `src/lib/` returns `{ status, body }` for every error the RPC can surface; `POST /api/meetings` delegates to it.
- `23503` → `{ status: 404, body: { error: "not found" } }`.
- Any **unmapped** errcode → `{ status: 500, body: { error: "<safe generic>" } }` with the raw error logged server-side (`console.error`) — never returned in the HTTP body. The leak **class** is closed.
- A deterministic unit test pins both: `23503`→404 (no `constraint`/`relation`/SQLSTATE text in the body) and the safe-generic fallthrough, plus the existing mapped codes unchanged.

### Key Discoveries:

- The fallthrough at [meetings/index.ts:87](../../../src/pages/api/meetings/index.ts#L87) is the leak; the sibling [friends/request.ts:79](../../../src/pages/api/friends/request.ts#L79) is the reference shape for `23503`→404.
- The RPC's typed raises (`42501`, `22023`) are disambiguated by `error.message` before the SQLSTATE fallback — the mapper must preserve that exact ordering (message-string match BEFORE code fallback) or a renamed RAISE silently changes the HTTP class (test-plan §6.4 F1 guard).
- `supabase-js` returns the error as `{ code, message, details, hint }` (PostgrestError). The mapper keys off `error.code` and `error.message` only.

## What We're NOT Doing

- **Not** the concurrency-choreographed integration repro of the real race (rejected as flaky per §6.6; the unit test on the extracted mapper is the deterministic proxy).
- **Not** changing the RPC, the FK definitions, or adding a pre-insert existence check in SQL — this is an API-layer error-mapping fix only.
- **Not** touching `friends/request.ts` or other routes — though the same harden-the-fallthrough rule applies, that is its own change.
- **Not** altering the behavior of any already-mapped code (`23505`/`23514`/`42501`/`22023`/message strings) — the extraction is behavior-preserving for those.

## Critical Implementation Details

- **Ordering is load-bearing.** The mapper must match the RPC message strings (`invitee not connected` → 403, `authentication required` → 401, `at least one invitee required` → 400, `too many invitees (max 50)` → 400) and the native codes (`23505`→422, `23514`→400) BEFORE the SQLSTATE fallbacks (`42501`→403, `22023`→400), exactly as the current ladder does. Put `23503`→404 alongside the other native-code checks. The safe-generic fallthrough is last.
- **The fallthrough must not swallow.** Log the raw error server-side (`console.error` with a stable prefix) so debugging signal is preserved (m3l5: log, don't swallow) — only the _client-facing body_ is genericized.

## Phase 1: Deterministic regression test + safe error mapper

### Overview

Run the full debugging-as-test cycle in one phase: write the failing unit test (RED), extract + implement the mapper and wire the route (GREEN), confirm no drift on existing codes (REFACTOR).

### Changes Required:

#### 1. Failing unit test (RED)

**File**: `tests/unit/meetings-errors.test.ts` (new)

**Intent**: Prove the contract deterministically before the fix exists. Importing the not-yet-created mapper fails the suite (RED); the `23503` and fallthrough cases are the regression lock.

**Contract**: Imports `mapCreateMeetingError` from `@/lib/meetings-errors`. Cases, each asserting `{ status, body }`:

- `{ code: "23503", message: "insert or update on table \"meeting_invitations\" violates foreign key constraint \"meeting_invitations_invitee_id_fkey\"" }` → `status 404`, and `JSON.stringify(body)` contains **no** `constraint` / `relation` / `23503` / `violates` substrings (the anti-leak assertion).
- An unmapped code (e.g. `{ code: "40001", message: "could not serialize access ..." }`) → `status 500`, body is the safe generic string, **no** raw message substring.
- Existing mapped paths unchanged: `23505`→422, `23514`→400, `invitee not connected`→403, `authentication required`→401, `at least one invitee required`→400, `too many invitees (max 50)`→400, `42501`→403, `22023`→400.

Pure function, no server/DB. Lives in the `unit` Vitest project (runs in CI + pre-push).

#### 2. The error mapper (GREEN)

**File**: `src/lib/meetings-errors.ts` (new)

**Intent**: Extract the route's inline ladder into a pure, testable function and add the missing `23503` branch + safe fallthrough.

**Contract**: `export function mapCreateMeetingError(error: { code?: string | null; message?: string | null }): { status: number; body: { error: string } }`. Preserves the existing ladder order (message strings + native codes before SQLSTATE fallbacks), adds `if (error.code === "23503") return { status: 404, body: { error: "not found" } }`, and ends with a fallthrough that `console.error`s the raw error (stable prefix, e.g. `"[meetings] unmapped RPC error"`) and returns `{ status: 500, body: { error: "unexpected error" } }`. No raw `error.message` in any returned body.

#### 3. Wire the route to the mapper

**File**: `src/pages/api/meetings/index.ts`

**Intent**: Replace the inline `if (error) { … }` ladder with a single call to the mapper, preserving the `json()` response shape.

**Contract**: In the `if (error)` block, compute `const { status, body } = mapCreateMeetingError(error); return json(body, status);`. The success path (`json({ meeting_id: data }, 201)`) and everything above the RPC call are untouched. Import `mapCreateMeetingError` from `@/lib/meetings-errors`.

### Success Criteria:

#### Automated Verification:

- [ ] The new test fails before the mapper exists (RED proof): `npm run test:unit` errors on the missing `@/lib/meetings-errors` import / failing assertions
- [ ] After GREEN, full unit suite passes: `npm run test:unit`
- [ ] Typecheck passes: `npm run typecheck`
- [ ] Touched files lint clean: `npx eslint tests/unit/meetings-errors.test.ts src/lib/meetings-errors.ts src/pages/api/meetings/index.ts`

#### Manual Verification:

- [ ] Integration suite still green with local Supabase up (`npm test`) — `tests/integration/api/validation.test.ts` + `authz.test.ts` confirm the refactor didn't drift any mapped code
- [ ] No `constraint` / `relation` / SQLSTATE / raw-message text appears in any mapped error body (anti-leak), verified by reading the new test's assertions and the mapper

**Implementation Note**: After automated verification passes, pause for manual confirmation (the integration regression guard needs local Supabase) before the phase-end commit.

---

## Testing Strategy

### Unit Tests:

- `tests/unit/meetings-errors.test.ts` — the deterministic regression lock for the `23503`→404 mapping and the safe-generic fallthrough, plus unchanged-behavior assertions for every existing code. Self-testing: must be shown RED before the mapper exists.

### Integration Tests:

- None added. The existing `tests/integration/api/validation.test.ts` (message-string + errcode mapping) and `authz.test.ts` serve as the refactor's regression guard — run them, don't change them.

### Manual Testing Steps:

1. Run `npm run test:unit` against the new test with no `src/lib/meetings-errors.ts` present — confirm RED.
2. Implement the mapper + wire the route — confirm `npm run test:unit` GREEN.
3. With local Supabase up, run `npm test` — confirm meetings validation/authz integration tests still pass.

## Performance Considerations

None — a pure synchronous function on an existing error path; zero added I/O.

## Migration Notes

None — no schema or data changes; API-layer only. The response contract for already-mapped codes is unchanged; the only behavior delta is `23503` (was raw-500, now 404) and unmapped codes (was raw-500, now safe generic 500 + server log).

## References

- Leak site: `src/pages/api/meetings/index.ts:66-88`
- Reference shape: `src/pages/api/friends/request.ts:76-81` (`23503`→404)
- RPC + FKs: `supabase/migrations/20260528105428_meetings_foundation.sql:149-206`
- Rule: `context/foundation/lessons.md` — "Map every errcode an RPC/RLS path can raise, or it leaks a raw-500"
- Origin: `context/foundation/test-plan.md` §6.6 (known latent leak)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Deterministic regression test + safe error mapper

#### Automated

- [x] 1.1 New test fails before the mapper exists (RED proof) — `npm run test:unit`
- [x] 1.2 Full unit suite passes after GREEN — `npm run test:unit`
- [x] 1.3 Typecheck passes — `npm run typecheck`
- [x] 1.4 Touched files lint clean — `npx eslint tests/unit/meetings-errors.test.ts src/lib/meetings-errors.ts src/pages/api/meetings/index.ts`

#### Manual

- [x] 1.5 Integration suite still green with local Supabase up (`npm test`) — validation + authz unchanged
- [x] 1.6 No constraint/relation/SQLSTATE/raw-message text in any mapped error body (anti-leak)
