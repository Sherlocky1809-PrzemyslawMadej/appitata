/**
 * seed.spec.ts — the canonical E2E model for AppiTata (test-plan §6.3).
 *
 * This is the example every generated `tests/e2e/*.spec.ts` is modeled on:
 * what the seed shows, generated tests reproduce. It is a COMPLETE, RUNNABLE
 * test of the highest browser-level risk (Risk #3, silent double-booking) — not
 * a skipped sketch — so the patterns below are demonstrated end-to-end, the way
 * the skill's seed-test-pattern.md and e2e-quality-rules.md require. The durable
 * E2E rules live alongside it in `tests/e2e/E2E-RULES.md`.
 *
 * The seven rules this file embodies (E2E-RULES.md):
 *   1. getByRole / getByLabel / getByText are primary; getByTestId only for
 *      role-less containers with no accessible name.
 *   2. No CSS selectors, XPath, or DOM-structure locators.
 *   3. Each test is independently runnable — its own setup, action, assertion,
 *      and cleanup; no shared state, no ordering between tests.
 *   4. Never `waitForTimeout`; wait for state (toBeVisible / waitForResponse).
 *   5. Assert the business outcome, not an implementation detail.
 *   6. Unique identifiers for test data; clean up in afterEach.
 *   7. Auth via storageState (auth.setup.ts) — never log in through the UI here.
 *
 * Plus the project-specific silent-pass guard (test-plan §6.4): every "it
 * renders" assertion is paired with an absence control, so a selector that can
 * never match cannot pass green.
 *
 * Run: `npm run test:e2e` (local Supabase up + `npx playwright install chromium`).
 */

import { test, expect, request as apiRequest, type APIRequestContext } from "@playwright/test";

const ALICE_AUTH = "tests/e2e/.auth/alice.json";
const BOB_AUTH = "tests/e2e/.auth/bob.json";
// Seeded identity (supabase/seed.sql): Bob is Alice's accepted friend / invitee.
const BOB_ID = "00000000-0000-0000-0000-000000000b01";
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:4321";

// Rule 7: this spec drives the browser AS BOB (the parent who receives the
// invitations and sees the conflict warning); his session comes from the saved
// storageState, not a UI login.
test.use({ storageState: BOB_AUTH });

test.describe("[Risk #3] silent double-booking — the conflict warning must fire", () => {
  // Alice (the meeting creator) acts through an API context built from her own
  // storageState — fixture setup over UI typing keeps the test deterministic.
  let alice: APIRequestContext;
  const createdMeetingIds: string[] = [];

  test.beforeEach(async () => {
    alice = await apiRequest.newContext({ baseURL: BASE_URL, storageState: ALICE_AUTH });
    createdMeetingIds.length = 0;
  });

  // Rule 6 / anti-pattern #5: delete every meeting this test created so a re-run
  // starts clean even after a crash. Alice owns them (creator-DELETE → 204; the
  // FK cascade removes the invitations).
  test.afterEach(async () => {
    for (const id of createdMeetingIds) {
      await alice.delete(`/api/meetings/${id}`, { headers: { Origin: BASE_URL } });
    }
    await alice.dispose();
  });

  async function aliceInvitesBob(startsAt: string, description: string): Promise<void> {
    const res = await alice.post("/api/meetings", {
      headers: { Origin: BASE_URL },
      data: {
        starts_at: startsAt,
        duration_minutes: 60,
        street: "Main St 1",
        city: "Warsaw",
        postal_code: "00-001",
        country: "Poland",
        description,
        invitee_ids: [BOB_ID],
      },
    });
    expect(res.status(), `create meeting "${description}"`).toBe(201);
    const body = (await res.json()) as { meeting_id: string };
    createdMeetingIds.push(body.meeting_id);
  }

  test("warning surfaces on an overlapping pending invite, and is absent before the overlap exists", async ({
    page,
  }) => {
    // Rule 6: a unique marker per run so rows are identifiable and re-runs can't
    // collide. Both meetings share one start time → a guaranteed overlap
    // (half-open [start, end); back-to-back would NOT clash, src/lib/conflicts.ts).
    const tag = `e2e-${crypto.randomUUID()}`;
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await aliceInvitesBob(startsAt, `${tag} first`);
    await aliceInvitesBob(startsAt, `${tag} second`);

    await page.goto("/meetings");

    // Rule 1/2: each invitation is found by its unique description. The <li> row
    // is a role-less container with no accessible name, so getByTestId is the
    // justified fallback; everything with a role is reached by role below.
    const firstRow = page.getByTestId("pending-invitation").filter({ hasText: `${tag} first` });
    const secondRow = page.getByTestId("pending-invitation").filter({ hasText: `${tag} second` });
    await expect(firstRow).toBeVisible();
    await expect(secondRow).toBeVisible();

    // Silent-pass control (test-plan §6.4): neither invite is on Bob's schedule
    // yet, so NO warning should show. This proves the positive assertion below
    // can actually fail — a never-matching selector would pass without it. The
    // warning copy is "…this overlaps with:", so getByText is preferred over a
    // test-id here (rule 1).
    await expect(secondRow.getByText(/overlaps/i)).toHaveCount(0);

    // Rule 1: reach the button by ROLE, not a test-id. Rule 4: wait for the
    // `client:visible` island to hydrate via actionability, never a sleep.
    const accept = firstRow.getByRole("button", { name: /accept/i });
    await accept.scrollIntoViewIfNeeded();
    await expect(accept).toBeEnabled();
    // Accepting fires a POST, then the component reloads the page. Wait for the
    // response (state), not a fixed timeout (rule 4).
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/meetings/invitations/respond") && r.request().method() === "POST",
      ),
      accept.click(),
    ]);
    await page.waitForLoadState("domcontentloaded");

    // Rule 5: the business outcome the risk is about. The first meeting is now
    // on Bob's schedule, so the still-pending second invite overlaps it — the
    // warning must render. Re-query after the reload; web-first assertions
    // auto-retry through it.
    const secondRowAfter = page.getByTestId("pending-invitation").filter({ hasText: `${tag} second` });
    await expect(secondRowAfter.getByText(/overlaps/i)).toBeVisible();
  });
});
