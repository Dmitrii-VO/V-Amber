# Web dashboard

The browser dashboard lives in `web-ui/`. It is served by
`server/http-server.js` and talks to backend APIs plus the WebSocket audio
stream.

## Core session controls

`web-ui/app.js` lets the operator:

- choose and refresh microphone devices (selection persists in localStorage);
- pick the broadcast method with the `#efirModeToggle` segmented control
  in the topbar («ВК эфир» / «Свой эфир», persists in localStorage) — shows
  only the VK-URL field or only the stream/chat panels for the selected
  method. UI-only: both backend pollers keep running regardless of the
  selection. See [[stream-integration#Эфир mode toggle (2026-07-06)]];
- validate and persist a VK live video URL;
- start and stop WebSocket audio streaming (Space keyboard shortcut);
- view transcript, active lot, detections, reservations, metrics, and uptime;
- toggle safe mode;
- refresh the product-code cache (inline banner at session start with a
  remember-choice flag, no blocking confirm dialog);
- download diagnostic logs;
- close the active lot manually (`× закрыть лот` button — sends
  `closeLot` WS message);
- view all currently open lots in `#openLotsList` and close a specific old or
  current lot by `lotSessionId`/code;
- override the active lot price by clicking the price field (sends
  `setLotPrice` WS message, salePrice and voicePrice both updated, VK
  card refreshed);
- enter an article code manually via the `код вручную` field on the
  active-lot panel (`#manualCodeForm`, sends `manualCode` WS message) —
  for when SpeechKit misheard the code. The field only shows while the
  stream is running, and the server rejects codes not in the MoySklad
  catalog. See [[http-api]] and [[deferred-operator-features]] #14.
- cancel a confirmed reservation via the `× отменить` button on each
  reservation row (sends `cancelReservation` WS message after a confirm
  prompt) — removes the buyer's MoySklad position and frees the stock
  slot. The reservation row carries `lotSessionId`/code so cancellation works
  for old open lots, not only the current active lot. Blocked under safe mode. See [[http-api]] and
  [[deferred-operator-features]] #16.
- The «Брони» panel shows a persistent voice cancel-command format hint
  («Имя Фамилия отмена лота 03204»), reminding the operator that the name is
  required and «лот»/«бронь» must precede the code. The parser is strict on this
  (money path), so the hint reduces fumbled on-air cancellations. See
  [[vk-comments]] and [[operator-feedback]] W3.

The microphone flow uses Web Audio API and `web-ui/audio-processor.js` to
capture PCM, downsample to 16 kHz, and send frames over WebSocket.

## Operator banners

Three inline banners replace blocking dialogs and surface state changes:

- `#cacheBanner` — pre-start prompt to load product codes. Stays inline
  so transcripts can still flow; choice can be remembered.
- `#safeModePrestreamBanner` — appears before/during stream start when safe
  mode is enabled, warning that VK publications and MoySklad writes are
  blocked.
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
- `#openLotsList` — compact list of all open lots. The current `activeLot` is
  highlighted; each row has a close button for that specific lot.

## Stream panel

`#streamPanel` (right column, above "Брони") shows connection info and
live status for the self-hosted MediaMTX stream — an alternative to VK
Live. Hidden unless `STREAM_MEDIAMTX_API_URL` is configured **and** the
`#efirModeToggle` is set to «Свой эфир» (see above).
Shows RTMP URL, publish key, and viewer link (each with a "Копировать"
button), a status dot (`В эфире · N зрителей` / `Стрим не запущен` /
`Ошибка связи с сервером`) and, since 2026-07-03, one-button broadcast
control: «Запустить эфир» runs the server-side orchestrator (preflight
with auto-fix → OBS start → MediaMTX confirmation) and renders its step
list in `#streamChecklist`; «Остановить» stops the OBS output;
«Проверить эфир» toggles an on-demand 5s status poll that auto-stops
after 3 consecutive offline cycles (there is no always-on background
poll). See [[stream-integration]].

## Live preview + comments feed (center column, 2026-07-22)

Added for Roman's operator scenario: he broadcasts with the iPhone as OBS's
Continuity Camera, so the phone screen is unusable and he can't see the эфир
picture or read comments on it. Both now live on the laptop dashboard, in the
center column (`.col--chat`, which now expands to 360px whenever visible, keyed
on `#commentsPanel` rather than the old `#chatPanel`).

- **`#previewPanel` «Картинка эфира»** — a 16:9 `<video>` playing the own
  MediaMTX HLS via vendored `web-ui/hls.min.js`, sourced from the same-origin
  proxy `/api/stream/hls/index.m3u8` (see [[http-api]] / [[stream-integration]]
  for why a proxy and not iframe/direct HLS). Muted autoplay with «Включить
  звук», an offline overlay («Эфир ещё не начался»), a live/offline badge, and a
  7s retry loop — mirrors the public `/efir/` player. Shown only in «Свой эфир»
  mode when the stream is configured (that is when MediaMTX actually carries the
  feed); `applyEfirMode` starts/stops the player as the toggle flips.
- **`#commentsPanel` «Комментарии зала»** — a unified live feed of **every**
  non-blocked viewer comment (VK + own chat), always visible. The server emits a
  `viewerComment` WS message per comment from `ingestViewerComment`
  (`server/ws-server.js`), placed right after the block filter so spammers never
  appear and before reservation parsing so plain chatter shows too. Each row has
  a source badge (`VK` blue / `чат` amber) + author + text; «×» clears the feed.
  Each row also has a `🚫` action: on a VK row it triggers a **real VK ban +
  comment deletion** (confirm dialog naming the community-wide consequence,
  `POST /api/viewers/ban`); on a chat row it soft-blocks only. See
  [[vk-comments#Real VK ban + comment deletion (2026-07-22)]]. This is distinct
  from the reservation-focused panels (which only surface `бронь`) and from the
  `#chatPanel` reply box.

The `🚫 Блокировки` modal marks VK-banned entries with a «бан в ВК» badge
(`blockedBy: "vk_ban"`) to distinguish a real community ban from a soft block.

## Wishlist modal

The dashboard has a full wishlist modal with active/archive/settings tabs,
manual add, draft restore from `localStorage`, inline edits, open-order checks,
and purchase-order creation.

The active wishlist table shows the buyer in the `Заказавший` column. The cell
uses `entry.viewerName`, and shows `+N` when repeated seen-events exist for the
same entry. This replaced the older `Зрители` count column during the W5/W6
waiting-list phase.

Rows in the `Без поставщика` group use a typeahead supplier field instead of a
native dropdown. The operator can type part of the supplier name and pick the
matching MoySklad supplier from browser suggestions; the UI still saves the
resolved `supplierId` so purchase-order creation receives a valid agent id.

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
- [[stream-integration]]
