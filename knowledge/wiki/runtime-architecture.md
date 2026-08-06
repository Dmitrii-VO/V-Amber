# Runtime architecture

The current V-Amber runtime is a local Node.js application that serves a static
browser UI and accepts microphone audio over WebSocket.

## Process shape

`npm start` runs `node server/index.js`. The process wires:

- HTTP static/API server from `server/http-server.js`;
- WebSocket session flow from `server/ws-server.js`;
- Yandex SpeechKit streaming;
- VK and MoySklad clients when configured;
- runtime stores for active state, settings, wishlist, submissions, reservation
  digests, and logs.

Docker runs the same Node.js MVP with `.env` injected and `logs/` mounted from
the host.

## Browser audio flow

The operator opens the Web UI at `http://localhost:<PORT>`, chooses a
microphone, and starts streaming. Browser microphone access happens in the host
browser. `web-ui/audio-processor.js` prepares PCM frames; `web-ui/app.js` sends
them over WebSocket.

## Session state

`server/ws-server.js` owns the active lot and session lifecycle. It combines
SpeechKit final transcripts, product lookup, VK publication, reservation
events, discounts, and safe mode state.

`server/state-store.js` persists active state so startup recovery can detect
orphan reservations after a crash.

### What has been split out of ws-server.js

`attachWsServer` is one closure spanning most of the file, so every mutable
variable is in scope everywhere and git labels every hunk `attachWsServer`.
Splitting is happening piece by piece, and the criterion is **what changes
together**, not what reads tidily:

- `server/domain/voice-pipeline.js` — the trigger window over final
  transcripts.
- `server/domain/comment-pollers.js` — the transport for buyer comments, both
  the VK poller and the `/efir/` chat poller. It owns its cursors, generations,
  adaptive interval and backoff; outward it emits comments into
  `ingestViewerComment` and accepts exactly two control calls: `stopVk()` when
  VK poisons a lot (error 801, chat keeps running) and `reset()` when the эфир
  restarts.
- `server/domain/reservation-attention.js` — the branch where a comment looks
  like a бронь but no single open lot matches (none, or several). It reads the
  open lots and the catalog and reports to the operator; it never touches lot
  state. The flood guard for giveaway spam lives with it, since that is its
  only caller.
- `server/domain/viewer-instructions.js` — the periodic «how to reserve»
  message, published to VK comments and the `/efir/` chat at once. Outward it
  knows `vk`/`chatClient`, `isLive()` and `connectionId`. Cross-promo is
  **not** inside it: the two start and stop together but have separate flags,
  so `crossPromo.start()/stop()` sit next to the instruction calls in
  `ws-server.js`. Before the split this coupling was hidden — `stopViewerInstructions()`
  silently stopped cross-promo too.
- `server/domain/pending-actions.js` — the single-use action tokens behind
  `appendReservationQuantity` and «забронировать из строки внимания». Both are
  direct writes to MoySklad, so the server issues an `actionId` and keeps the
  verified payload itself; the client returns only the token. `peek()`
  deliberately does **not** spend the token — after a MoySklad failure the
  operator must be able to retry with the same click. It therefore gives no
  protection against a double click; that lives in the write journal.

**The reservation branch of `ingestViewerComment` deliberately stays put.** The
function splits into four parts, and only the last is entangled:

| Part | Lines | Outward calls |
|---|---|---|
| Blocked check + operator feed | 50 | 4 |
| Cancel hand-off | 11 | 1 |
| No-single-lot → attention | 95 | 5 — **extracted** |
| Bookkeeping + wishlist + бронь | 178 | 10, nearly all the reservation core |

The last part calls `ensureReservationState`, `addReservationEvent`,
`runReservationProcessing`, `emitState`. The waitlist fixes of 2026-08 prove
the coupling: one bug took four commits, and `bda7cf8` alone edited 11 regions
spanning lot closing, reservation processing, comment ingestion, the poller and
detection. A module boundary there would cut straight through what changes
together. That cluster needs an explicit state machine and race tests first —
moving code is not the hard part.

**A generic command registry was considered and rejected.** It assumes
`parse(text) → command`, and parsing here is not a function of the text alone:
`parseReservationComment(text, { preferredCode })` takes the candidate lot's
code, and `findCommentTarget` runs it against every open lot in two passes
(exact, then zero-padded). The same text yields a different code depending on
which lot it is tested against — that is what stops phone numbers and prices
from being read as articles. Dispatch also happens in exactly one place: VK and
chat already funnel into `ingestViewerComment`, and operator voice commands use
a different vocabulary and a different safety model (speech never executes, it
only highlights). Finally the order encodes safety invariants with incidents
behind them — blocked first, cancel before бронь, ambiguous never auto-reserved
— and in a table those become implicit properties of array order.

MoySklad writes also stay in place: they are already wrapped at the `index.js`
seam (safe mode outside, write journal inside), so relocating them buys
nothing. See [[runtime-stores]].

## Local persistence

Persistent runtime artifacts live under `logs/`:

- `logs/server.log` and rotated copies for JSON server logs;
- `logs/sessions/*.md` for per-session human-readable Markdown logs;
- `logs/wishlist.jsonl` for wishlist events;
- `logs/wishlist-submissions.json` for wishlist submission drafts/results;
- `logs/install-id` for per-install UUID.

See [[runtime-stores]] and [[logging-and-diagnostics]].
