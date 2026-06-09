import { spawn, type ChildProcess } from "node:child_process";

/**
 * Vitest globalSetup: stand up a real SSR server for the HTTP integration suite.
 *
 * The API routes derive identity from request cookies via `src/lib/supabase.ts`,
 * which imports the virtual module `astro:env/server` — that only resolves inside
 * the Astro/Vite build, so a plain node test cannot import a route handler (see
 * test-plan §3 Phase 2 and the change's research.md). The honest path is to run
 * the app and drive routes over HTTP.
 *
 * This runs in the main Vitest process (NOT a test worker), so it spawns the
 * server as a SUBPROCESS — it never imports an Astro module, preserving the
 * "tests never import an Astro module" invariant the rest of the harness relies on.
 *
 * Lifecycle: build the Cloudflare worker bundle once, serve it via `astro preview`
 * (workerd/wrangler, which reads secrets from `.dev.vars`), poll a real route for
 * readiness, then tear the child process tree down via the returned teardown fn.
 *
 * Escape hatch: if a server is already reachable at TEST_BASE_URL (a developer
 * started one, or a prior run left one up), reuse it and do not spawn/own a new
 * one — useful for fast iteration and for CI setups that orchestrate the server
 * separately.
 */

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:4321";
// A known GET route that returns 200 once routes are actually compiled — workerd
// accepts the socket before routes are ready, so a TCP probe would be premature.
const READY_URL = `${BASE_URL}/auth/signin`;
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual" });
    return res.status > 0;
  } catch {
    return false;
  }
}

function run(command: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} exited with code ${code}`));
      }
    });
  });
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(url)) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Server at ${url} not ready within ${timeoutMs}ms — is the build serving and local Supabase up?`);
}

function teardown(server: ChildProcess): void {
  if (server.pid == null) return;
  if (process.platform === "win32") {
    // `astro preview` spawns wrangler → workerd; kill the whole tree, not just
    // the npm shell, or the port stays bound for the next run.
    spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-server.pid, "SIGTERM"); // negative pid → process group
    } catch {
      server.kill("SIGTERM");
    }
  }
}

export default async function globalSetup(): Promise<() => void> {
  if (await isReachable(READY_URL)) {
    return () => {
      // Reuse an already-running server; we don't own it, so teardown is a no-op.
    };
  }

  await run("npm run build", "astro build");

  const server = spawn("npm run preview", {
    shell: true,
    // Ignore stdin/stdout (wrangler is chatty); keep stderr so a startup failure
    // surfaces while the readiness poll is waiting.
    stdio: ["ignore", "ignore", "inherit"],
    detached: process.platform !== "win32", // own process group on POSIX for tree-kill
  });

  try {
    await waitForReady(READY_URL, READY_TIMEOUT_MS);
  } catch (err) {
    teardown(server);
    throw err;
  }

  return () => {
    teardown(server);
  };
}
