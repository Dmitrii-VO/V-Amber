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
`logs/moysklad-writes.jsonl`. Each journaled write to MoySklad is recorded as
`begin` and then `done` or `failed`, keyed deterministically. On startup the
file is replayed so a repeat of an already-applied write returns the stored
result instead of creating a second order.

Two write families are journaled, and only these:

- **Reservations** — `createCustomerOrderReservation` and
  `appendPositionToCustomerOrder`, keyed
  `${lotSessionId}::${viewerId}::${commentId}`.
- **Purchase orders** — `createPurchaseOrder`, keyed
  `po::${draftId}::${groupHash}`. The HTTP handler passes `draftId` and
  `groupHash` into the call purely as the journal key; `createPurchaseOrder`
  itself ignores them. Wishlist submissions already cache a *successful*
  result, but that write happens after the POST returns — a lost response was
  recorded as a failure, and re-submitting the group created a second
  purchase order.

Writes without a `commentId` (manual reservation from the banner, voice paths)
get no key and are not deduplicated — behavior is unchanged for them.

Other MoySklad writes are deliberately left out. Position removal is already
idempotent (a repeat DELETE with 404 counts as success), price updates set an
absolute value, and counterparty creation looks up an existing counterparty by
VK ID, name, and description first.

Failure outcomes are classified conservatively: `not_applied` only when a
connection could not be established and for 4xx responses other than 429.
Timeouts, connection resets, and 5xx responses stay `unknown`, because
MoySklad may have applied the write before the response was lost. See
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
- **Append path** — records the product position count before the write in the
  durable `begin` entry, then compares it with the count after an unknown
  outcome. Exactly one additional position means the lost write landed. This
  baseline includes positions created before the journal existed and positions
  that an operator added manually.
- **Purchase-order path** — there is no marker to look for: the description is
  built from the operator's template and read by people. Instead the reconciler
  fetches the supplier's 50 newest purchase orders, keeps those matching the
  store and the exact description, and compares each one's positions
  (product, quantity, price) with the group being written — the same fields
  `groupHash` is built from, so neighbouring groups of the same submission
  cannot match. Exactly one match means the lost write landed; more than one
  match, or more than five same-description candidates, is `inconclusive`.

Any other difference returns `inconclusive`, and so does a failed
reconciliation or a missing counterparty. `inconclusive` never retries and
never claims success — it surfaces the reservation to the operator instead of
risking a duplicate order or a silently lost бронь.

On startup, `pending` and `unknown` entries are reconciled before any new POST
with the same key. Concurrent calls with the same key share one in-flight
operation. If the journal cannot persist `begin`, the external write does not
start. Append writes also stop when the pre-write position baseline cannot be
read, because an unknown result would otherwise be impossible to reconcile.

## Reservation digest log

`server/reservation-digest-log.js` writes sent digest records and supports
dedupe by key, date, and viewer. See [[reservation-digests]].

## Related pages

- [[runtime-architecture]]
- [[wishlist]]
- [[reservation-flow]]
- [[logging-and-diagnostics]]
