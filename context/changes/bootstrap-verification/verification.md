---
bootstrapped_at: 2026-05-21T06:11:49Z
starter_id: 10x-astro-starter
starter_name: 10x Astro Starter (Astro + Supabase + Cloudflare)
project_name: appitata
language_family: js
package_manager: npm
cwd_strategy: git-clone
bootstrapper_confidence: first-class
phase_3_status: ok
audit_command: npm audit
---

# Bootstrap Verification — AppiTata

## Hand-off

Verbatim from `context/foundation/tech-stack.md`:

```yaml
starter_id: 10x-astro-starter
package_manager: npm
project_name: appitata
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: first-class
  path_taken: standard
  quality_override: false
  self_check_answers: null
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: false
  has_background_jobs: true
```

**Why this stack:** AppiTata is a web app in JavaScript/TypeScript, built solo and after-hours on a roughly three-week MVP target. The recommended default was taken: 10x-astro-starter is the standard pick for a web app in JS and clears all four agent-friendly quality gates. It bundles the project's load-bearing needs — accounts with email/password auth, and a PostgreSQL database for friends and meetings — out of the box via Supabase, which is what a short, ship-first timeline needs most. Deployment targets Cloudflare Pages, the starter's default; CI runs on GitHub Actions with auto-deploy on merge. One known gap: FR-008's 24-hour invitation expiry is scheduled background work, which the starter's edge runtime does not carry first-class — the user accepted handling it manually (lazy expiry on read, or a small scheduled sweep, with no queue infrastructure). Scaffolding confidence is first-class: expect mostly-smooth bootstrapping with the occasional manual step.

## Pre-scaffold verification

| Signal       | Value    | Severity | Notes                                                          |
| ------------ | -------- | -------- | -------------------------------------------------------------- |
| npm package  | not run  | —        | cmd_template is a `git clone`; no npm `create-*` CLI to check  |
| GitHub repo  | not run  | —        | `gh` CLI not installed; recency check unavailable              |

No recency signal was obtainable. Per the warn-and-continue policy, the scaffold proceeded regardless.

## Scaffold log

**Resolved invocation**: `git clone https://github.com/przeprogramowani/10x-astro-starter .bootstrap-scaffold && cd .bootstrap-scaffold && npm install`
**Strategy**: git-clone
**Exit code**: 0
**Files moved**: 20 (top-level entries: `.env.example`, `.github`, `.gitignore`, `.husky`, `.nvmrc`, `.prettierrc.json`, `.vscode`, `CLAUDE.md`, `README.md`, `astro.config.mjs`, `components.json`, `eslint.config.js`, `node_modules`, `package-lock.json`, `package.json`, `public`, `src`, `supabase`, `tsconfig.json`, `wrangler.jsonc`)
**Conflicts (.scaffold siblings)**: none — the project root held only `context/`, which the starter does not ship
**.gitignore handling**: moved silently — no pre-existing `.gitignore` in the project root to append-merge against
**.bootstrap-scaffold cleanup**: deleted — `.bootstrap-scaffold/.git/` removed before move-up so the upstream starter history did not leak; temp directory removed after move

`npm install` reported: 773 packages added, 774 audited, completed in ~1 minute.

## Post-scaffold audit

**Tool**: `npm audit`
**Summary**: 0 CRITICAL, 1 HIGH, 10 MODERATE, 0 LOW
**Direct vs transitive**: 0 / 0 / 0 / 0 direct of total 0 / 1 / 10 / 0 — every finding is transitive (none appear in AppiTata's own `package.json`; they enter through the starter's dependency tree)

#### CRITICAL findings

None.

#### HIGH findings

- **devalue** `5.6.3 - 5.8.0` — DoS via sparse array deserialization (GHSA-77vg-94rm-hx3p). Transitive (pulled in by Astro). Fix available via `npm audit fix` — non-breaking.

#### MODERATE findings

- **ws** `8.0.0 - 8.20.0` — uninitialized memory disclosure (GHSA-58qx-3vcg-4xpx). Reaches the tree through `@supabase/realtime-js` and the Cloudflare tooling chain (`@cloudflare/vite-plugin` → `@astrojs/cloudflare`, `miniflare`, `wrangler`). Fix requires `npm audit fix --force` — installs `@astrojs/cloudflare@12.6.13`, a breaking change.
- **yaml** `2.0.0 - 2.8.2` — stack overflow via deeply nested YAML collections (GHSA-48c2-rrv3-qjmp). Reaches the tree through the Astro language-server chain (`yaml-language-server` → `volar-service-yaml` → `@astrojs/language-server` → `@astrojs/check`). Fix requires `npm audit fix --force` — installs `@astrojs/check@0.9.2`, a breaking change.

The 10 MODERATE count is the two root advisories above plus the dependent packages each advisory taints along its chain.

#### LOW / INFO findings

None.

## Hints recorded but not acted on

v1 of the bootstrapper records these hints but takes no automated action on them.

| Hint                    | Value               |
| ----------------------- | ------------------- |
| bootstrapper_confidence | first-class         |
| quality_override        | false               |
| path_taken              | standard            |
| self_check_answers      | null                |
| team_size               | solo                |
| deployment_target       | cloudflare-pages    |
| ci_provider             | github-actions      |
| ci_default_flow         | auto-deploy-on-merge |
| has_auth                | true                |
| has_payments            | false               |
| has_realtime            | false               |
| has_ai                  | false               |
| has_background_jobs     | true                |

The two feature flags set to `true` in the hand-off are `has_auth` and `has_background_jobs`.

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:
- `git init` (if you have not already) to start your own repo history.
- Review any `.scaffold` siblings the conflict policy created and decide which version of each file to keep. (This run created none.)
- Address audit findings per your project's risk tolerance — the full breakdown is in this log. The HIGH `devalue` finding is fixable non-breaking via `npm audit fix`; the MODERATE chain needs `npm audit fix --force` and its breaking upgrades.
- Copy `.env.example` to `.env` and fill in Supabase credentials before running the app.
