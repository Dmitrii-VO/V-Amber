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
node scripts/analyze-broadcast-logs.mjs path/to/sessions/2026-06-28_*.jsonl
```

Read-only health analyzer for one эфир's session jsonl files. Prints MoySklad
call health (ok/err per verb), reservation status breakdown, reconciliation
(comments/detected/positions/orders), order-structure integrity (one buyer per
order, no duplicate product lines, `product_not_found`), pricing red flags
(positions written at price 0, `discount_skipped` reasons), and
waitlist/wishlist coverage. Drives [[log-verification-checklist]]. Writes
nothing.

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
