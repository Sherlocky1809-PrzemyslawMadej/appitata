---
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
---

## Why this stack

AppiTata is a web app in JavaScript/TypeScript, built solo and after-hours on a roughly three-week MVP target. The recommended default was taken: 10x-astro-starter is the standard pick for a web app in JS and clears all four agent-friendly quality gates. It bundles the project's load-bearing needs — accounts with email/password auth, and a PostgreSQL database for friends and meetings — out of the box via Supabase, which is what a short, ship-first timeline needs most. Deployment targets Cloudflare Pages, the starter's default; CI runs on GitHub Actions with auto-deploy on merge. One known gap: FR-008's 24-hour invitation expiry is scheduled background work, which the starter's edge runtime does not carry first-class — the user accepted handling it manually (lazy expiry on read, or a small scheduled sweep, with no queue infrastructure). Scaffolding confidence is first-class: expect mostly-smooth bootstrapping with the occasional manual step.
