# Documentation drift

This page tracks places where source documents differ from the current tree.
Use it to keep contradictions explicit instead of hiding them in wiki prose.

## Test command exists

**Resolved 2026-06-11.** `README.md` now documents `npm test` with the current
test count (290+) and notes the CI test gate in
`.github/workflows/release.yml`. `AGENTS.md` and `CLAUDE.md` were corrected
earlier, on 2026-05-25.

## Backend file list expanded

The current backend includes modules not fully reflected in older summaries:

- `server/bundle-index.js`
- `server/price-detector.js`
- `server/reservation-digest-log.js`
- `server/session-jsonl.js`
- `server/settings-store.js`
- `server/state-store.js`
- `server/wishlist-store.js`
- `server/wishlist-submissions.js`

Resolved for `AGENTS.md` by moving the maintained module map to [[repo-map]].
Recommended fix: update `README.md` later or state that it intentionally lists
only the main modules.

## Planned preorders are not runtime behavior yet

`TODO.md` describes the planned preorder workflow in detail. It must remain
`planned` in this wiki until matching backend methods, HTTP endpoints, UI, and
tests exist.

## MoySklad variants are not covered by product lookup

Real MoySklad customer-order positions checked on 2026-06-08 include both
`assortment.type = "product"` and `assortment.type = "variant"`. Current
runtime lookup in `server/moysklad.js` and the catalog-code cache query only
`entity/product`, so variant-only article codes can be missing from voice/manual
catalog validation.

The same real-account check found a higher-risk collision: a numeric variant
code can also exist as a different product code. In that case, current product
lookup can resolve the buyer/operator code to the product while MoySklad orders
show the intended article as a variant.

Recommended fix: make product-card lookup and product-code cache
variant-aware. Search `entity/variant` as well as `entity/product`, preserve the
assortment `meta.type`, and reject or escalate duplicate codes across products
and variants instead of guessing.

## Reservation parser audit (2026-05-25)

Wiki review after introducing `server/reservation-parser.js` and
`mergeSameCodeRedetection`:

**Contradictions resolved this pass:**

- [[operator-feedback]] said repeating an article creates a new lot; this is
  no longer true since `mergeSameCodeRedetection`. Marked as resolved with a
  date stamp instead of deleted, so the historical context stays readable.
- [[reservation-flow]] said "the longest digit run wins" unconditionally;
  updated to reflect the new `preferredCode` rule (active lot's code wins
  when present among the digit groups).
- [[repo-map]] and [[testing-guide]] missed `server/reservation-parser.js`
  and `test/reservation-parser.test.js`; added.

**Resolved 2026-05-25 (this pass):**

- **Quantity parsed.** `server/reservation-parser.js` extracts `шт/x/*/пара`
  with hard-cap `10`; plumbed through ws-server reservation event into
  `server/moysklad.js` customer-order positions (both create and append
  paths). Stock guard uses `event.quantity` and bumps
  `committedReservationCount` accordingly. Tests:
  `test/reservation-parser.test.js` (quantity suite).
  **Exception:** the operator voice-append path (`appendReservationQuantity`,
  `server/quantity-command-parser.js`) intentionally skips the stock guard
  ("operator-always-right") while still bumping `committedReservationCount`.
  See [[reservation-flow]] → "Stock protection" / "Voice quantity (+N шт)".
- **Stock-unknown one-shot refresh.**
  `ensureStockKnownBeforeFirstReservation` in `server/ws-server.js`
  retries `moysklad.getProductCardByCode` before the first reservation
  when `availableStock` is null/non-finite. Falls back to floor=1 with
  `stock_unknown_first_reservation` log entry.
- **Poison-vs-sticky-lot.** `mergeSameCodeRedetection` now skips
  `vk.publishPriceUpdate` when the lot has accepted reservations —
  internal `voicePrice` still updates, but the public card stays on the
  old price rather than risk poisoning. Logged as
  `redetection_price_update_skipped_due_to_reservations`.
- **`triggerActiveUntil` refactor.** Extracted `resetTriggerWindow(reason)`
  in `server/ws-server.js`. All five reset sites now go through it.
  Debug logging gated by `DEBUG_TRIGGER_WINDOW=1`.

**Still open (not blockers):**

- Replay a recent VK comments JSONL against the parser as a regression
  fixture under `test/` to lock in real production noise.
- Surface `redetection: true` in the operator dashboard so a "sticky"
  re-detection is visually distinct from a fresh `lot_opened`.
- Consider a stop-list (`цена`, `сколько`, `стоит`, `?`) to harden the
  bare-code path against future false positives even though current tests
  cover the obvious cases.
- Quantity dashboard setting (per-lot or per-buyer cap), if `10` proves
  too generous or too tight in practice.

## Project audit pass (2026-05-29)

Audit-driven fixes landed in six commits (`82cda18` … `0f16ce3`).
Relevant durable changes:

**Security:**

- `npm audit fix` upgraded `ws` and `protobufjs`. `npm audit` is now
  clean.
- `server/auth.js` provides optional shared-token auth — gated by
  `API_TOKEN` in `.env`. Token accepted via Bearer header, `x-api-token`
  header, `api_token` cookie, or `?token=` query. Constant-time compare
  via `crypto.timingSafeEqual`. See [[configuration-and-secrets]].
- WS `/ws/stt` upgrade now checks `Origin`. Default allowlist is loopback;
  `ALLOWED_ORIGINS` env replaces it.
- `HOST` env var added; defaults to `0.0.0.0` for Docker, can be set to
  `127.0.0.1` for local-only access.

**Reliability:**

- `process.on("unhandledRejection")` and `process.on("uncaughtException")`
  handlers in `server/index.js` log instead of letting the process drop
  silently.
- 60-second timeout on the `/api/send-logs` bundle build so `logsInFlight`
  cannot stick.
- VK random IDs now use `crypto.randomInt` (was `Math.random`).
- `checkOrdersCache` is a bounded LRU (cap 1000) instead of an
  unlimited Map.
- `/health` now reports per-subsystem state (MoySklad cache, VK and
  SpeechKit config presence, safe mode) and returns `503` on degradation.
  See [[http-api]].
- Product-code-cache refresh in `server/index.js` tracks consecutive
  failures and logs `WARN product_code_cache_refresh_failing` at the third
  failure in a row, with a recovery line on success — replacing the
  previous silent `.catch(() => {})`.

**Refactor — god modules:**

- `server/ws-helpers.js` (new, 132 LOC) holds 13 pure helpers extracted
  from `server/ws-server.js` (2010 → 1919 LOC).
- `server/moysklad-helpers.js` (new, 107 LOC) holds 13 pure helpers
  extracted from `server/moysklad.js` (1356 → 1264 LOC).
- Deeper splits (reservation flow, comment polling, customer-order
  pipeline) are deferred — they need integration test scaffolding on
  WebSocket sessions first.

**Tests:**

- 56 new unit tests across `test/auth.test.js`,
  `test/ws-helpers.test.js`, `test/moysklad-helpers.test.js`.
- Full suite: 131/131 passing (up from 57).

**Still open from the audit:**

- No tests on `http-server.js`, `ws-server.js`, `vk.js`,
  `speechkit-stream.js` — these are the highest-value modules for
  integration tests (they move money / send messages).
- Deeper split of `ws-server.js` and `moysklad.js` per domain.

## Operator-audit pass (2026-05-29)

Full audit from the live-commerce operator perspective produced 20
items. 18 landed in commit `f5c3bde`; two deferred. Detailed summary
lives in [[operator-feedback]]. Highlights:

- Replaced every `window.confirm` in the operator flow with inline,
  non-blocking UI.
- New WS message types: `closeLot`, `setLotPrice` — operator-driven
  recovery from voice-pipeline misses.
- WS single-broadcast guard (409 on second connection, override with
  `?force=1`).
- `/login` HTML form replaces the bare-text 401 for API_TOKEN.
- Client-side per-session and per-buyer aggregates (lots, reservations,
  revenue) — feed both the post-stop banner and the per-row running
  totals without backend state-shape changes.

**Test coverage gap noted during the pass:** the new inline-banner
flows, `closeLot` / `setLotPrice` message paths, and the duplicate-WS
rejection live in code that has no integration tests (UI, WS upgrade
handler). The deferred items (#14 manual code entry, #16 cancel
reservation) cannot land safely until that test scaffolding exists.
