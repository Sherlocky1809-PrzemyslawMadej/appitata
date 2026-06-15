# E2E Testing Rules (AppiTata / Playwright)

The agent reads this before generating any `tests/e2e/*.spec.ts`. It constrains
output so generated tests are stable by default — agents apply known patterns
far more reliably than they invent new ones. The companion lever is
[seed.spec.ts](./seed.spec.ts): the runnable model every generated test copies.
What the seed shows, generated tests reproduce.

## The rules block

- Use `getByRole`, `getByLabel`, `getByText` as primary locators. Fall back to
  `getByTestId` only when accessibility attributes are ambiguous or the element
  is a role-less container with no accessible name (e.g. AppiTata's
  `pending-invitation` `<li>`). Never `getByTestId` for something that has a role.
- Never use CSS selectors, XPath, or DOM structure for locating elements.
- Each test must be independently runnable — its own setup, action, assertion,
  and cleanup; no shared state or ordering between tests.
- Never use `page.waitForTimeout()`. Wait for specific conditions:
  `toBeVisible()`, `waitForURL()`, `waitForResponse()`.
- Assert the business outcome, not implementation details.
- Use unique identifiers (e.g. `crypto.randomUUID()` woven into the data) for
  test data to avoid collisions in parallel runs. Clean up in `afterEach` (or
  teardown-before-setup) so a re-run starts clean even after a crash.
- Use `storageState` for authentication (see [auth.setup.ts](./auth.setup.ts)) —
  never log in through the UI in individual tests.

## Governing rules (the reasoning)

- **Don't generate E2E tests from scratch.** Start from
  `context/foundation/test-plan.md` §2: pick the 2–3 highest risks that need
  browser-level coverage and feed them as input. A risk needs E2E when it
  crosses several system boundaries (auth → routing → API → RLS → rendered UI)
  or exists only in the rendered UI; if an isolated function proves it, a unit
  test is enough (e.g. the overlap math itself lives in `tests/unit/`, not here).
- **E2E ≠ zero mocking.** Internal boundaries (auth, routing, Supabase RLS) stay
  real — that is where integration risk hides. Mock only expensive /
  non-deterministic external APIs at the network layer (AppiTata has none today).
- **Name the test after the risk:** `[Risk #3] the conflict warning must fire`,
  not `test('conflict test')`. A red run then points at the business risk that
  regressed.
- **The assertion must fail if the risk materializes.** Control question for
  every assertion: would this fail if the §2 risk came true? If not, it is
  decorative. In AppiTata this is enforced with a paired **absence control**
  (assert the warning is absent before the overlap exists) — the silent-pass
  guard from test-plan §6.4.

## The five agent anti-patterns to review against

Review every generated test against `e2e-anti-patterns.md`
(`.claude/skills/10x-e2e/references/`): (1) hallucinated assertion,
(2) brittle selector, (3) shared state between tests, (4) `waitForTimeout`
instead of waiting for state, (5) no cleanup. Re-prompt by **naming the
anti-pattern** — what's wrong, why it doesn't protect the risk, what replaces
it — never "fix this test".

## AppiTata specifics

- **Seeded identities** (`supabase/seed.sql`, all password `test1234`): Alice
  (`…a01`, creator) and Bob (`…b01`, accepted friend / invitee). `storageState`
  for both is minted by [auth.setup.ts](./auth.setup.ts).
- **Two-actor flows** (most AppiTata flows): the spec drives the browser as one
  parent via `test.use({ storageState })`; the other parent acts through an API
  context (`request.newContext({ storageState })`) for fixture setup + teardown.
- **Hydration:** the conflict warning is server-rendered and assertable
  immediately; only the Accept button needs its `client:visible` island —
  `scrollIntoViewIfNeeded()` + `toBeEnabled()` before clicking, never a sleep.
- **Scope:** one e2e, the north-star co-care conflict flow (test-plan §3 Phase
  4). Do not e2e every page; do not add multimodal/vision review — the surface
  is deterministic DOM.
