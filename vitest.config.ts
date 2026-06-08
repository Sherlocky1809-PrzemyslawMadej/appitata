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
      // Integration tests share one local Supabase DB; the meetings fixture
      // mutates rows in beforeAll/afterAll. Run test files serially so a
      // future unfiltered-count assertion can't race a parallel file's fixture.
      fileParallelism: false,
      env,
    },
  };
});
