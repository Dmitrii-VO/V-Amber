# Deferred operator features

Two operator-audit items were intentionally **not** landed in commit
`f5c3bde`. They touch the live-commerce critical path (voice pipeline,
real money flow) and needed integration test scaffolding before they
could land safely.

**Status:**

- **WebSocket integration test harness** — landed (`test/helpers/ws-harness.js`).
- **#14 — manual code entry** — **landed.** Kept below as a design
  record; see the "Implemented" note in its section.
- **#16 — cancel reservation** — still deferred. The only remaining item.

## WebSocket integration test harness (landed)

`test/helpers/ws-harness.js` boots a real `http.Server` + `attachWsServer`
with mock services and a real `ws` client. What it provides today:

- **Fake SpeechKit session** via the `services.createSpeechKitSession`
  seam — scripted transcripts are fed through `session.handlers.onFinal`,
  no network to Yandex.
- **Recording VK mock** (`createVkMock`): records `publishLotCard`,
  `publishLotClosed`, `publishPriceUpdate`, `publishReservationReply`,
  `publishDiscountUpdate` calls and their order; `vk.pushComment(...)`
  queues comments that `getComments` returns, so the reservation poller
  can be driven without the VK API.
- **MoySklad mock** (`createMoyskladMock`): fixture cards by code plus
  `ensureCounterparty`, `findBroadcastCustomerOrderForCounterparty`,
  `appendPositionToCustomerOrder`, `createCustomerOrderReservation`.
- **Module-singleton reset** via the exported `__resetIdCountersForTests`
  (`nextConnectionId`, `nextLotSessionId`, `nextDetectionId`), so test
  order doesn't leak.
- **Persistence isolation** via the `services.createSessionLog`,
  `services.saveActiveState`, `services.clearActiveState` seams — tests
  never touch the session-log files or `logs/active-state.json`.
- A sequential-cursor `client.waitFor(...)` over the server→client
  message stream.

**What #16 will still need added to the harness:** a
`removePositionFromOrder` mock (once that method exists on
`server/moysklad.js`), `getReservationDigestForDate`, and a safe-mode
toggle assertion path. See the #16 failure modes below.

## #14 — Manual code entry on the active lot (landed)

What the operator expects: a text field on the active-lot card. Type
`03204` → backend behaves as if speech recognition just confirmed it.

> **Implemented.** WS message `manualCode { code }` in `server/ws-server.js`
> (next to `setLotPrice`/`closeLot`), UI form `#manualCodeForm` in
> `web-ui/`, scenarios in `test/ws-server.manual-code.test.js`. Design
> decisions that resolved the failure modes below:
> - **Variant A** — manual entry requires an active STT stream
>   (`activeRunId != null`); the UI form is hidden otherwise and the
>   server re-checks. Lot lifecycle (VK poller, session log, close) is
>   only wired while a stream runs.
> - **Catalog-gated** — the code must be in `productCodeCache`; an
>   unknown code or unloaded catalog is rejected with a `warning`
>   ("all products must be in the MoySklad DB").
> - The handler builds a synthetic `confirmed` detection and calls
>   `handleConfirmedDetection` directly, **bypassing `detectArticle`** —
>   so FM#4 (LLM fallback) is unreachable by construction, not by a flag.
> - No `source === "manual"` branch was added to
>   `mergeSameCodeRedetection` (FM#1): with `voicePrice: null` the merge
>   is already a no-op for price/VK and preserves reservations.
> - `ensureStockKnownBeforeFirstReservation` (FM#3) and
>   `resetTriggerWindow` (FM#2) are inherited unchanged via
>   `handleConfirmedDetection`.

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

All covered in `test/ws-server.manual-code.test.js`: Variant-A gate,
catalog rejection (unknown code + unloaded catalog), idle open with
`source: "manual"`, same-code merge, manual→voice→manual single lot,
different-code close+reopen, unknown-stock first reservation at `floor=1`,
and same-code re-entry preserving an accepted reservation (no poison, no
close). The reservation scenarios drive the comment poller via
`vk.pushComment` in the harness.

### History — the workaround this replaced

Before #14, `#13` (close lot) + `#15` (edit price) covered the most common
operator misery: SpeechKit confirmed the wrong code, or voice-price
detection misfired. The operator closed the lot, retried verbally with the
right code, or edited the price inline. The remaining gap — "fully type the
code with the keyboard" — is now closed by `manualCode`. The voice retry
still works and remains the fastest fix when the mic is live; see the
recipe in [[runbooks-and-troubleshooting]].

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
- #14 runbook recipe ("SpeechKit misheard the article code") landed in
  [[runbooks-and-troubleshooting]]; the WS contract is in
  [[http-api#Operator WS messages]] and the UI in [[web-dashboard]].
- When #16 lands, add its operator-driven fix recipe to
  [[runbooks-and-troubleshooting]] the same way.

## Related pages

- [[operator-feedback]]
- [[reservation-flow]]
- [[live-commerce-flow]]
- [[testing-guide]]
- [[documentation-drift]]
