# Deferred operator features

Two operator-audit items were intentionally **not** landed in commit
`f5c3bde`. They touch the live-commerce critical path (voice pipeline,
real money flow) and need integration test scaffolding before they can
land safely. This page captures the failure modes so we don't lose the
context when the test work begins.

## Prerequisite — WebSocket integration tests

Both deferred items need the same scaffolding. Estimated 1–2 days of
work, separate PR:

- Mock `WebSocket` server-side: feed it scripted message sequences and
  binary audio frames; assert on outgoing JSON payloads.
- Mock the VK client (`server/vk.js`): record `publishLotCard`,
  `publishLotClosed`, `publishPriceUpdate`, `publishReservationReply`,
  `sendDirectMessage` calls and their order.
- Mock the MoySklad client (`server/moysklad.js`): fixture-based
  responses for `getProductCardByCode`, `ensureCounterparty`,
  `createCustomerOrderReservation`, `appendPositionToCustomerOrder`,
  `getReservationDigestForDate`, plus a new `removePositionFromOrder`
  once it exists.
- Reset helpers for module-level singletons: `nextConnectionId`,
  `nextLotSessionId`, `nextDetectionId` so test order doesn't leak.
- Helper to drive the trigger window: assert that
  `triggerActiveUntil` and `resetTriggerWindow` paths behave
  identically for `voice` and (new) `manual` sources.

Once those exist, the two items below land in dedicated PRs with
scenario tests.

## #14 — Manual code entry on the active lot

What the operator expects: a text field on the active-lot card. Type
`03204` → backend behaves as if speech recognition just confirmed it.

### Failure modes

1. **`mergeSameCodeRedetection`** in `server/ws-server.js` — if the
   operator types the active lot's own code, this function must keep
   the `lotSessionId` and reservations intact. Logic is already
   conditioned on `lot.product.priceSource` after the `setLotPrice`
   change; another branch on `source === "manual"` will compound the
   risk of closing a lot that has accepted reservations.
2. **`triggerActiveUntil` window** — voice triggers (`код товара`,
   `артикул`) open this window. Manual entry bypasses the window
   entirely, but downstream state assumes any confirmed detection came
   through the window path. Five reset sites already go through
   `resetTriggerWindow` (see [[documentation-drift]]); a manual path
   needs its own reset semantics.
3. **`ensureStockKnownBeforeFirstReservation`** — depends on
   `lot.openedAt` and `lot.code` arriving through the voice path.
   Manual injection with `availableStock` still `null` — what does
   the operator see? Currently the system falls back to `floor=1`
   with a `stock_unknown_first_reservation` log.
4. **YandexGPT fallback** — manual codes must NOT enter the LLM
   fallback path (`server/article-extractor.js`). The LLM is gated on
   "voice detection failed but trigger fired" — manual entry has no
   trigger and no transcript, so it should skip cleanly. Needs an
   explicit early return.

### Required test scenarios

- Manual code on `idle` lifecycle → new lot opens, VK card publishes,
  comment polling starts.
- Manual code matching the **active** lot's code → goes through
  `mergeSameCodeRedetection`; no new lot, no new VK card, reservations
  preserved.
- Manual code → voice code → manual code chain → VK comment poller
  runs exactly once (not three pollers running in parallel).
- Manual code with unknown stock → first reservation falls back to
  `floor=1`, dashboard surfaces the warning.
- Manual code with `lot.acceptedReservations > 0` → must not poison
  the lot or skip `publishPriceUpdate`.

### Partial workaround already in place

`#13` (close lot) + `#15` (edit price) cover the most common operator
misery: SpeechKit confirmed the wrong code, or voice-price detection
misfired. The operator closes the lot, retries verbally with the right
code, or edits the price inline. The gap is "fully type the code with
the keyboard" — rare enough that operator-feedback hasn't flagged it
as a blocker yet.

## #16 — Cancel reservation from the UI

What the operator expects: a button on each reservation row. Click
→ reservation removed from MoySklad, `committedReservationCount`
decrements, stock frees up for the next buyer.

### Failure modes

1. **Idempotency on partial-fail.** MoySklad REST can 5xx after the
   `DELETE` already landed. Without an `idempotency-key` and a
   reconcile step, a retry deletes a *different* position of the same
   product when the buyer reserved twice (`reserved_appended` path).
2. **Safe-mode interaction.** `safe-mode` blocks write methods on
   `server/moysklad.js`
   (`createCustomerOrderReservation`,
   `appendPositionToCustomerOrder`, `createPurchaseOrder`). A new
   `removePositionFromOrder` must also go through `wrapWithSafeMode`,
   and the UI must surface "safe_mode_blocked" status — not silently
   fail.
3. **`committedReservationCount` and `acceptedUserIds`** in
   `ws-server.js` — the counter is cumulative and independent of the
   trimmed `events` buffer. Cancellation must either decrement (race
   with the next reservation that's in flight) or move the position
   to a new `cancelled` field (changes state shape). Either way the
   stock guard needs to read the right value.
4. **`reservation-digest-log.jsonl`.** If the operator already sent
   the daily digest DM to the client, then cancelled a reservation,
   the DM is now stale. Options: write a `cancelled` event into the
   log so the next digest re-send picks it up; require the operator
   to manually re-send. Either way the digest log contract changes.
5. **Empty customer order after delete.** If the cancelled position
   was the only one in the order, MoySklad keeps an empty order.
   Today the code never deletes an order — that's a new path with its
   own MoySklad semantics (orders with no positions are visible but
   unusable in the MoySklad UI).

### Required test scenarios

- Cancel single reservation → stock available count goes back up.
- Cancel `reserved_appended` reservation (buyer with multiple
  positions on one order) → only the targeted position is deleted.
- Cancel with MoySklad 5xx → retry deletes the same position, not a
  sibling.
- Cancel under safe-mode → UI shows blocked, MoySklad untouched.
- Cancel after `reservation-digest-log` recorded a DM → next digest
  preview reflects the change.

### Why no workaround

Operators currently fix reservations in the MoySklad UI directly,
which is the same path that existed before the audit. The UI displays
reservations in real time but does not manage them. This is
acceptable until cancellation can be done without risk to money flow.

## Tracking

- Operator-audit pass: see [[operator-feedback#Operator-audit pass
  (2026-05-29)]].
- Test gap context: see [[documentation-drift#Operator-audit pass
  (2026-05-29)]].
- Related runbook entries when these land: update
  [[runbooks-and-troubleshooting]] with operator-driven fix
  recipes.

## Related pages

- [[operator-feedback]]
- [[reservation-flow]]
- [[live-commerce-flow]]
- [[testing-guide]]
- [[documentation-drift]]
