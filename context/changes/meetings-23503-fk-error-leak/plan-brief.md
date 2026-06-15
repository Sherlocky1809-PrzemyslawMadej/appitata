# Map 23503 FK-violation to a safe 404 in POST /api/meetings — Plan Brief

> Full plan: `context/changes/meetings-23503-fk-error-leak/plan.md`

## What & Why

`POST /api/meetings` maps several Postgres errcodes but not `23503` (FK violation), so an unmapped FK error falls through to `json({ error: error.message }, 500)` and leaks the raw Postgres message (`relation`/`constraint`/SQLSTATE text) to the client. This closes that leak — and the whole leak _class_ — using the m3l5 debugging-as-test cycle: make the bug a deterministic failing test first, then fix.

## Starting Point

The route's error handling is an inline `if (error) { … }` ladder ([meetings/index.ts:66-88](../../../src/pages/api/meetings/index.ts#L66)) with no `23503` branch and a raw-message fallthrough. The sibling `friends/request.ts:79` already maps `23503`→404. The route can't be unit-imported (it pulls `astro:env/server`), so the ladder isn't currently unit-testable.

## Desired End State

A pure `mapCreateMeetingError(error) → {status, body}` helper owns the mapping; the route delegates to it. `23503`→404 `{error:"not found"}`; any unmapped code → safe generic 500 with the raw error logged server-side (never returned). A deterministic unit test pins `23503`, the fallthrough, and the unchanged behavior of every existing code.

## Key Decisions Made

| Decision              | Choice                              | Why (1 sentence)                                                                                                                  | Source |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Reproduction strategy | Extract mapper + unit test          | The real 23503 race isn't deterministically reproducible; a pure mapper makes the contract testable without server/DB.            | Plan   |
| Fix scope             | 23503→404 **+** harden fallthrough  | Closes the entire leak class per lessons.md ("any unmapped errcode must still return a safe generic message"), not just one code. | Plan   |
| Process               | Formal change → `/10x-tdd`          | Matches repo convention and test-plan §6.6 ("a fix is its own change").                                                           | Plan   |
| Don't-swallow         | `console.error` raw, return generic | m3l5: preserve debugging signal server-side without leaking it to the client.                                                     | Plan   |

## Scope

**In scope:** extract `mapCreateMeetingError` to `src/lib/`; add `23503`→404 + safe fallthrough; wire `meetings/index.ts`; one deterministic unit test.

**Out of scope:** the concurrency race repro; RPC/FK/schema changes; other routes; any behavior change to already-mapped codes.

## Architecture / Approach

Pure-function extraction. The route keeps its `json()` response shape but replaces the inline ladder with `const {status, body} = mapCreateMeetingError(error); return json(body, status);`. The mapper preserves the existing order (RPC message strings + native codes before SQLSTATE fallbacks), adds the `23503` branch, and ends with a logging, safe-generic fallthrough.

## Phases at a Glance

| Phase                                                 | What it delivers                                            | Key risk                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1. Regression test + safe mapper (red→green→refactor) | Failing unit test → mapper + route wiring → green, no drift | Ordering drift: message-string matches must stay before SQLSTATE fallbacks (test-plan §6.4 F1 guard) |

**Prerequisites:** none for unit (CI-portable); local Supabase only for the integration regression guard.
**Estimated effort:** ~1 short session, single phase.

## Open Risks & Assumptions

- Assumes the refactor preserves every mapped code's status/body exactly — guarded by the unchanged-behavior unit assertions plus the existing integration suite.
- The raw FK message moves from the HTTP body to server logs; assumed acceptable (that exposure was the vulnerability).

## Success Criteria (Summary)

- A `23503` from the meetings RPC yields a 404 with no DB internals in the body.
- Any unmapped errcode yields a safe generic 500 (raw error in logs only).
- The unit test is RED before the mapper exists and GREEN after; existing mapped codes and the integration suite are unaffected.
