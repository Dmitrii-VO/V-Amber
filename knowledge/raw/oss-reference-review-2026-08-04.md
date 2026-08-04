# OSS reference review — 2026-08-04

Source note: search for comparable open-source projects, what to borrow from
them, and what that means for V-Amber at `0.1.83`. Raw note — append-only.
Synthesis belongs in [[../wiki/voice-control-hardening-plan]] and
[[../wiki/reservation-flow]].

## Finding 0: there is no direct open-source analogue

Searched four framings: live commerce, live selling, voice-driven commerce,
auction-by-stream-comment. Result:

- Live-commerce OSS is essentially empty. The only repository positioned that
  way, `api-evangelist/dripshop`, is 0 stars, 821 KB, no language — a catalog of
  API specs for a commercial marketplace, not code.
- Live-selling repos found are student-grade auction apps.
- The combination "operator speech → article → lot → ERP reservation" was not
  found anywhere.

Consequence: references must be picked **per subsystem**, and none can be
adopted wholesale.

## Reference projects (verified 2026-08-04 via GitHub API)

| Repo | Stars | Lang | Last push | Issues | Status |
|---|---|---|---|---|---|
| medusajs/medusa | 35 576 | TS | 2026-08-04 | 106 | healthy |
| bluenviron/mediamtx | 19 720 | Go | 2026-08-04 | 207 | healthy, already used |
| pipecat-ai/pipecat | 13 915 | Python | 2026-08-04 | 219 | healthy (v1.0 Apr 2026) |
| livekit/agents | 12 297 | Python | 2026-08-04 | 726 | healthy, high issue load |
| vendure-ecommerce/vendure | 8 295 | TS | 2026-08-04 | 213 | healthy |
| ufal/whisper_streaming | 3 659 | Python | 2025-11-12 | 12 | **stale ~9 months** — read as a paper impl, not a dependency |
| negezor/vk-io | 566 | TS | 2026-02-28 | 46 | slow but alive |
| crowbartools/Firebot | 467 | TS | 2026-08-03 | 404 | active, but 404 issues at 467 stars |

### What to borrow

- **Pipecat / LiveKit Agents** — the pipeline-of-typed-frames abstraction:
  audio → VAD → STT → processor → action as separately testable stages with
  explicit state passing. Do **not** take the dependency: both are Python and
  WebRTC-transport-bound.
- **Medusa** — reservations as append-only `ReservationItem` records over
  `reserved_quantity`; available stock is *computed*, never mutated in place.
- **Vendure** — a declarative order state machine instead of imperative
  branching.
- Do **not** adopt Medusa or Vendure themselves. MoySklad is the ERP and source
  of truth; a second commerce engine would create two competing ledgers.
- **whisper_streaming** — the LocalAgreement-n idea only (see Proposal 2). The
  repo itself is stale; do not depend on it.
- **Firebot** — a data-described command registry (trigger, permission,
  cooldown, effect chain). Avoid its Electron plugin architecture, which is
  visibly the source of its issue backlog.
- **vk-io — explicitly do not migrate.** `server/vk.js` already has a two-lane
  priority queue with adaptive backoff on VK error 6 (`vk.js:204-291`), which is
  more sophisticated than what vk-io provides.
- **MediaMTX** — current choice is correct, no change.

## What was checked against this repository, and what changed

Three claims from the first pass did not survive verification:

1. **"Feed the MoySklad article list to the recognizer as hotwords" — dropped.**
   SpeechKit v3 streaming in `@yandex-cloud/nodejs-sdk` has no context-biasing
   surface. `RecognitionModelOptions` exposes only `model`, `audioFormat`,
   `textNormalization`, `languageRestriction`, `audioProcessingType`;
   `StreamingOptions` adds `eouClassifier`, `recognitionClassifier`,
   `speechAnalysis`, `speakerLabeling`, `summarization`. No phrase list, no
   adaptation. Vocabulary biasing would require a separate Yandex custom-model
   product, not an API field. Catalog gating stays the only lever, which is what
   [[../wiki/voice-control-hardening-plan]] Priority 2 already says.
2. **"Split `ws-server.js`" is not a new idea** — it is Priority 6 of the
   existing hardening plan, and the plan's sequencing is stricter than what was
   proposed: keep external writes in `ws-server.js` until extracted modules have
   integration coverage, split one seam at a time. Follow the plan's order.
3. **"Add an STT adapter interface"** overlaps Priority 5 (benchmark harness,
   Whisper in shadow mode). Not a separate work item.

Verified facts that stand:

- `server/ws-server.js` is 4538 lines against the repo's own <800 rule
  (`AGENTS.md`), one closure with ~60 nested functions sharing mutable state
  through scope.
- `processReservationEvent` spans lines 1166–1572 (~406 lines);
  `ingestViewerComment` spans 1956–2283 (~327 lines).
- 15 of 45 test files must boot the whole `ws-server` (`ws-server.*.test.js`).
- Partial transcripts already arrive (`speechkit-stream.js:134`, `onPartial`) but
  are used **only** for UI display (`ws-server.js:3422`). Detection runs solely
  off `final` (`ws-server.js:3430-3479`). A low-confidence gate already exists
  (`final_skipped_low_confidence`, `speechkit-stream.js:150`).
- Reservation events are a **bounded in-memory ring of 20**:
  `state.events = state.events.slice(-20)` (`ws-server.js:611`). Not a durable
  ledger.
- Comment-level dedup already exists (`rememberSeenComment` / `hasSeenComment`,
  bounded set of seen `commentId`).
- MoySklad retries are **GET-only** (`isRetryableGetError`, `moysklad.js:141-185`).
  Writes are never retried.

## Proposals

Ordered by value, and positioned relative to work already planned.

### Proposal 1 — Idempotency key on MoySklad writes (new, highest value)

The reason writes are not retried today is that they cannot be: there is no key
that makes a repeated write safe. This is the root cause behind the
[[order-recovery-from-logs]] procedure existing at all — a mid-broadcast auth
failure currently requires manual rebuild.

Give every reservation write a deterministic key derived from
`(viewerId, commentId, lotSessionId)`, persist it with the attempt outcome, and
only then allow write retry. Comment-level dedup already exists; what is missing
is dedup at the *external write* boundary.

Medusa's append-only reservation model is the reference.

### Proposal 2 — LocalAgreement-2 before opening a lot (new, needs measurement)

Require an article code to appear in two consecutive partial hypotheses before
detection is treated as confirmed, instead of trusting the first `final`. The
partial stream already exists and is currently discarded for anything but UI.

Caveat, stated honestly: LocalAgreement-n was designed for Whisper, which
re-decodes a sliding window and revises emitted text. SpeechKit REAL_TIME
partials behave differently, and a confidence gate already filters some noise.
The gain is plausible, not proven — **measure it with the Priority 5 benchmark
harness before shipping.** It also does not replace Priority 1: EOU tuning fixes
premature *segmentation*, LocalAgreement fixes unstable *hypotheses*. Different
failures.

### Proposal 3 — Durable reservation ledger (new)

Replace the 20-event ring with append-only records carrying the Proposal 1 key.
Available stock becomes computed rather than mutated. This turns log-based order
recovery from an incident procedure into an ordinary replay, and gives
`processReservationEvent` something to be decomposed against.

### Proposal 4 — Command registry for buyer comments (new, partial)

Dispatch is inline in `ingestViewerComment`. The parsers are already extracted
(`reservation-parser`, `cancel-command-parser`, `quantity-command-parser`) and
flood-guard plus blocked-viewer handling are already separate modules, so this
is smaller than it first appeared: a `{trigger, parser, handler, permission}`
table plus a dispatcher, reusing what exists.

### Proposal 5 — Follow the existing plan for the `ws-server.js` split

No new proposal. [[../wiki/voice-control-hardening-plan]] Priority 6 already
defines the seams and the safety ordering. The only addition worth making is
that Proposals 1 and 3 should land **first**: a reservation ledger with explicit
records is far easier to extract into a module than 406 lines of branching over
closure state.

## Recommended order

1. Idempotency key on MoySklad writes (Proposal 1).
2. Durable reservation ledger (Proposal 3).
3. Benchmark harness — hardening plan Priority 5 — then evaluate Proposal 2 on
   real audio.
4. Command registry (Proposal 4).
5. `ws-server.js` split per hardening plan Priority 6.

Priorities 1–4 of the hardening plan (EOU pause, catalog-ready mode, discount
confirm/undo, price source badge) are unaffected by this review and keep their
own ordering — they reduce live-stream risk and should not be displaced by
architecture work.
