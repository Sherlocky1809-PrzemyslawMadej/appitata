<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Friend Connection Handshake (S-01)

- **Plan**: context/changes/friend-connection-handshake/plan.md
- **Scope**: Full plan — Phases 1–3
- **Date**: 2026-05-28
- **Verdict**: APPROVED
- **Findings**: 0 critical | 2 warnings | 6 observations
- **Triage**: 2026-05-28 — 2 fixed (F4, F8), 1 commented (F3), 3 skipped (F5, F6, F7), 2 disagreed (F1, F2 — lint confirmed the original code was right)

## Verdicts

| Dimension           | Verdict                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| Plan Adherence      | PASS (2 minor drifts, both reasoned)                                                    |
| Scope Discipline    | PASS (1 forced adaptation, documented)                                                  |
| Safety & Quality    | WARNING (2 warnings — Reliability / Pattern)                                            |
| Architecture        | PASS                                                                                    |
| Pattern Consistency | PASS                                                                                    |
| Success Criteria    | PASS (Progress fully `[x]`; manual verified via Playwright + screenshots on 2026-05-28) |

## Findings

### F1 — `React.SubmitEvent` is not a real React type

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/auth/SignUpForm.tsx:73, src/components/friends/FriendSearch.tsx:16, src/components/auth/SignInForm.tsx:36 (pre-existing)
- **Detail**: Form submit handlers are typed `React.SubmitEvent<HTMLFormElement>`, which doesn't exist in `@types/react`. The DOM has a `SubmitEvent` global, but the React idiom is `React.FormEvent<HTMLFormElement>`. Currently compiles via structural inference (effectively `any`) — silent type-safety loss. SignInForm.tsx had it first; the bug propagated to both new files in this change.
- **Fix**: Replace `React.SubmitEvent<HTMLFormElement>` with `React.FormEvent<HTMLFormElement>` in all three files.
- **Decision**: DISAGREED 2026-05-28 — the finding is inverted. In this project's `@types/react` (React 19), `React.FormEvent` is the deprecated alias and `React.SubmitEvent` is the recommended modern type. `@typescript-eslint/no-deprecated` flags `FormEvent` and lists `SubmitEvent` among the suggested replacements when the fix was attempted. Reverted to the original `React.SubmitEvent<HTMLFormElement>` in all three files.

### F2 — `friends.astro` assigns possibly-null `.data` without null-coalesce

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src/pages/friends.astro:46-48
- **Detail**: `incoming` / `outgoing` / `friends` are declared as `let [...]: T[] = []` then assigned `incomingRes.data` etc. Supabase typings allow `data: T[] | null`. Today the queries always return `[]` not `null`, so the runtime behaviour is correct, but the assignment is type-narrowing by accident. A future SDK update or filter that hits the null path would propagate null into child components that iterate without a guard.
- **Fix**: Change each assignment to `incoming = incomingRes.data ?? [];` (and the two siblings). 3-minute hardening, no UX impact.
- **Decision**: DISAGREED 2026-05-28 — TypeScript narrows `.data` to non-null in the else branch of the `.error` ladder (Supabase's typed client uses a `{ data: T[]; error: null } | { data: null; error: PostgrestError }` discriminated union). `@typescript-eslint/no-unnecessary-condition` flags the `??` because the LHS is provably non-null at that point. The control flow already gates `loadError` on every `.error` branch, so `null` cannot reach the assignment. Reverted.

### F3 — TOCTOU window between `is_connected` RPC and INSERT

- **Severity**: 📍 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src/pages/api/friends/request.ts:53-69
- **Detail**: The plan's F2 pre-INSERT guard (`rpc("is_connected") → INSERT`) is a classic check-then-act race. Two concurrent reverse-direction requests (A→B and B→A from different sessions) could both observe `is_connected = false` and both INSERT — producing two pending rows that are both legal under `UNIQUE(requester_id, addressee_id)` because direction differs. Worst case is two dangling pending rows (UI weirdness, not data corruption).
- **Fix A ⭐ Recommended**: Accept the race for MVP; revisit if it ever surfaces
  - Strength: Zero new code; current behaviour is degraded UX, not unsafe. The target_scale is "qps: low" so the window is extremely narrow in practice.
  - Tradeoff: Carries a known footgun; would surprise a future reader. Worth a one-line comment at the call site ("race tolerated — worst case is dual pendings").
  - Confidence: HIGH — DB constraints prove the safety bound.
  - Blind spot: None significant for MVP.
- **Fix B**: Move check+insert into one SECURITY DEFINER RPC
  - Strength: Atomic. Removes the window entirely.
  - Tradeoff: New SQL artifact, type regen, more surface to maintain.
  - Confidence: MEDIUM — would need to recreate is_connected's semantic in the new function or inline it.
  - Blind spot: Whether the cost (one more RPC) is worth the benefit (zero dangling pendings under low qps).
- **Decision**: ACCEPTED AS RISK 2026-05-28 — Fix A. Tolerated-race comment added at the pre-INSERT guard in src/pages/api/friends/request.ts.

### F4 — `find_parent_by_handle` phone branch matches non-`+`-prefixed inputs

- **Severity**: 📍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Validation)
- **Location**: supabase/migrations/20260527103435_friend_connections_foundation.sql:158-170
- **Detail**: `phone_norm = regexp_replace(handle, '[^0-9+]', '', 'g')` strips everything but digits and `+`. An input like `1234@example.com` becomes phone_norm `1234`, then `p.phone = '1234'` matches any parent whose phone is literally `1234`. Real parents have `+E.164` phones (signup form enforces the `+` prefix), so risk is low — but `phone_norm` isn't required to start with `+`.
- **Fix**: Anchor the phone branch — add `and starts_with(n.phone_norm, '+')` (or `n.phone_norm ~ '^\+[0-9]+$'`) to the WHERE clause.
- **Decision**: FIXED 2026-05-28 — follow-up migration `20260528120000_find_parent_by_handle_anchor_phone.sql` redefines the function with `starts_with(n.phone_norm, '+')` guarding the phone branch. Re-run `npm run db:reset && npm run db:types` next time the local Supabase stack is up.

### F5 — UUID regex used instead of `z.string().uuid()` per plan

- **Severity**: 📍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/pages/api/friends/requests/[id].ts
- **Detail**: Plan §"Phase 2 / 6" specified `z.string().uuid()` for the path param. Actual implementation uses a custom `UUID_SHAPE` regex consistent with request.ts and respond.ts (their inline comments document that fixture UUIDs may not have RFC 4122 version nibbles). Functionally equivalent for the planned use-cases; the divergence is intentional and well-reasoned.
- **Fix**: None — the actual choice is the right one. If wanting to tighten contract↔implementation, update the plan note rather than the code.
- **Decision**: SKIPPED 2026-05-28 — implementation is the right call; UUID_SHAPE matches the sibling routes and tolerates fixture UUIDs. Plan text divergence left as-is (change is closing out).

### F6 — `ConnectedFriendsList` props omit `email` (plan-text/RPC mismatch)

- **Severity**: 📍 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: src/components/friends/ConnectedFriendsList.astro
- **Detail**: Plan §"Phase 3 / 5" listed props as `{ id, display_name, email }[]` so the UI could fall back to email when display_name is null. Actual props are `{ id, display_name }[]` because `list_my_friends()` (designed in Phase 1 §5) only returns those two columns. The plan text contradicts its own RPC shape; the implementation correctly follows the RPC. The `.astro` renders "Unnamed parent" in the fallback path instead of the email.
- **Fix A ⭐ Recommended**: Leave as-is; update plan text or doc the choice
  - Strength: For new signups the trigger always populates display_name (validated as required in signup.ts), so the email fallback would only fire for pre-S-01 accounts — a transient population that will vanish after one cycle of fresh signups.
  - Tradeoff: "Unnamed parent" is a slightly odd UX if a fallback ever fires; less informative than email.
  - Confidence: HIGH — signup is now the only path that materialises parents and it requires display_name.
  - Blind spot: Existing seed/dev accounts with null display_name (`apitata1@example.com` from prior testing).
- **Fix B**: Extend `list_my_friends` to return email; update component
  - Strength: Plan text becomes truth; "Unnamed parent" never shows.
  - Tradeoff: Type regen, RPC churn, exposes email on the connected-friends list (minor privacy-posture choice).
  - Confidence: HIGH — straightforward SQL edit.
  - Blind spot: Whether email-on-connected-list is desired UX or oversharing (PRD §FR-009 says display_name is the identity-confirming field).
- **Decision**: SKIPPED 2026-05-28 — Fix A. Signup requires display_name, so the "Unnamed parent" fallback only fires for dev/seed accounts and disappears after one cycle of fresh signups. PRD §FR-009 makes display_name the identity field; adding email to list_my_friends would be a privacy posture shift, not a fix.

### F7 — `eslint.config.js` relaxed for `db.types.ts` (unplanned, forced)

- **Severity**: 📍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: eslint.config.js:75-86,92-101
- **Detail**: Not in the plan. The change adds two more rule disables (`no-redundant-type-constituents`, `prettier/prettier`) for `src/db/database.types.ts` and reorders so `dbTypesConfig` lands AFTER `eslintPluginPrettier` (otherwise the prettier override is re-enabled). Triggered by the new friend_connections types regenerated in Phase 1. Inline comments document the why. This is forced adaptation, not scope creep — AGENTS.md prohibits hand-editing `database.types.ts`, so the config must absorb the new shapes.
- **Fix**: None. The decision is correct; the inline comments (eslint.config.js:71-76, 96-99) are the right form of documentation.
- **Decision**: SKIPPED 2026-05-28 — forced adaptation, already documented inline. No further action.

### F8 — `request.ts` FK error (code 23503) maps to 500, not 404

- **Severity**: 📍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src/pages/api/friends/request.ts
- **Detail**: If `addressee_id` is a valid-UUID-shape but no parents row exists (e.g., the addressee was deleted between search and request), the INSERT fails with FK error 23503. That code isn't in the error-code branch list and falls through to the generic 500 with the raw Postgres message. A clean 404 would match the rest of the API surface.
- **Fix**: Add a branch `if (error.code === "23503") return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });` alongside the existing 23505/23514 handlers.
- **Decision**: FIXED 2026-05-28 — 23503 branch added alongside the existing 23505/23514 handlers in src/pages/api/friends/request.ts.

## Clean areas (no findings)

- **API auth gating** — all four routes correctly 401 before reading the body.
- **Zod validation** — every route validates input shape with zod.
- **RLS surface** — column-level UPDATE GRANT after REVOKE (load-bearing per AGENTS.md), pending-only UPDATE USING, requester-only DELETE USING, SECURITY DEFINER with locked `search_path`, two RPCs correctly grant-executed to `authenticated`.
- **`parents_select` widening** — scoped to "viewer is one of the two FC parties"; test block 6 explicitly verifies outsider cannot see the row.
- **Type imports** — components use colocated interfaces; supabase client is properly typed via `Database` generic.
- **Middleware** — `/friends` correctly added to `PROTECTED_ROUTES`.
- **Search RPC excludes self** — `p.id <> auth.uid()` inside the function, not relying on the API layer.
- **`window.location.reload()` after mutations** — heavy but correct for MVP; avoids stale-state foot-guns in React.
