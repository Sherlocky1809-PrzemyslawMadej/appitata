# Friend Connection Handshake — Plan Brief

> Full plan: `context/changes/friend-connection-handshake/plan.md`

## What & Why

Ship S-01: the friend-request handshake that lets two parents who already know each other become **connected** in AppiTata, gated by an explicit accept (never automatic). This is the prerequisite for every meetings slice (S-02/S-03) — until two parents are connected, neither can invite the other to anything. The slice also closes FR-002 through FR-005 in one stroke.

## Starting Point

F-01 shipped the `parents` table, the `on_auth_user_created` trigger that mirrors `auth.users` into `parents`, and the `public.is_connected(viewer, owner)` RLS template — currently stubbed as `select viewer = owner`. The signup form collects only email + password, so `parents.phone` and `parents.display_name` are nullable columns that are always null. There is no API surface beyond auth, no `/friends` page, and no `friend_connections` table. F-01's plan and helper comment both explicitly promised that S-01 would extend the helper and add the table.

## Desired End State

A signed-in parent visits `/friends`, types another parent's email or phone, sees the matched display name, and clicks "Send request". The other parent signs in, sees the request in their Incoming list, accepts it, and the two now appear in each other's Connected friends list. Pending requests can be cancelled by the sender; declined rows persist and permanently block re-requests from the same direction. The privacy NFR holds end-to-end: a non-connected parent cannot read any other parent's row through any code path; the only way past `parents_select` is the `SECURITY DEFINER` lookup RPC, which returns at most one minimal row and never includes the caller.

## Key Decisions Made

| Decision                         | Choice                                                     | Why (1 sentence)                                                                                                               | Source |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `friend_connections` shape       | Directional row + status enum                              | Single source of truth; "A requested B" is natural; "list all my friends" solves in one query via UNION on requester/addressee | Plan   |
| Capture `display_name` + `phone` | Extend signup form (display_name required, phone optional) | Captures both at the moment we already have the user's attention; FR-002 phone-search becomes usable immediately               | Plan   |
| Declined-request policy          | Blocked forever (per directional UNIQUE)                   | Avoids harassment-vector mechanics with zero added state; reverse direction still allowed since the UNIQUE is directional      | Plan   |
| Search response payload          | `{ id, display_name }` only                                | Searcher already knows the handle they typed; display_name confirms identity without echoing handles back                      | Plan   |
| Search input handling            | Light normalization + exact match; silent zero for self    | Forgiving of common input differences; silent self-zero matches the privacy NFR                                                | Plan   |
| `/friends` page sections         | Search + Incoming + Outgoing + Connected (4 sections)      | Outgoing surface is required because Q7 says cancel must work; first three are FR-002/004/005 outright                         | Plan   |
| Outgoing pending visibility      | Visible + cancellable (DELETE row)                         | Clear feedback that the request is in flight; recovers from mis-clicks without complicating the decline policy                 | Plan   |

## Scope

**In scope:**

- `friend_connections` table + enum + indexes + RLS + column-level UPDATE grant
- Extended `is_connected` body (covers accepted connections in either direction)
- `find_parent_by_handle(text)` SECURITY DEFINER lookup RPC
- Updated `handle_new_user` reading `display_name` + `phone` from `auth.users.raw_user_meta_data`
- Signup form extension (display_name required, phone optional, zod-validated)
- Four new JSON API routes: search, request, respond, cancel (all zod-validated)
- New `/friends` Astro page with four React-island sections
- Middleware update + dashboard link
- Seed fixture update (display_name/phone for Alice/Bob + one accepted FC) and refreshed RLS test docs

**Out of scope:**

- Meetings, invitations, conflict checks (S-02 and S-03)
- Unfriend / disconnect (no FR for it; v2)
- Profile editing UI (display_name / phone are write-once at signup for now)
- Blocking a parent (declined-row-blocks-re-request covers harassment)
- Real-time updates (page reload after mutation is enough at MVP scale)
- Avatars, phone verification, email verification, social login
- Profile-completion forced redirect for pre-S-01 accounts
- Remote-Supabase migration push, pgTAP tests, CI gates beyond lint+build

## Architecture / Approach

Three thin layers, one per phase:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 3 — UI                                                        │
│  /friends.astro ──► FriendSearch │ IncomingList │ OutgoingList │     │
│                                  │              │ ConnectedList      │
└──────────────────────────────────────────────────────────────────────┘
                              │ fetch JSON
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 2 — API (all zod-validated)                                   │
│  POST /api/friends/search       → find_parent_by_handle RPC          │
│  POST /api/friends/request      → INSERT friend_connections          │
│  POST /api/friends/respond      → UPDATE status (RLS pinned)         │
│  DELETE /api/friends/requests/[id] → DELETE pending row              │
│  POST /api/auth/signup (extended) → forwards data via metadata       │
└──────────────────────────────────────────────────────────────────────┘
                              │ supabase-js (typed)
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 1 — Data layer (one atomic migration)                         │
│  friend_connections (directional rows + status enum)                 │
│  is_connected(viewer, owner) ← extended body                         │
│  handle_new_user() ← reads raw_user_meta_data                        │
│  find_parent_by_handle(handle) ← new SECURITY DEFINER RPC            │
└──────────────────────────────────────────────────────────────────────┘
```

RLS pins every operation at the database boundary: requester INSERT/DELETE, addressee UPDATE-status-only (via column-level GRANT, not just WITH CHECK), both endpoints SELECT. The lookup RPC is the only intentional bypass — it returns minimal data and filters out the caller.

## Phases at a Glance

| Phase                 | What it delivers                                                               | Key risk                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Data layer         | Migration + extended helper + RPC + seed/test-doc updates; DB usable from psql | RLS UPDATE column restriction needs column-level GRANT, not just WITH CHECK — easy to ship a "you can edit anyone's row" hole otherwise |
| 2. Server-side wiring | Signup form extension + 4 zod-validated friend-handshake API routes            | Forgetting to forward `options.data` in `supabase.auth.signUp` makes the trigger read null metadata and silently breaks phone search    |
| 3. UI + integration   | `/friends` page with 4 sections, middleware update, dashboard link             | The four React islands must stay in sync after mutations — chose page reload (simplest) over real-time, accept the UX cost at MVP scale |

**Prerequisites:** F-01 archived ✓. Docker Desktop installed and running for `supabase start`. No production-side prep — S-01 stays local.

**Estimated effort:** ~3 sessions across 3 phases (data → server → UI), each landing one atomic commit.

## Open Risks & Assumptions

- The "block forever on decline" policy may surprise a user who declined by mis-click. Acceptable given the personal-friends use case; revisit if real users complain.
- Phone normalization in the RPC strips all non-digits except a leading `+`. Inputs without a leading `+` will normalize to digits-only and miss real `+48...` numbers. The signup form's phone hint should make the `+` requirement clear; if real users still get this wrong, add server-side `+` prefixing in the RPC.
- The signup form change is the only place metadata gets captured. Pre-S-01 accounts (the one dev account from F-01 testing) stay null until that user re-signs-up or backfills manually. Not gating for MVP; revisit if launch users come in pre-signup.
- The connected-friends list query uses RLS-on-parents filtering rather than a dedicated view. If S-02 adds another "list parents" surface, consider extracting a `my_friends` view; not worth the abstraction in S-01.

## Success Criteria (Summary)

- A new parent signs up with display_name + phone, finds another parent by email or phone via `/friends`, sends a request, the other parent accepts, and both see each other in the Connected friends list — all without typing SQL.
- The `parents-rls.md` + new `friend-connections-rls.md` SQL block walkthroughs produce their documented row counts, proving RLS extension correctness end-to-end.
- The full handshake state machine works: pending → accepted (visible to both), pending → declined (block holds), pending → cancelled (row removed), already-connected → 409, self-request → 422.
