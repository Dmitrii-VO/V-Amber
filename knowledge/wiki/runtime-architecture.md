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

## Local persistence

Persistent runtime artifacts live under `logs/`:

- `logs/server.log` and rotated copies for JSON server logs;
- `logs/sessions/*.md` for per-session human-readable Markdown logs;
- `logs/wishlist.jsonl` for wishlist events;
- `logs/wishlist-submissions.json` for wishlist submission drafts/results;
- `logs/install-id` for per-install UUID.

See [[runtime-stores]] and [[logging-and-diagnostics]].
