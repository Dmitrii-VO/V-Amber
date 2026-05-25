# Documentation drift

This page tracks places where source documents differ from the current tree.
Use it to keep contradictions explicit instead of hiding them in wiki prose.

## Test command exists

`README.md` still contains older language saying that no verified test command
exists. `AGENTS.md` and `CLAUDE.md` were corrected on 2026-05-25. Current
`package.json` contains:

```json
"test": "node --test \"test/**/*.test.js\""
```

The current `test/` directory includes article extractor, MoySklad order check,
price detector, and reservation digest log tests.

Recommended fix: update `README.md` so `npm test` is listed as a verified
command.

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
