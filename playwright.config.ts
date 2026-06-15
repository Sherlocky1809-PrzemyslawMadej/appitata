import { defineConfig, devices } from "@playwright/test";

// E2E harness for AppiTata's north-star co-care flow (test-plan §3 Phase 4).
//
// Builds the Cloudflare worker bundle and serves it via `astro preview`
// (workerd/wrangler, which reads secrets from `.dev.vars`) — the same server
// the integration suite uses. Requires local Supabase up (`npx supabase start`)
// and a one-time `npx playwright install chromium` per machine/CI.
//
// Override the origin with TEST_BASE_URL to reuse a server you started by hand.
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:4321";

export default defineConfig({
  testDir: "tests/e2e",
  // workerd's first-request compile is slow; give web-first assertions room
  // rather than reaching for fixed waits (e2e rule 4).
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One shared local Supabase DB; serialize so fixture setup/teardown can't race
  // a parallel spec (mirrors vitest's integration `fileParallelism: false`).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    // Authenticate once and persist each parent's cookie jar as storageState.
    // Specs consume those files instead of logging in through the UI (rule 7).
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // Specs (`*.spec.ts`) depend on the saved storageState.
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm run build && npm run preview",
    url: `${BASE_URL}/auth/signin`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
