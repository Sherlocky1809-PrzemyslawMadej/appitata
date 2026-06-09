import { resolve } from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Minimal, HTTP-only integration test config. Tests talk to local Supabase
// over HTTP and never import an Astro module, so this deliberately avoids
// `getViteConfig` / `astro:env` resolution (see test-plan §3 Phase 1).
export default defineConfig(({ mode }) => {
  // Vitest runs in `test` mode by default, so this loads `.env.test`
  // (gitignored). Empty prefix → load every var, not just VITE_-prefixed.
  const env = loadEnv(mode, process.cwd(), "");

  return {
    resolve: {
      // Mirror the tsconfig `@/*` path alias so test helpers can use it.
      alias: { "@": resolve(process.cwd(), "src") },
    },
    test: {
      environment: "node",
      include: ["tests/**/*.test.ts"],
      // Build + serve a real SSR server once for the whole run so the API suite
      // can drive routes over HTTP (routes read identity from cookies via
      // `astro:env/server`, which can't resolve in a plain node test). The setup
      // file spawns the server as a SUBPROCESS — it never imports an Astro module.
      globalSetup: ["./tests/setup/server.ts"],
      // First-request compile on the workerd preview can be slow; absorb it in
      // the readiness poll (hookTimeout covers globalSetup/before* hooks).
      testTimeout: 30_000,
      hookTimeout: 150_000,
      // Integration tests share one local Supabase DB; the meetings fixture
      // mutates rows in beforeAll/afterAll. Run test files serially so a
      // future unfiltered-count assertion can't race a parallel file's fixture.
      fileParallelism: false,
      env,
    },
  };
});
