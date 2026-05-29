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
- `test/price-detector.test.js` — spoken price detection.
- `test/reservation-digest-log.test.js` — reservation digest log behavior.
- `test/reservation-parser.test.js` — VK comment intent parsing (reservation
  keywords, bare codes, `preferredCode` against phone/price collisions).
- `test/ws-helpers.test.js` — pure helpers in `server/ws-helpers.js`
  (VK comment id / error code parsing, bounded id sets, reservation reply
  templates, fatal-comment-read classification).

Full suite: 131 tests, all passing as of 2026-05-29.

## Documentation note

Some older docs still say no test command exists. Use this page and
`package.json` as current evidence, and update [[documentation-drift]] when the
docs are synchronized.
