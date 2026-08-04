# Runtime stores

V-Amber persists local runtime state under `logs/`. These files are operational
data, not source code, but redacted findings can become `knowledge/raw/`
evidence.

## Active state

`server/state-store.js` writes `logs/active-state.json` with active lot,
session file path, connection ID, and reservation events. Startup recovery in
`server/index.js` reads it, writes orphan reservation evidence to session logs,
and then clears the file.

## Settings

`server/settings-store.js` writes `logs/settings.json`. It supports `load`,
`get`, `getWishlist`, and `patch`; PATCH uses deep merge so partial settings
updates preserve existing values.

Wishlist settings include default store, default supplier, old-entry threshold,
VK notification flag, and purchase-order description template.

## Wishlist events

`server/wishlist-store.js` writes append-only JSONL to `logs/wishlist.jsonl`.
It stores active entries, archive entries, manual additions, edits, removals,
consumption into purchase orders, and reconciliation from submission results.

## Wishlist submissions

`server/wishlist-submissions.js` writes `logs/wishlist-submissions.json`. It
stores draft group results so purchase-order submission can be retried without
duplicating already-created purchase orders.

## MoySklad write journal

`server/write-journal.js` writes append-only JSONL to
`logs/moysklad-writes.jsonl`. Each reservation write to MoySklad is recorded as
`begin` and then `done` or `failed`, keyed by
`${lotSessionId}::${viewerId}::${commentId}`. On startup the file is replayed so
a repeat of an already-applied write returns the stored result instead of
creating a second customer order.

Writes without a `commentId` (manual reservation from the banner, voice paths)
get no key and are not deduplicated — behavior is unchanged for them.

Failure outcomes are classified conservatively: `not_applied` only for
connection errors and 4xx other than 429; timeouts and 5xx stay `unknown`,
because MoySklad may have applied the write before the response was lost. See
[[reservation-flow]] and [[order-recovery-from-logs]].

### Retry and reconciliation

Write retry is enabled and bounded by `MOYSKLAD_WRITE_RETRY_ATTEMPTS`
(default 2, i.e. one retry) and `MOYSKLAD_WRITE_RETRY_BASE_DELAY_MS`
(default 400). The default is deliberately low: retry runs on the reservation
hot path while a buyer waits in the эфир, and each attempt costs up to
`MOYSKLAD_REQUEST_TIMEOUT_MS`.

A write is retried only when the outcome is known to be `not_applied`. For
`unknown`, `server/write-reconciler.js` asks MoySklad what actually happened:

- **Create path** — looks for a customer order whose description carries the
  `commentId=` marker that `createCustomerOrderReservation` already writes.
  Nothing extra is stamped into MoySklad; operators read those descriptions.
  Order state is not filtered, since the operator may already have closed it.
- **Append path** — compares how many positions of the product are really in
  the order against how many writes the journal has confirmed
  (`journal.countApplied`). Exactly one more means the lost write landed.

Any other difference returns `inconclusive`, and so does a failed
reconciliation or a missing counterparty. `inconclusive` never retries and
never claims success — it surfaces the reservation to the operator instead of
risking a duplicate order or a silently lost бронь.

## Reservation digest log

`server/reservation-digest-log.js` writes sent digest records and supports
dedupe by key, date, and viewer. See [[reservation-digests]].

## Related pages

- [[runtime-architecture]]
- [[wishlist]]
- [[reservation-flow]]
- [[logging-and-diagnostics]]
