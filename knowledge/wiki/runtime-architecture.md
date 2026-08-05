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

**Comment *handling* deliberately stayed put.** `ingestViewerComment` calls 19
functions, most of them the reservation core (`ensureReservationState`,
`addReservationEvent`, `runReservationProcessing`, `getOpenLots`). The waitlist
fixes of 2026-08 prove the coupling: one bug took four commits, and
`bda7cf8` alone edited 11 regions spanning lot closing, reservation processing,
comment ingestion, the poller and detection. A module boundary there would cut
straight through what changes together. The reservation/lot/waitlist cluster
needs an explicit state machine and race tests first — moving code is not the
hard part.

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
