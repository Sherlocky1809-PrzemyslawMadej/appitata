# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Lint-validate type-system findings from /10x-impl-review before applying

- **Context**: Triage of /10x-impl-review findings, especially type-system and Supabase typed-client claims
- **Problem**: F1/F2 in friend-connection-handshake impl-review proposed a React.SubmitEvent→FormEvent rename and a Supabase ?? [] guard; both were wrong (FormEvent is the deprecated alias in this React 19 types; .data is narrowed non-null after the .error ladder). Applied blindly, both regressed type safety and broke lint until lint surfaced the inversion.
- **Rule**: Before applying a /10x-impl-review finding that renames a type, removes a null-coalesce, or otherwise mutates a type assertion, lint the proposed diff first. If the linter flags the new shape, treat the finding as DISAGREE pending stronger evidence — the reviewer may be working from outdated @types/react knowledge or missing a control-flow narrowing.
- **Applies to**: impl-review

## The 24h invitation-expiry window is encoded in three layers — change them together

- **Context**: The FR-008 24h cutoff lives in three independent places: the `expire_stale_invitations()` sweep RPC and the `meeting_invitations_update` RLS USING clause (both `supabase/migrations/20260601120000_invitation_expiry_sweep.sql`), and the Pending read filter in `src/pages/meetings.astro` (`now - 24*60*60*1000`).
- **Problem**: There is no shared source for the window. The three encodings agree today (all exclusive boundaries), but a future change to the expiry duration must update all three in lockstep. Miss one and the layers silently disagree — e.g. the UI hides an invite the DB still accepts, or the sweep expires rows the read filter still shows.
- **Rule**: When changing the invitation-expiry window, update all three encodings together (sweep RPC, RLS USING clause, meetings.astro read filter) and keep the boundary direction consistent (sweep uses `<`, accept/read use `>`). Treat them as one coupled invariant, not three separate literals.
- **Applies to**: implement, impl-review, plan

## Seed loginable auth.users with empty-string token columns, not NULL

- **Context**: Any `supabase/seed.sql` (or migration) that inserts `auth.users` rows intended to log in via `signInWithPassword` — e.g. test/fixture identities for the integration suite.
- **Problem**: Raw `auth.users` inserts leave GoTrue's token columns (`confirmation_token`, `recovery_token`, `email_change`, `email_change_token_new`, `email_change_token_current`, `phone_change`, `phone_change_token`, `reauthentication_token`) NULL. GoTrue scans those character columns into Go strings on login and fails NULL→string with `Database error querying schema`. Service_role reads bypass GoTrue, so smoke tests pass and hide the break — only HTTP login surfaces it (cost a debugging cycle in testing-privacy-rls-isolation Phase 2).
- **Rule**: When seeding an `auth.users` row that must authenticate by password, stamp `encrypted_password` AND coalesce every GoTrue token column to `''` (e.g. `set confirmation_token = coalesce(confirmation_token,''), …`) in the same statement. Never leave token columns NULL on a loginable user. Verify with an actual `signInWithPassword`, not just a service_role read.
- **Applies to**: implement, research, plan
