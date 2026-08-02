# Service scripts

`scripts/` contains one-off diagnostics and recovery helpers. They read `.env`
and are not part of the normal runtime loop.

## backfill-vk-id-dry-run

```bash
node scripts/backfill-vk-id-dry-run.js
```

Scans MoySklad counterparties, finds the `VK ID` attribute, counts already
populated values, detects `viewerId=` candidates in descriptions, and reports
duplicate groups. It is dry-run only and does not write to MoySklad.

## find-overbooked

```bash
node scripts/find-overbooked.js
```

Scans the MoySklad stock report and prints products where available stock is
negative, sorted by the largest deficits. Useful when reservation behavior or
manual corrections may have overbooked inventory.

## replay-safe-mode

```bash
node scripts/replay-safe-mode.js
node scripts/replay-safe-mode.js --log=logs/worklogs/server.log
node scripts/replay-safe-mode.js --bundle=logs/v-amber-logs-...zip
node scripts/replay-safe-mode.js --apply
```

Parses `safe-mode` `reservation_logged_only` events from `server.log`. Without
`--apply`, it prints a dry-run table. With `--apply`, it creates MoySklad
customer orders through the existing client and skips already-applied
reservations on repeat runs.

Reading ZIP bundles requires `adm-zip`; if it is unavailable, extract the
bundle manually and pass `--log=PATH`.

## recover-orders-from-logs

```bash
node scripts/recover-orders-from-logs.mjs --sessions a.jsonl,b.jsonl --date 2026-06-27
node scripts/recover-orders-from-logs.mjs --sessions a.jsonl,b.jsonl --date 2026-06-27 --execute
```

Replays `reservation_finalized` events from эфир **session jsonl** files into
MoySklad customer orders. Use when MoySklad auth died mid-эфир (HTTP 401 →
`product_not_found`, zero orders created) and the брони survive only in the
logs. Resolves article→product and viewer→counterparty exactly like the live
app, allocates first-come up to `availableStock`, and writes the rest to
`logs/order-recovery-overflow.json`. Idempotent via the `#Эфир <date>` marker.
Full procedure: [[order-recovery-from-logs]].

## recover-overflow-purchase-order

```bash
node scripts/recover-overflow-purchase-order.mjs --supplier "ИП Галямов Дмитрий Сергеевич"
node scripts/recover-overflow-purchase-order.mjs --supplier "ИП Галямов Дмитрий Сергеевич" --execute
node scripts/recover-overflow-purchase-order.mjs --supplier "..." --update <poId> --execute
```

Turns `logs/order-recovery-overflow.json` into a single MoySklad Purchase Order
(Заказ поставщику) for the chosen supplier counterparty. Aggregates demand per
product and uses each product's `buyPrice`. The order **description** carries a
per-article buyer breakdown (`<code> <name> ×<qty>: <buyer1>, <buyer2>`) so the
operator can see who each ordered unit is for — purchaseorder positions have no
per-line text field, so the description is the place for it. `--update <poId>`
patches that description on an existing PO (PUT, no duplicate) instead of
creating a new order. Companion to `recover-orders-from-logs`.

## analyze-broadcast-logs

```bash
node scripts/analyze-broadcast-logs.mjs path/to/bundle --date 2026-08-01
node scripts/analyze-broadcast-logs.mjs path/to/sessions/2026-08-01_*.jsonl   # тоже работает
```

Read-only health analyzer for one эфир. **Prefer the bundle + `--date` form**:
it picks up every session file of that day (one эфир spans several — each
reconnect starts a new one), reads `server.log*` for the checks that exist only
there, and reads `wishlist/events.jsonl` for overflow buyers.

Prints, with named red flags at the end: bundle orientation (sessions, safe-mode
toggles, truncation), MoySklad call health (ok/err per verb, httpStatus
breakdown, retries, slowest calls), reservation statuses **deduplicated the way
`bundle-index.js` does it** (`reservation_finalized` is append-only), the
`safe_mode_logged` / `order_failed` / `stale_discarded` trio, cancellations and
`reservation_no_open_lot` from `server.log`, order structure, pricing
(`effectivePrice` arithmetic, late `lot_price_changed`, discount outcomes),
waitlist, wishlist and stock-unknown lots. Since 0.1.78 it also reports buyer
cancellations (`reservation_cancelled_by_comment` by path, and the
`cancel_comment_not_executed` reasons the app declined) and the discount
backfill — a late discount is flagged only when no successful
`position_pricing_backfilled` followed it, while a late **price** is always
flagged because prices are still not backfilled. `--json` for a machine-readable
dump; exit code 1 when any red flag fires. Writes nothing.

Parsing lives in `scripts/lib/broadcast-log.mjs`, shared with
`verify-broadcast-against-moysklad` so the two cannot disagree about what a live
бронь is. Drives [[log-verification-checklist]].

## verify-broadcast-against-moysklad

```bash
node scripts/verify-broadcast-against-moysklad.mjs path/to/bundle --date 2026-08-01
```

GET-only diff between the log bundle and MoySklad — §8 of
[[log-verification-checklist]], the part `analyze-broadcast-logs` structurally
cannot do. For every live бронь it checks the order and position exist, the
quantity is not short and the net price matches; positions store a **base price
plus a discount percent**, so it compares `price × (1 − discount/100)`, not
`price`. Cancelled броней must be gone; `stale_discarded` ones must be present.
It also lists orders carrying the `#Эфир <date>` marker that the logs never
mention, and buyers with more than one order in the campaign window (`--gap`,
default 3 days).

Direction matters: **dearer** than the log is an error (the buyer is charged
more than announced), **cheaper** on an order whose `updated` postdates the эфир
is a post-broadcast operator edit and is reported as a warning. `--limit N` for a
smoke test. Needs `MOYSKLAD_LOGIN`/`MOYSKLAD_PASSWORD`; issues no writes.

## fix-zero-price-positions

```bash
node scripts/fix-zero-price-positions.mjs            # dry-run (read-only)
node scripts/fix-zero-price-positions.mjs --execute  # PUT corrected prices
```

Patches customer-order positions that were written to MoySklad with price 0
because the operator voiced the price/discount but it never reached the order
(spoken before `lot_opened`, or after the бронь was finalized, or a discount %
with no base price). The `FIXES` list (orderId/positionId + reconstructed buyer
price) is edited per эфир from the transcript; prices that cannot be
reconstructed are skipped. Dry-run reads each position and guards on current
price 0 before writing. See [[log-verification-checklist]] §4.

## merge-broadcast-orders

```bash
node scripts/merge-broadcast-orders.mjs --into 2026-06-27 --from 2026-06-28
node scripts/merge-broadcast-orders.mjs --into 2026-06-27 --from 2026-06-28 --execute
```

Folds each buyer's `--from`-date эфир order into their `--into`-date order
(survivor), preserving quantity/price/discount/reserve, tags the survivor with
the `--from` `#Эфир` marker, and deletes the emptied order (→ MoySklad recycle
bin, recoverable). Needed because order merging is **date-scoped**: the live flow
(`ws-server.js` → `findBroadcastCustomerOrderForCounterparty` →
`moysklad.js findLatestBroadcastCustomerOrder`) only reuses an order with the
**current** `#Эфир <local-date>` marker, and `broadcastDate` is the *local*
calendar date of each comment — so a buyer who reserved across two эфир dates (or
one эфир that crossed local midnight) ends up with two orders. The day-agnostic
lookup (`findLatestOpenCustomerOrder`) exists but the live flow does not call it.
Dry-run by default. See [[log-verification-checklist]] and [[reservation-flow]].

## Related pages

- [[order-recovery-from-logs]]
- [[log-verification-checklist]]

- [[moysklad-integration]]
- [[reservation-flow]]
- [[logging-and-diagnostics]]
- [[operational-commands]]
