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
