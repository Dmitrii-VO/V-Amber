# Log verification checklist (проверка эфира по логам)

How to verify that an эфир (livestream broadcast) worked correctly using only the
diagnostic log bundle, **before** trusting that MoySklad got the right orders.
Built after the 2026-06-27 incident (MoySklad auth died mid-эфир → 0 orders, see
[[order-recovery-from-logs]]) and the 2026-06-28 review (orders fine, but 5
positions written at price 0 because voiced prices were dropped).

Run the read-only analyzer first, then walk the sections below for anything it
flags. The analyzer prints every metric named here:

```bash
node scripts/analyze-broadcast-logs.mjs path/to/sessions/<эфир-date>_*.jsonl
```

It never writes to logs or MoySklad. See [[service-scripts]].

---

## 0. Orient the bundle

- [ ] **`meta.json`** — note `vamberVersion`, `platform` (operator runs **darwin/Mac**,
  not this repo), and `integrationsEnabled` (`moysklad`, `vk`, `speechkit` all
  `true`?). If `moysklad:false`, no orders could have been written at all.
- [ ] **`envFlagsPresent`** — `MOYSKLAD_LOGIN`/`PASSWORD` present? Missing creds =
  expect auth failures downstream.
- [ ] **Truncation** — in `meta.json` `files[]`, is any session `truncated:true`?
  Truncated jsonl means counts below are a floor, not exact.
- [ ] **Pick the right sessions** — only the jsonl files dated to *this* эфир. A
  bundle carries weeks of history; mixing dates corrupts every reconciliation.

## 1. MoySklad call health — the make-or-break check

- [ ] **Zero `moysklad_call` errors.** GET/POST/DELETE should all be `ok`. This is
  the single check that would have caught the 2026-06-27 disaster instantly.
- [ ] **No `401`/`403`** anywhere → auth/token is alive. A wall of `401` means the
  token expired and **no orders were created** despite valid брони → recovery
  needed ([[order-recovery-from-logs]]).
- [ ] **No sustained `429`** → not rate-limited into dropping work. Occasional 429
  with retry is fine; bursts that exhaust retries are not.
- [ ] **No `5xx`** → MoySklad side was up.
- [ ] POST count roughly tracks orders created + positions appended + cancellations.

## 2. Reservation outcomes & reconciliation

- [ ] **`vk_comment` == `reservation_detected`** — every buyer comment became a
  detected reservation. A gap means the parser dropped commands.
- [ ] **Status breakdown sums up.** `reservation_finalized` statuses:
  `reserved` (new order) + `reserved_appended` (added position) = live positions;
  plus `cancelled`, `out_of_stock`, `waitlist_pending`.
- [ ] **live positions == `customer_order_created` events** (reserved+appended).
- [ ] **`cancelled` == `customer_order_cancelled` == `DELETE` calls** — every
  cancellation actually removed something in MoySklad.

## 3. Order structure integrity

- [ ] **One buyer per order.** No order should map to >1 distinct `viewerId`
  (grouping is per-buyer per-broadcast under the `#Эфир <date>` marker). >1 = a
  grouping/counterparty-collision bug.
- [ ] **No duplicate product within one order.** A repeat бронь of the same артикул
  by the same buyer must *append quantity*, not create a second identical line.
- [ ] **`product_not_found` == 0.** Every артикул resolved to a MoySklad product.
  Non-zero → check leading-zero padding (`3172` vs `03172`) and catalog gaps.
- [ ] (When in doubt) cross-check against MoySklad ground truth: count unique
  `(counterparty, product)` pairs under the `#Эфир <date>` marker. Trust the
  end-state in MoySklad over per-run script counts — re-runs re-allocate stock.

## 4. Pricing & discounts — easy to miss, the orders still "look" created

- [ ] **No live position with `salePrice == 0`.** Price 0 means the buyer's order
  line has no price. The order was created fine; the *price* is wrong. **Always
  read the transcript around that lot** — the operator usually *did* voice a price.
- [ ] Known causes of a dropped voiced price (all seen 2026-06-28):
  - price/discount spoken **before** `lot_opened` → not attached to the lot;
  - price/discount spoken **after** the бронь was already finalized → the later
    `lot_price_changed` does **not** backfill an already-created order position;
  - a discount % voiced with **no base price** → `discount_skipped:
    trigger_matched_but_no_amount_extracted` → stays 0.
- [ ] **Review `discount_skipped` reasons.** `trigger_matched_but_no_amount_extracted`
  recurring on real lots = real lost discounts, not noise.
- [ ] To fix afterward: reconstruct the price from the transcript and patch the
  position with `scripts/fix-zero-price-positions.mjs` (read `salePrice`/
  `effectivePrice` the buyer pays, ×100 → kopecks, PUT to the position). If the
  base price was never voiced and the catalog has none, leave it for the operator.
- [ ] Related deep dives: [[voice-price-parsing]], [[voice-control-hardening-plan]].

## 5. Waitlist integrity

- [ ] **`reservation_waitlist_pending` count == `waitlist_promoted` count** — every
  queued buyer was promoted when stock freed up. Unpromoted leftovers = buyers
  stuck in limbo with no order.
- [ ] Each promotion should resolve to a later `reserved`/`reserved_appended` for
  that viewer+product (spot-check one lot).

## 6. Wishlist (out_of_stock overflow)

- [ ] **Every `out_of_stock` reservation has a matching wishlist `added` event.**
  Counts must be equal — an OOS бронь with no wishlist entry is a lost buyer.
- [ ] Check `wishlist/state.json` `active[]` entries `createdAt` == эфир date match
  the OOS list. Watch for **empty `supplierName`** (seen 2026-06-28) — a later
  Заказ поставщику will need the supplier resolved.
- [ ] **Stale data smell:** lots of old `active[]` entries (e.g. `viewerName:
  "Amber Standard"` test rows) means the wishlist is not being drained — known MVP
  gap (no TTL). See [[wishlist]].

## 7. Stock safety

- [ ] No product driven to **negative `availableStock`** by the эфир. Allocation is
  on `availableStock` (respects the "Брак" store exclusion), **not** physical
  `stock`. See [[reservation-flow]] and `scripts/find-overbooked.js`.

---

## Red-flag quick table

| Signal in logs | Means | Action |
|---|---|---|
| `moysklad_call` 401/403 wall | token dead → 0 orders | [[order-recovery-from-logs]] |
| `product_not_found` > 0 | артикул→товар join failed | leading-zero fallback / catalog |
| order with >1 `viewerId` | grouping/counterparty bug | inspect `ensureCounterparty` |
| dup product line in order | append-quantity failed | inspect `appendPositionToCustomerOrder` |
| live position `salePrice==0` | voiced price dropped | transcript + `fix-zero-price-positions.mjs` |
| `discount_skipped` on real lots | lost discount | [[voice-price-parsing]] |
| pending != promoted | buyer stuck in waitlist | inspect promotion path |
| out_of_stock != wishlist added | lost overflow buyer | inspect wishlist sink |
| negative `availableStock` | overbooked | `find-overbooked.js` |

## Related pages

- [[order-recovery-from-logs]] — what to do when section 1 fails (auth dead).
- [[service-scripts]] — `analyze-broadcast-logs`, `fix-zero-price-positions`.
- [[logging-and-diagnostics]] — bundle structure, event kinds, install ID.
- [[reservation-flow]] — reservation/waitlist/stock lifecycle.
- [[voice-price-parsing]] · [[voice-control-hardening-plan]] — pricing robustness.
