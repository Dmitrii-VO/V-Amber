# Web dashboard

The browser dashboard lives in `web-ui/`. It is served by
`server/http-server.js` and talks to backend APIs plus the WebSocket audio
stream.

## Core session controls

`web-ui/app.js` lets the operator:

- choose and refresh microphone devices (selection persists in localStorage);
- validate and persist a VK live video URL;
- start and stop WebSocket audio streaming (Space keyboard shortcut);
- view transcript, active lot, detections, reservations, metrics, and uptime;
- toggle safe mode;
- refresh the product-code cache (inline banner at session start with a
  remember-choice flag, no blocking confirm dialog);
- download diagnostic logs;
- close the active lot manually (`× закрыть лот` button — sends
  `closeLot` WS message);
- override the active lot price by clicking the price field (sends
  `setLotPrice` WS message, salePrice and voicePrice both updated, VK
  card refreshed);
- enter an article code manually via the `код вручную` field on the
  active-lot panel (`#manualCodeForm`, sends `manualCode` WS message) —
  for when SpeechKit misheard the code. The field only shows while the
  stream is running, and the server rejects codes not in the MoySklad
  catalog. See [[http-api]] and [[deferred-operator-features]] #14.

The microphone flow uses Web Audio API and `web-ui/audio-processor.js` to
capture PCM, downsample to 16 kHz, and send frames over WebSocket.

## Operator banners

Three inline banners replace blocking dialogs and surface state changes:

- `#cacheBanner` — pre-start prompt to load product codes. Stays inline
  so transcripts can still flow; choice can be remembered.
- `#connectionBanner` — appears when the WebSocket drops unexpectedly,
  with a `Перезапустить` button.
- `#digestPromptBanner` — appears after the operator stops the stream
  if at least one reservation landed in the session. Reports lot count,
  reservation count, and aggregate revenue, with a `Открыть сводку`
  button into the digest modal.

## Per-session aggregates

The dashboard tracks per-session totals client-side without backend
changes:

- `state.lotsSeenThisSession` — distinct `lotSessionId`s seen.
- `state.eventsByLot` — last-known reservation events per lot.
- `aggregatePerViewer()` — running totals keyed by `viewerId`, used in
  the reservation list ("итого N брони, X ₽" badge when count > 1) and
  in the post-stop digest banner.

## Active-lot indicators

- `lotAgePill` — minutes since the lot opened, updated every 30 s.
  Goes amber after 10 minutes as a hint to wrap up.
- Stock pill text: `осталась последняя` (1), `осталось N` (≤2),
  `нет в наличии` (0). Coloring escalates amber → red.

## Wishlist modal

The dashboard has a full wishlist modal with active/archive/settings tabs,
manual add, draft restore from `localStorage`, inline edits, open-order checks,
and purchase-order creation.

## Reservation digest modal

The dashboard can preview per-client reservation digests for a date, select
which clients to message, and send VK DMs through
`/api/reservation-digests/send`.

## Related pages

- [[http-api]]
- [[live-commerce-flow]]
- [[wishlist]]
- [[reservation-digests]]
- [[logging-and-diagnostics]]
