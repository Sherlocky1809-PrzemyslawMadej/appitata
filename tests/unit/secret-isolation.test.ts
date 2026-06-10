import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static, dependency-free regression lock on Risk #6 (test-plan §2): the
// Supabase service-role/admin key must never reach a client or request path.
// Two independent vectors are pinned by reading source text from disk —
//   (a) the import graph: only the cron entrypoint may import the admin module;
//   (b) the env schema: astro.config.mjs must not declare the service-role key.
//
// This file deliberately does NOT import `@/lib/supabase-admin` or
// `astro:env/server`: importing the admin module would defeat the isolation it
// guards, and may not resolve in the node test env. Pure file inspection only.

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const srcDir = resolve(repoRoot, "src");
const adminModule = resolve(srcDir, "lib", "supabase-admin.ts");

// The single legitimate importer: the Cloudflare cron entrypoint. The check is
// allow-list shaped (not a deny-list over known client dirs) so a leak through
// a new top-level dir fails closed instead of slipping past.
const ALLOWED_IMPORTERS = ["src/worker.ts"];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".astro"];

/** Recursively collect every source file under `dir`. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** Extract every module specifier referenced by `from "x"` or `import("x")`. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const dynRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [fromRe, dynRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

/**
 * Resolve a specifier (the `@/` alias or a relative path) to the absolute .ts
 * path it would load, or null for bare package imports (never the admin module).
 */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = resolve(srcDir, spec.slice("@/".length));
  } else if (spec.startsWith(".")) {
    base = resolve(dirname(fromFile), spec);
  } else {
    return null;
  }
  return base.endsWith(".ts") ? base : `${base}.ts`;
}

/** Repo-relative POSIX path for stable, readable assertion output. */
function toRepoRel(p: string): string {
  return relative(repoRoot, p).split(sep).join("/");
}

describe("Risk #6 — service-role key isolation (import vector)", () => {
  it("admin client is imported only by the cron entrypoint, never a client/request path", () => {
    const importers: string[] = [];
    for (const file of collectSourceFiles(srcDir)) {
      if (resolve(file) === adminModule) continue; // skip the module itself
      const specs = importSpecifiers(readFileSync(file, "utf8"));
      if (specs.some((s) => resolveSpecifier(s, file) === adminModule)) {
        importers.push(toRepoRel(file));
      }
    }
    // Equality (not subset) so a new leak path fails closed and is named.
    expect(importers.sort()).toEqual(ALLOWED_IMPORTERS);
  });
});

describe("Risk #6 — service-role key isolation (env-schema vector)", () => {
  it("astro.config.mjs does not declare SUPABASE_SERVICE_ROLE_KEY", () => {
    const config = readFileSync(resolve(repoRoot, "astro.config.mjs"), "utf8");
    // Declaring it in env.schema would make the key request-reachable even
    // without importing the admin module. The anon path declares only
    // SUPABASE_URL / SUPABASE_KEY.
    expect(config).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
