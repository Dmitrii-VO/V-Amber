# Repo map

This page maps the current V-Amber repository at a high signal level. It is not
a replacement for code search, but it gives agents the right entry points.

## Backend

`server/` contains the Node.js backend:

- `server/index.js` starts the application and wires services. Hosts
  top-level `unhandledRejection` and `uncaughtException` handlers and the
  product-code-cache refresh loop with consecutive-failure tracking.
- `server/http-server.js` serves `web-ui/` and HTTP API endpoints.
- `server/ws-server.js` owns WebSocket session flow, active lots,
  reservations, VK comments, discounts, safe mode broadcasts, and runtime state.
- `server/ws-helpers.js` holds pure helpers extracted from `ws-server.js`
  (VK comment ID parsing, error code extraction, broadcast-date formatting,
  bounded id sets, reservation reply templates, fatal-comment-read detection).
- `server/moysklad-helpers.js` holds pure helpers extracted from
  `moysklad.js` (auth header, URL building, money/quantity normalization,
  entity meta, product snapshot, broadcast marker).
- `server/auth.js` builds the optional `API_TOKEN` middleware (HTTP and WS)
  and the WS `Origin` allowlist. Uses `crypto.timingSafeEqual` for token
  comparison.
- `server/speechkit-stream.js` streams microphone audio to Yandex SpeechKit.
- `server/article-extractor.js` extracts spoken product codes.
- `server/reservation-parser.js` parses VK buyer comments into reservation
  and wishlist intents. See [[reservation-flow#Accepted comment formats]].
- `server/discount-detector.js` and `server/price-detector.js` detect spoken
  discounts and prices.
- `server/moysklad.js` is the MoySklad API client.
- `server/vk.js` is the VK API client.
- `server/product-code-cache.js` stores MoySklad product-code hints in memory.
- `server/safe-mode.js` wraps external write operations.
- `server/state-store.js`, `server/settings-store.js`, and
  `server/wishlist-store.js` store runtime state, UI settings, and wishlist
  entries.
- `server/wishlist-submissions.js` stores wishlist submission drafts and
  results.
- `server/blocked-viewers-store.js` stores blocked viewers; their comments are
  dropped at the top of `ingestViewerComment`. See
  [[vk-comments#Blocking spammers]]. Right after that filter,
  `ingestViewerComment` emits a `viewerComment` WS message per comment for the
  dashboard's «Комментарии зала» feed.
- `web-ui/hls.min.js` — hls.js vendored into the dashboard for the «Картинка
  эфира» preview, played through the `/api/stream/hls/*` same-origin proxy
  (`server/http-server.js`). See [[stream-integration]] / [[web-dashboard]].
- `server/stream-relay.js` — V-Amber-managed ffmpeg relay that mirrors the own
  эфир to VK Live (dual-stream). Best-effort, orchestrated by
  `server/stream-orchestrator.js` on «Запустить/Остановить эфир». See
  [[stream-integration#Dual-stream: mirror the эфир to VK (2026-07-22)]].
- `server/session-log.js`, `server/session-jsonl.js`,
  `server/reservation-digest-log.js`, `server/logger.js`,
  `server/log-bundle.js`, `server/bundle-index.js`, and `server/zip-writer.js`
  cover logs and diagnostic bundles.
- `server/version-check.js` checks GitHub Releases at startup.
- `server/install-id.js` stores the local install ID.

## Web UI

`web-ui/` contains the static browser dashboard:

- `web-ui/index.html` is the operator panel markup.
- `web-ui/app.js` contains dashboard state and client API calls.
- `web-ui/audio-processor.js` is the microphone AudioWorklet processor.
- `web-ui/styles.css` contains dashboard styles.

## Scripts

`scripts/` contains one-off operational utilities:

- `scripts/backfill-vk-id-dry-run.js` diagnoses MoySklad counterparties and VK
  ID attributes without writes.
- `scripts/find-overbooked.js` scans the MoySklad stock report for products
  where available stock is negative.
- `scripts/replay-safe-mode.js` replays safe-mode reservations from
  `server.log` into MoySklad when run with `--apply`.

See [[service-scripts]].

## Tests

`test/` currently contains Node test-runner tests:

- `test/article-extractor.test.js`
- `test/auth.test.js`
- `test/moysklad-helpers.test.js`
- `test/moysklad-open-order-check.test.js`
- `test/price-detector.test.js`
- `test/reservation-digest-log.test.js`
- `test/reservation-parser.test.js`
- `test/ws-helpers.test.js`

See [[testing-guide]].

## Runtime and ignored data

Do not treat these as source files:

- `node_modules/`
- `logs/`
- `.env`

`logs/` still matters as operational evidence and source material for
`knowledge/raw/` notes when redacted.
