# Repo map

This page maps the current V-Amber repository at a high signal level. It is not
a replacement for code search, but it gives agents the right entry points.

## Backend

`server/` contains the Node.js backend:

- `server/index.js` starts the application and wires services.
- `server/http-server.js` serves `web-ui/` and HTTP API endpoints.
- `server/ws-server.js` owns WebSocket session flow, active lots,
  reservations, VK comments, discounts, safe mode broadcasts, and runtime state.
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
- `test/moysklad-open-order-check.test.js`
- `test/price-detector.test.js`
- `test/reservation-digest-log.test.js`
- `test/reservation-parser.test.js`

See [[testing-guide]].

## Runtime and ignored data

Do not treat these as source files:

- `node_modules/`
- `logs/`
- `.env`

`logs/` still matters as operational evidence and source material for
`knowledge/raw/` notes when redacted.
