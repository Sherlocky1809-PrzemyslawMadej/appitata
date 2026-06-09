import { resolve } from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Two projects, one config. Tests talk to local Supabase over HTTP and never
// import an Astro module, so this deliberately avoids `getViteConfig` /
// `astro:env` resolution (see test-plan §3 Phase 1).
//
// - `unit`        — pure logic (e.g. conflict-overlap math). No server, no DB,
//                   parallel-friendly. Runs in milliseconds.
// - `integration` — drives the real SSR server + local Supabase over HTTP.
//                   Spawns the server once via globalSetup; serial to avoid
//                   shared-DB fixture races.
//
// `npm test` (vitest run) runs both; `vitest run --project unit` runs only the
// fast suite without ever building/serving Astro.
export default defineConfig(({ mode }) => {
  // Vitest runs in `test` mode by default, so this loads `.env.test`
  // (gitignored). Empty prefix → load every var, not just VITE_-prefixed.
  const env = loadEnv(mode, process.cwd(), "");
  // Mirror the tsconfig `@/*` path alias so helpers and source imports resolve.
  const alias = { "@": resolve(process.cwd(), "src") };

  return {
    test: {
      projects: [
        {
          resolve: { alias },
          test: {
            name: "unit",
            environment: "node",
            include: ["tests/unit/**/*.test.ts"],
            env,
          },
        },
        {
          resolve: { alias },
          test: {
            name: "integration",
            environment: "node",
            include: ["tests/integration/**/*.test.ts"],
            // Build + serve a real SSR server once for the whole run so the API
            // suite can drive routes over HTTP (routes read identity from
            // cookies via `astro:env/server`, which can't resolve in a plain
            // node test). The setup file spawns the server as a SUBPROCESS — it
            // never imports an Astro module.
            globalSetup: ["./tests/setup/server.ts"],
            // First-request compile on the workerd preview can be slow; absorb
            // it in the readiness poll (hookTimeout covers globalSetup hooks).
            testTimeout: 30_000,
            hookTimeout: 150_000,
            // Integration tests share one local Supabase DB; fixtures mutate
            // rows in beforeAll/afterAll. Run files serially so a future
            // unfiltered-count assertion can't race a parallel file's fixture.
            fileParallelism: false,
            env,
          },
        },
      ],
    },
  };
});
