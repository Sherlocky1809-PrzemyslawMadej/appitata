# Invitation 24h-expiry behaviour (S-04 / test-plan Risk #5)

Behavioural-proof doc for the 24h invitation-expiry surface. It is the **spec** the
expiry integration suite (`tests/integration/invitation-expiry.test.ts`) cites — the
test expectations are derived from the numbered observables below, **not** lifted from
the sweep/RLS SQL (the tautology trap, test-plan §6.2/§6.5). Each block states what is
_observable_ (a status flip, a returned count, an HTTP code), never the predicate that
produces it.

Expiry is enforced across **three coupled layers** that must move together (`lessons.md`):

- the `expire_stale_invitations()` sweep RPC (`status = 'pending' AND invited_at < now() - 24h`, strict `<`),
- the `meeting_invitations_update` RLS USING clause (`invited_at > now() - 24h`, strict `>`, the lazy accept-block), and
- the `/meetings` Pending read filter (`invited_at > now - 24h`).

All three key on `invited_at` (`timestamptz not null default now()`). The durable oracle is
the **behaviour** — a >24h pending invite cannot be accepted and is swept to `expired` — not
any single SQL clause.

## Fixture

Created at runtime over the real RLS path: Alice (`…a01`) creates a meeting via
`create_meeting_with_invitations` inviting Bob (`…b01`, accepted-connected to Alice in the
seed); the resulting `pending` invitation is then aged by a `serviceClient().update({invited_at})`
(RLS-bypass, fixture-only — never an isolation assertion). Several invitations are aged to
different points relative to the 24h cutoff:

- **stale** — `now() - 25h` (clearly past the cutoff)
- **boundary** — `now() - 24h - 1m` (just past the cutoff; aged a minute beyond the edge so the fail-closed
  →404 assertion never depends on sub-second elapsed-time or client-vs-DB clock skew)
- **under** — `now() - 23h` (clearly inside the window)
- **fresh** — default `now()` (just created)

## 1. A >24h pending invite is swept to `expired`

Running the sweep flips the **stale** invitation from `pending` to `expired`, and the integer
the RPC returns counts it among the rows swept (count ≥ 1). Assert on the specific row id —
the count is global (the sweep is cross-user), so a bare count is not a safe oracle.

> A stale invite that stays `pending` after the sweep means the predicate or the
> `service_role` execute grant is broken — stop and re-check the migration.

## 2. A <24h pending invite is left untouched

The **under** invitation (`now()-23h`, well inside the window) is **not** swept — it stays
`pending` across the sweep. This proves the sweep's strict `<` does not over-collect a
near-boundary-but-fresh row.

## 3. The sweep is idempotent

After the first sweep has expired every stale row, a second `expire_stale_invitations()`
call returns `0` and re-touches nothing — the already-`expired` row keeps its status (and is
not re-stamped). Idempotency is what makes the cron safe to fire on any cadence.

## 4. The sweep does not stamp `responded_at`

Expiry is **not** a user response. On a swept (now-`expired`) invitation, `responded_at`
stays `null`. Only an accept/decline through the respond endpoint stamps it.

## 5. Lazy RLS accept-block — a stale invite is un-acceptable _before_ any sweep

This is the load-bearing assertion: RLS enforces expiry **independently of the cron**. With a
stale invitation (`now()-25h`) that has **not** been swept (still `pending` in the table), the
invitee's `POST /api/meetings/invitations/respond` (`action: "accept"`) returns **404** — the
RLS USING freshness predicate filters the row out, `respond.ts`'s `.maybeSingle()` returns
null, and the existing 404 mapping covers it with no endpoint change. The paired positive
control: a **fresh** invitation accepts (**200**) and the side-effect lands (`status='accepted'`,
`responded_at` stamped), read out-of-band via `serviceClient()`.

The 404 is only meaningful when the acting session is proven authenticated (a no-session 404 is
byte-identical to an expired-invite 404 — the HTTP silent-pass trap): the suite signs in over
the real `/api/auth/signin` route (asserting `302 → /`) and pairs every 404 with the live 200
control.

## 6. Boundary (≈24h) is fail-closed, and the sweep boundary is strict

A pending invitation aged to the **boundary** (`now()-24h`) is **un-acceptable**: respond →
**404** (it has crossed the strict `>` accept window by the time the request runs) and it is
absent from the `/meetings` Pending section. This is intended **fail-closed** behaviour, never
a bug — at the boundary the safe default is "cannot act", not "can act".

The exact instant where a row is **neither** swept **nor** acceptable — `invited_at` precisely
equal to `now()-24h` against the _same_ `now()` (both predicates strict, so both false) — exists
only under a **frozen clock**, i.e. within a single transaction where `now()` (transaction start)
is one fixed value. Across wall-clock time `now()` advances, so a boundary-aged row is fail-closed
to users **and** is collected by the sweep once it crosses 24h. The integration suite therefore
asserts the two robust halves separately: the boundary row is un-acceptable (→404, block 6 here),
and the sweep's strict lower edge does not collect a clearly-under-24h row (block 2). The
single-transaction "neither" instant is documented here as the formal exclusive-boundary
semantic, not asserted live across separate RPC calls.
