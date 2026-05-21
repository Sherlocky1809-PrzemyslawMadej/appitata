---
project: AppiTata
context_type: greenfield
created: 2026-05-20
updated: 2026-05-20
product_type: web-app
target_scale:
  users: medium
  qps: low
  data_volume: small
timeline_budget:
  mvp_weeks: 3
  hard_deadline: null
  after_hours_only: true
  # work budget: ~5-7 h/week, after-hours
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: pain category
      decision: isolation + coordination overhead
    - topic: moment of pain
      decision: emotional low points — needing another adult who understands
    - topic: insight / why not built
      decision: existing babysitting & playdate apps miss equal reciprocal peer co-care; trust is pre-existing because users are already friends
    - topic: persona scope
      decision: a parent's existing circle of trusted friends; friend-defined geography (~1 hour drive), not neighborhood-bound
    - topic: authentication method
      decision: account login — email + password only for the MVP; social login deferred to a later version
    - topic: role model
      decision: flat — every parent is an equal peer; no admin/member distinction
    - topic: MVP flow scope
      decision: 7-step co-care flow; friend-request handshake kept; calendar grid cut to a plain meeting list; availability preview cut to an accept-time conflict warning
    - topic: timeline
      decision: scoped down to fit a ~3-week MVP target (mvp_weeks 3)
    - topic: secondary success criterion
      decision: a parent grows a circle of 3+ connected friends
    - topic: guardrails
      decision: data privacy (meetings visible to connected friends only); no silent double-booking
    - topic: Socrates round (Phase 4)
      decision: FR-002 reduced to email/phone search; FR-006 place must be a structured address; FR-007 allows multiple invitees; FR-008 invitations auto-expire; FR-010 list splits upcoming/past; FR-001/003/004/005/009 stand as written
    - topic: domain rule (Phase 5)
      decision: reactive conflict-checking is the MVP rule — verify no time clash before a meeting is confirmed; proactive availability-matching deferred to v2
    - topic: non-functional requirements (Phase 5)
      decision: privacy boundary is the sole MVP NFR; responsiveness, mobile usability, and invitation-delivery reliability considered but not set as MVP bars
    - topic: product framing (Phase 6)
      decision: web-app; dozens-to-a-hundred users (medium scale); no hard deadline; after-hours work at ~5-7 h/week
    - topic: non-goals (Phase 6)
      decision: out of MVP scope — proactive availability-matching, in-app messaging/chat, visual calendar grid, social login
  frs_drafted: 10
  quality_check_status: accepted
---

# AppiTata — Shape Notes

Working notes produced by the discovery process. Feeds `/10x-prd`. Greenfield project.

## Vision & Problem Statement

Parents feel isolated and alone in the daily work of raising children, and coordinating shared childcare among the people they would trust is itself an exhausting task. The pain is sharpest at emotional low points — the moments when a parent simply needs another adult who understands what they are going through.

The insight: existing apps in this space — babysitting marketplaces, playdate finders — miss equal, reciprocal *peer* co-care between parents. They also struggle with trust, because they match strangers. AppiTata sidesteps the trust barrier entirely by building on parents' *existing* friendships rather than manufacturing trust between strangers.

_Scale note (Phase 6): at much larger user counts the conflict-checking domain rule does not change — it always operates within one parent's small circle of friends — so growth pressure falls on the data-privacy boundary and on app responsiveness, not on the rule itself._

## User & Persona

**Primary persona** — a parent who already has a circle of friends who are also parents. They want to schedule meetups and arrange mutual childcare with people they already know and trust. The friends need not be neighbors: a friend up to roughly an hour's drive away still counts. They reach for AppiTata at emotional low points and whenever the logistics of solo parenting become too much to carry alone.

## Success Criteria

### Primary

A parent completes the full co-care flow end-to-end with a friend. This single flow working = AppiTata works:

1. Parent signs up / logs in (email + password)
2. Parent sends a friend request to another parent
3. The other parent accepts — they are now connected
4. Parent creates a meeting (date, time, description)
5. Parent sends a meeting invitation to the connected friend
6. The friend accepts; if the time clashes with an existing meeting, the app shows a conflict warning before confirming
7. The confirmed meeting appears in both parents' upcoming-meetings list (a plain date-sorted list, not a calendar grid)

### Secondary

A parent grows a circle of three or more connected friends — adoption spreads beyond a single pair, signalling the network effect that makes a co-care app valuable. Nice to have, but not sufficient on its own.

### Guardrails

- **Privacy** — a parent's meetings and calendar are visible only to friends they have connected with; nothing is ever public.
- **No silent double-booking** — a time conflict is always surfaced before a meeting is confirmed; the app never hides a clash.

## User Stories

### US-01: A parent schedules a co-care meeting with a connected friend

- **Given** a parent who is connected with at least one friend
- **When** they create a meeting (date, time, place, description) and invite that friend
- **Then** the friend receives the invitation, and on accepting it the meeting appears in both parents' upcoming-meetings lists

#### Acceptance Criteria
- If the meeting time overlaps a meeting already in the invited friend's list, a conflict warning is shown before they confirm
- The meeting is confirmed only after the invited friend explicitly accepts — a pending or declined invitation never shows as confirmed
- Once confirmed, both parents see the identical meeting in their date-sorted upcoming-meetings list

### US-02: A parent connects with another parent

- **Given** a parent who wants to add a friend they already know
- **When** they find that parent (by email, phone, address, name, surname, or child's name/surname) and send a friend request
- **Then** the other parent receives the request, and on accepting it the two become connected and can invite each other to meetings

#### Acceptance Criteria
- A friend request must be explicitly accepted by the recipient before the two are connected — no automatic connection
- Either parent can decline a request; a declined request creates no connection
- Only connected parents appear in each other's friends list and can be invited to meetings
- A parent cannot invite someone who is not a connected friend

## Functional Requirements

Each FR carries a `> Socrates:` note recording the counter-argument weighed in the Phase 4 challenge round and the resolution.

### Account & Friends

- FR-001: A parent can create an account and sign in with email and password. Priority: must-have
  > Socrates: Counter-arguments considered — email/password adds friction versus a link-based join; password upkeep is off-mission work. Resolution: kept as written — standard account login is the right fit for a multi-user app.
- FR-002: A parent can find another parent by email address or phone number. Priority: must-have
  > Socrates: Counter-argument accepted — six search methods is over-built; for people you already know, one precise identifier is enough. Resolution: revised — reduced from six methods to email address or phone number. Side benefit: removes the child-safety risk of searching by a child's name or home address.
- FR-003: A parent can send a friend request to another parent. Priority: must-have
  > Socrates: Counter-arguments considered — the request/accept handshake is ceremony; an open request channel invites unwanted contact. Resolution: kept as written — the request step is the deliberate trust gate.
- FR-004: A parent can accept or decline a friend request they receive. Priority: must-have
  > Socrates: Counter-arguments considered — decline is rarely used between people who know each other; decline without a block is weak. Resolution: kept as written — accept/decline is the right minimal control for the MVP.
- FR-005: A parent can view their list of connected friends. Priority: must-have
  > Socrates: Counter-arguments considered — a friends list adds little among a handful of friends; it could be demoted to nice-to-have. Resolution: kept as written — a must-have friends list for the MVP.

### Meetings

- FR-006: A parent can create a meeting with a date, time, a structured place address, and a description. Priority: must-have
  > Socrates: Counter-argument accepted — free-text place invites inconsistency. Resolution: revised — the meeting place must be a structured address rather than free text.
- FR-007: A parent can invite one or more connected friends to a meeting. Priority: must-have
  > Socrates: Counter-argument accepted — inviting one friend at a time is too thin; co-care often involves several families. Resolution: revised — a parent can invite one or more connected friends to a meeting.
- FR-008: A parent can accept or decline a meeting invitation they receive; an invitation left unanswered expires automatically after 24 hours. Priority: must-have
  > Socrates: Counter-argument accepted — an unanswered invitation lingers in limbo forever. Resolution: revised — an unanswered invitation expires automatically after 24 hours.
- FR-009: When accepting a meeting invitation, a parent sees a conflict warning if the meeting time overlaps an existing meeting. Priority: must-have
  > Socrates: Counter-arguments considered — the warning fires too late (accept-time); an ignorable warning does not prevent double-booking. Resolution: kept as written — an accept-time conflict warning is the right lightweight MVP behavior and satisfies the "no silent double-booking" guardrail.
- FR-010: A parent can view their meetings as a date-sorted list, separated into upcoming and past meetings. Priority: must-have
  > Socrates: Counter-argument accepted — a flat list gets unwieldy with no past/upcoming separation. Resolution: revised — the meetings list separates upcoming and past meetings.

## Non-Functional Requirements

- **Privacy boundary** — A parent's data (their meetings, their friends list, and any details about their children) is visible only to friends they have explicitly connected with. None of it is ever public, indexed, or reachable by a parent outside their connected circle.

Other quality bars — responsiveness, mobile usability, and guaranteed invitation delivery — were considered during discovery and deliberately not set as MVP-level NFRs. They can be revisited after the MVP ships.

## Business Logic

When a parent proposes a co-care meeting, AppiTata checks every invited friend's existing commitments and surfaces any time conflict, so a meeting is confirmed only when everyone involved is genuinely free.

The rule consumes two user-facing inputs: the date and time of the proposed meeting, and the meetings each invited friend already has on their schedule. Its output is a per-friend conflict signal — for each invited friend, whether the proposed time overlaps something they have already committed to.

A parent encounters the rule reactively, at invite-time: when an invited friend opens a meeting invitation, the conflict warning is shown before they can accept, so no parent unknowingly double-books a friend and no meeting is confirmed on top of a clash. This is the concrete expression of the "no silent double-booking" guardrail.

The MVP rule is reactive by deliberate choice. Proactive availability-matching — showing a parent which friends are free for a time before they invite anyone — is the intended v2 evolution of this same rule, and is out of MVP scope (see Non-Goals).

## Access Control

AppiTata is a multi-user, account-based app. Every parent has an individual account and must sign in to use it; all functionality sits behind authentication, with no public or anonymous surface (an unauthenticated visitor sees only a sign-up / sign-in screen).

**Authentication** — account login with email + password. A parent signs up once and can then sign in from any device. (Social login was considered and deferred to a later version to keep the MVP lean.)

**Roles** — flat model. Every parent is an equal peer; there is no admin / member distinction, and anyone in a friend circle can do the same things.

## Non-Goals

- **Proactive availability-matching** — Showing a parent which friends are free for a time before they invite anyone. This is the intended v2 evolution of the domain rule; the MVP uses reactive conflict-checking instead. (Decided in Phase 5.)
- **In-app messaging / chat** — AppiTata coordinates meetings; it will not be a place for parents to hold conversations or chat threads. Messaging would significantly expand the MVP surface.
- **A visual calendar grid** — The MVP presents meetings as a plain date-sorted list (upcoming / past). A Teams-style calendar view was cut in Phase 3 and is deferred to a later version.
- **Social login** — MVP sign-in is email + password only; third-party social login was considered and deferred in Phase 3.

## Open Questions

None — the one question raised during shaping (the invitation expiry window) was resolved: an unanswered meeting invitation auto-expires after 24 hours.

## Quality cross-check

Closing cross-check (Phase 7) passed with no gaps. All required elements present: Access Control, Business Logic (one-sentence rule), project artifacts, timeline-cost acknowledgement (`mvp_weeks: 3`), and Non-Goals. `quality_check_status: accepted`. Nothing to mirror into Open Questions.
