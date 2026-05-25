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
- `test/moysklad-open-order-check.test.js` — MoySklad order-check behavior.
- `test/price-detector.test.js` — spoken price detection.
- `test/reservation-digest-log.test.js` — reservation digest log behavior.
- `test/reservation-parser.test.js` — VK comment intent parsing (reservation
  keywords, bare codes, `preferredCode` against phone/price collisions).

## Documentation note

Some older docs still say no test command exists. Use this page and
`package.json` as current evidence, and update [[documentation-drift]] when the
docs are synchronized.
