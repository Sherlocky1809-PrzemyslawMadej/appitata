import { test as setup, expect } from "@playwright/test";

// Authentication setup project (playwright.config.ts → project "setup").
// Logs each seeded parent in over HTTP and persists the resulting cookie jar as
// a storageState file. Every spec reuses these instead of logging in through the
// UI in individual tests (e2e rule 7 / seed-test-pattern.md). Runs once, before
// the chromium project, via `dependencies: ["setup"]`.

const AUTH_DIR = "tests/e2e/.auth";
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:4321";

// Seeded identities (supabase/seed.sql); all share password `test1234`.
//   Alice — meeting creator; Bob — accepted friend / invitee.
const USERS = {
  alice: { email: "alice@example.com", password: "test1234", file: `${AUTH_DIR}/alice.json` },
  bob: { email: "bob@example.com", password: "test1234", file: `${AUTH_DIR}/bob.json` },
} as const;

for (const [name, who] of Object.entries(USERS)) {
  setup(`authenticate ${name}`, async ({ request }) => {
    const res = await request.post("/api/auth/signin", {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE_URL },
      form: { email: who.email, password: who.password },
      maxRedirects: 0,
    });
    // A 302 → "/" is success; a 302 → "/auth/signin?error=" means bad creds —
    // fail loudly here so no spec proceeds with an anonymous session.
    expect(res.status(), `signin ${name} should redirect`).toBe(302);
    expect(res.headers().location, `signin ${name} should land on "/"`).toBe("/");
    await request.storageState({ path: who.file });
  });
}
