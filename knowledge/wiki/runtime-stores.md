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

## Reservation digest log

`server/reservation-digest-log.js` writes sent digest records and supports
dedupe by key, date, and viewer. See [[reservation-digests]].

## Related pages

- [[runtime-architecture]]
- [[wishlist]]
- [[reservation-flow]]
- [[logging-and-diagnostics]]
