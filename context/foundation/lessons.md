# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Lint-validate type-system findings from /10x-impl-review before applying

- **Context**: Triage of /10x-impl-review findings, especially type-system and Supabase typed-client claims
- **Problem**: F1/F2 in friend-connection-handshake impl-review proposed a React.SubmitEvent→FormEvent rename and a Supabase ?? [] guard; both were wrong (FormEvent is the deprecated alias in this React 19 types; .data is narrowed non-null after the .error ladder). Applied blindly, both regressed type safety and broke lint until lint surfaced the inversion.
- **Rule**: Before applying a /10x-impl-review finding that renames a type, removes a null-coalesce, or otherwise mutates a type assertion, lint the proposed diff first. If the linter flags the new shape, treat the finding as DISAGREE pending stronger evidence — the reviewer may be working from outdated @types/react knowledge or missing a control-flow narrowing.
- **Applies to**: impl-review
