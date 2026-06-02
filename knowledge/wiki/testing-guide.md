# Testing guide

V-Amber uses Node's built-in test runner.

## Entry point

Run all current tests with:

```bash
npm test
```

The `package.json` script expands to:

```bash
node --test "test/**/*.test.js"
```

## Current focused test files

- `test/article-extractor.test.js` — spoken product-code parsing.
- `test/auth.test.js` — `API_TOKEN` token sources (Bearer, x-api-token,
  cookie, query), constant-time length-mismatch safety, Origin allowlist
  default and `ALLOWED_ORIGINS` override, `set-cookie` shape.
- `test/moysklad-helpers.test.js` — pure helpers in
  `server/moysklad-helpers.js` (auth header, URL building, money /
  quantity normalization, entity meta, product snapshot fallback chain).
- `test/moysklad-open-order-check.test.js` — MoySklad order-check behavior.
- `test/moysklad-position-id.test.js` — customer-order creation fallback that
  resolves the stored MoySklad position id after create responses without it.
- `test/price-detector.test.js` — spoken price detection.
- `test/bundle-index.test.js` — diagnostic bundle summary counts for finalized
  reservations and legacy reservation records.
- `test/logger.test.js` — server logger flush behavior before diagnostics read
  `logs/server.log`.
- `test/session-log.test.js` — unique session filenames and JSONL reservation
  outcome records.
- `test/reservation-digest-log.test.js` — reservation digest log behavior.
- `test/reservation-parser.test.js` — VK comment intent parsing (reservation
  keywords, bare codes, `preferredCode` against phone/price collisions).
- `test/vk.test.js` — VK publisher helpers for comment params and photo
  attachment guards.
- `test/ws-helpers.test.js` — pure helpers in `server/ws-helpers.js`
  (VK comment id / error code parsing, bounded id sets, reservation reply
  templates including silent `out_of_stock`, fatal-comment-read
  classification).
- `test/ws-server.integration.test.js` — WebSocket session harness smoke
  coverage for the live-commerce flow.
- `test/ws-server.logging.test.js` — session JSONL events for reservation
  outcomes and multi-lot state snapshots.
- `test/ws-server.manual-code.test.js` — operator `manualCode` scenarios,
  including catalog gating, same-code merge stability, and reservation floor.
- `test/ws-server.cancel-reservation.test.js` — dashboard reservation cancel
  flow, exact MoySklad position delete, safe-mode block, and stock-slot
  release.

The suite changes frequently; trust `npm test` output for the current count.

## Documentation note

Some older docs still say no test command exists. Use this page and
`package.json` as current evidence, and update [[documentation-drift]] when the
docs are synchronized.
