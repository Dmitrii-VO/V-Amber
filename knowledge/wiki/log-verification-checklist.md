# Log verification checklist (проверка эфира по логам)

How to verify that an эфир (livestream broadcast) worked correctly using the
diagnostic log bundle. Built after the 2026-06-27 incident (MoySklad auth died
mid-эфир → 0 orders, see [[order-recovery-from-logs]]), the 2026-06-28 review
(orders fine, but 5 positions written at price 0 because voiced prices were
dropped), and the 2026-08-02 pass over a real bundle that corrected the event
and field names below.

## What this checklist can and cannot prove

**Everything in sections 0–7 is the application's own account of what it did.**
It is read from `logs/sessions/*.jsonl` and `logs/server.log*`, and it proves
only that the app *believed* it wrote the right thing. It does not read MoySklad.

That leaves four blind spots, all of them things that have already gone wrong:

- a call that was never attempted logs **nothing** (a cancellation on a closed
  lot, §2.1) — no error to find;
- a position written with a **wrong but non-zero** price looks perfectly healthy;
- anything changed in MoySklad **after** the эфир (operator edits, manual
  cancellations, a re-run of a recovery script) is invisible;
- `stale_discarded` positions **exist in MoySklad** but are absent from every
  count in §2–§3.

Closing those requires §8, which queries MoySklad. Do not report an эфир as
"verified" on sections 0–7 alone — on 2026-08-01 they came back almost clean
while MoySklad held one бронь that no longer existed and 43 positions the
operator had re-priced afterwards.

## The analyzer

Two read-only scripts, run in this order. Neither writes anything.

```bash
node scripts/analyze-broadcast-logs.mjs path/to/bundle --date 2026-08-01
node scripts/verify-broadcast-against-moysklad.mjs path/to/bundle --date 2026-08-01
```

The first covers §0–§7 from the logs (pass the **bundle directory** plus the
date — it then picks up every session file of that эфир *and* `server.log`, and
prints named red flags). The second is §8: it GETs the orders from MoySklad and
diffs them against the logs. See [[service-scripts]].

---

## 0. Orient the bundle

- [ ] **Two sources, not one.** `sessions/*.jsonl` is the structured session
  stream; `server.log` (+ rotated `server.log.1`, …) is everything else.
  Cancellations, `reservation_no_open_lot`, the flood guard, `invalid_discount`
  and safe-mode toggles exist **only in `server.log`** — the analyzer reads
  jsonl and never sees them. Grep both files: a long эфир straddles the rotation.
- [ ] **One эфир = several session files.** Every reconnect/restart opens a new
  jsonl (`2026-07-26` has three, `2026-08-01` two in the same bundle). Pass *all*
  files of that date, or you verify half the broadcast. Check `session_ended`
  `reason` on each — an abrupt end is itself a finding. The **newest** session
  usually has no `session_ended` at all and that is normal: the operator
  downloads the bundle while the эфир is still running (compare the last event
  against `meta.generatedAt` before calling it a crash).
- [ ] **`meta.json`** — note `vamberVersion`, `platform` (operator runs
  **darwin/Mac**, not this repo), and `integrationsEnabled` (`moysklad`, `vk`,
  `speechkit` all `true`?). If `moysklad:false`, no orders could have been
  written at all.
- [ ] **`envFlagsPresent`** — `MOYSKLAD_LOGIN`/`PASSWORD` present? Missing creds =
  expect auth failures downstream.
- [ ] **Truncation** — in `meta.json` `files[]`, is any session `truncated:true`?
  Truncated jsonl means counts below are a floor, not exact.
- [ ] **Safe mode, first thing.** Any `safemode_toggled` (jsonl) or
  `safe_mode_changed` / `safe_mode_request` (server.log) inside the эфир window
  means part of the broadcast wrote **nothing** to MoySklad and only logged. Find
  the window before reconciling anything — see the `safe_mode_logged` status in §2.
- [ ] **`INDEX.md`** already summarises broneй, MoySklad errors, `order_failed`
  incidents and slow calls. Read it before grepping by hand.

## 1. MoySklad call health — the make-or-break check

`moysklad_call` fields are `op`, `method`, `path`, `ok`, `httpStatus`,
`errorMessage`, `attempts`, `durationMs` (there is no `status`/`error` field).

- [ ] **Zero `ok:false`.** This is the single check that would have caught the
  2026-06-27 disaster instantly.
- [ ] **No `httpStatus` 401/403** anywhere → auth/token is alive. A wall of `401`
  means the token expired and **no orders were created** despite valid брони →
  recovery needed ([[order-recovery-from-logs]]).
- [ ] **No sustained `429`** → not rate-limited into dropping work. Occasional 429
  with retry is fine; bursts that exhaust retries are not.
- [ ] **No `5xx`** → MoySklad side was up.
- [ ] **`attempts > 1`** — succeeded, but only on retry. Not an error, and easy to
  miss; a rising count is the early warning that precedes the wall of failures.
- [ ] **Slow calls** (`durationMs` outliers) — `bundle-index.js` already lists
  suspicious ones in `INDEX.md`. A slow POST near a `stale_discarded` (§2) is
  usually the cause.
- [ ] **Coverage caveat:** `moysklad_call` is written to the session jsonl only
  while a session is active. Calls outside a session land as
  `moysklad_call_unrouted` — a clean jsonl does not mean a clean account.
- [ ] POST count roughly tracks orders created + positions appended + cancellations.

## 2. Reservation outcomes & reconciliation

### 2.0 `reservation_finalized` is append-only — count it correctly

A single бронь is finalized **more than once**: it is re-finalized as `cancelled`
when the operator cancels it (the event carries `previousStatus`). Counting raw
events therefore double-counts cancelled броней as live.

- [ ] **Deduplicate by the stable key before counting anything**:
  `lotSessionId` + `commentId` + `viewerId` + `positionId`, keep the **latest**
  status per key. This is exactly what `reservationKey()` in
  `server/bundle-index.js` does for "Броней принято"; any hand-rolled count must
  match it or it will disagree with `INDEX.md`.
- [ ] **Ignore `reservation_accepted`.** Legacy name, early comment detection
  only — never proof that MoySklad accepted anything.

### 2.1 Status breakdown — all seven, not just the happy two

| status | means | what to do |
|---|---|---|
| `reserved` | new order created | live position |
| `reserved_appended` | position added to existing order | live position |
| `cancelled` | бронь removed | must have a matching DELETE in §1 |
| `waitlist_pending` | queued for stock | §5 |
| `out_of_stock` | overflow | §6 |
| `product_not_found` | артикул→товар join failed | §3 — **nothing was reserved** |
| `safe_mode_logged` | safe mode was on — **nothing written to MoySklad** | replay/recreate by hand |
| `order_failed` | POST failed; demand migrated to wishlist (`trigger:"order_failed"`) | buyer has no order |
| `stale_discarded` | **the MoySklad write DID succeed**, the app discarded the result because the session moved on | position is real in MoySklad but missing from every count below |

- [ ] Every status above accounted for; `safe_mode_logged`, `order_failed` and
  `stale_discarded` each == 0, or explained.
- [ ] **`stale_discarded` is the nastiest of the three** — it inflates nothing and
  breaks nothing locally, while a real position sits in MoySklad that the operator
  never saw on the dashboard. Add these to the §8 diff manually.

### 2.2 Cross-event reconciliation

- [ ] **`reservation_detected` ≤ `vk_comment`, and the gap is normal.** Most
  comments are chatter; the old "these two must be equal" rule was wrong. What
  matters is the *shape*: a gap that suddenly widens usually means a giveaway
  burst or a closed lot, and pairs with `reservation_no_open_lot` in `server.log`.
- [ ] **live (deduped `reserved` + `reserved_appended`) == `customer_order_created`.**
- [ ] **`cancelled` == `customer_order_cancelled` == DELETE calls** — every
  cancellation actually removed something in MoySklad. Also check
  `reservation_cancel_failed` (server.log): the attempt was made and failed.
- [ ] **Flood guard hides comments.** Since v0.1.70 bursts of code-without-lot
  comments are rate-limited: past 8 events per 60s only
  `reservation_no_open_lot_flood` / `..._flood_ended` are written, the latter
  carrying `suppressed` and the first 50 samples. Add `suppressed` to any count of
  missed броней — the individual lines are gone. See [[logging-and-diagnostics]].

### 2.3 Отмены по закрытым лотам (buyer backs out after the lot is closed)

Cancellation only works while the lot is **open**: `cancelReservation` in
`ws-server.js` resolves the lot from `openLotsBySessionId` / `getOpenLots()` /
`activeLot` and otherwise answers "Нет активного лота для отмены брони" without
ever calling MoySklad. So two very common cases are **not** executed by the app
and are done by the operator by hand:

1. **same эфир, closed lot** — the buyer backs out an hour later, the lot is
   already closed;
2. **an earlier day of the same campaign** — reserved on day 1, cancels in the
   comments of the day-3 эфир. Эфиры run several days in a row and that run is
   **one campaign**; a бронь from a *previous* campaign (last week) is out of
   scope — its order is normally closed/paid by then and must not be touched.
   The campaign window is the one used for appending positions:
   `campaignMaxGapDays` (default 3) from the newest `#Эфир <date>` marker in the
   order description, see `findLatestBroadcastCustomerOrder` in `moysklad.js`.

Nothing in §2.2 catches either one: the counts of the current эфир reconcile
perfectly while a stale reserve keeps sitting on the stock.

**Reservations on a closed lot are fixed; cancellations are not.** The operator
can now book such a comment from the attention banner («✓ забронировать», see
[[reservation-flow]]). Cancelling a бронь whose lot is closed still has no path
in the app — that is what the checks below are for.

> All events in this subsection live in **`server.log`**, not the session jsonl,
> and the analyzer does not report any of them.

- [ ] **List cancel attempts that matched no open lot.** `voice_cancel_command`
  followed by neither `reservation_cancelled` nor `reservation_cancel_no_position`
  = the lot was already closed and the отмена silently did nothing. Each one is a
  position to verify in MoySklad manually.
- [ ] **Scan buyer comments for отмена/отказ against lot state.** For each cancel
  intent, find the артикул's `lot_opened` in this session: if there is none, the
  бронь is from an earlier broadcast; if there is one but it is followed by
  `lot_closed` before the comment, it is the closed-lot case. Both were ignored.
- [ ] **Cross-check the `#Эфир <date>` orders of this campaign only** — today's
  эфир plus the previous days within `campaignMaxGapDays`. For the viewers found
  above the position should be gone; if it is still there, the бронь is live and
  the stock is wrongly reserved. Orders from an **earlier campaign** are not a
  finding: they are closed and stay as they are.
- [ ] **Stock impact.** Every un-executed cross-day cancellation keeps
  `availableStock` lower than reality — expect it to show up as "missing" stock
  in §7 rather than as an error.
- [ ] **Un-booked comments are no longer a silent loss.** Reservation-like
  comments with no open lot land in the attention banner with a working
  «✓ забронировать» — so a `reservation_no_open_lot` with no following
  `attention_reservation_created` means the operator did not act on the row (or
  the code is not in the catalog, which gets no button). With the flood guard in
  play, count `suppressed` too. Check those against MoySklad.
- [ ] Product gap, still open: **cancelling** a бронь on a closed lot — in this
  эфир or an earlier day of the campaign — is not implemented (confirmed with the
  operator 2026-07-26), so every such отмена is manual work in MoySklad.

## 3. Order structure integrity

- [ ] **One buyer per order.** No order should map to >1 distinct `viewerId`
  (grouping is per-buyer per-broadcast under the `#Эфир <date>` marker). >1 = a
  grouping/counterparty-collision bug.
- [ ] **No duplicate product within one order.** A repeat бронь of the same артикул
  by the same buyer must *append quantity*, not create a second identical line —
  cross-check `reservation_quantity_appended`.
- [ ] **`product_not_found` == 0.** Every артикул resolved to a MoySklad product.
  Non-zero → check leading-zero padding (`3172` vs `03172`) and catalog gaps.
  **Treat a non-zero count as lost sales, not noise**: these buyers got nothing.
- [ ] **`manual_code_submitted`** — codes the operator typed in by hand. Each one
  should be followed by a `lot_opened`; a submit that opened no lot is a код the
  system rejected while the operator thought the lot was live.
- [ ] (When in doubt) cross-check against MoySklad ground truth — §8.

## 4. Pricing & discounts — easy to miss, the orders still "look" created

- [ ] **No live position with `salePrice == 0`.** Price 0 means the buyer's order
  line has no price. The order was created fine; the *price* is wrong. **Always
  read the transcript around that lot** — the operator usually *did* voice a price.
- [ ] **Check the arithmetic, not just the zero.** `reservation_finalized` carries
  `salePrice`, `discountAmount` and `effectivePrice`; verify
  `effectivePrice == max(0, salePrice - discountAmount)` on every live position.
  This is the only check that catches a **wrong but non-zero** price, which
  nothing else in this document sees.
- [ ] **`discount_applied` vs `discount_skipped` vs `invalid_discount`.** Every
  lot that got a voiced discount should show `discount_applied` and a matching
  `discountAmount` on its броней. `invalid_discount` (server.log) means the
  amount parsed to something nonsensical and was thrown away.
- [ ] Known causes of a dropped voiced price (all seen 2026-06-28):
  - price/discount spoken **before** `lot_opened` → not attached to the lot;
  - price/discount spoken **after** the бронь was already finalized → the later
    `lot_price_changed` does **not** backfill an already-created order position;
  - a discount % voiced with **no base price** → `discount_skipped:
    trigger_matched_but_no_amount_extracted` → stays 0.
- [ ] **Flag every `lot_price_changed` that is later than a `reservation_finalized`
  of the same `lotSessionId`.** Those положения kept the old price by design — the
  operator's correction never reached MoySklad. Not necessarily an error (the
  correction may have been for the *next* buyer), but each one needs a look.
- [ ] **Review `discount_skipped` reasons.** `trigger_matched_but_no_amount_extracted`
  recurring on real lots = real lost discounts, not noise.
- [ ] To fix afterward: reconstruct the price from the transcript and patch the
  position with `scripts/fix-zero-price-positions.mjs` (default dry-run; reads
  `salePrice`/`effectivePrice` the buyer pays, ×100 → kopecks, PUT to the
  position). If the base price was never voiced and the catalog has none, leave it
  for the operator.
- [ ] Related deep dives: [[voice-price-parsing]], [[voice-control-hardening-plan]].

## 5. Waitlist integrity

- [ ] **`reservation_waitlist_pending` count == `waitlist_promoted` count** — every
  queued buyer was promoted when stock freed up. Unpromoted leftovers = buyers
  stuck in limbo with no order.
- [ ] Each promotion should resolve to a later `reserved`/`reserved_appended` for
  that viewer+product (spot-check one lot).
- [ ] **`orphan_waitlist`** — a queue with no lot behind it. Rare (1 event in the
  2026-08-01 bundle) and never benign; trace what happened to those buyers.
- [ ] **`alreadyGone` / `quantityReleased`** on `reservation_finalized` — stock
  vanished between queueing and promotion. Expect a wishlist entry (§6), not an
  order.

## 6. Wishlist (out_of_stock overflow)

- [ ] **Count `added` from `wishlist/events.jsonl`, not from the session jsonl.**
  The session stream carries only a stray subset (1 of 4 on 2026-08-01), so
  counting there invents missing buyers. Filter the wishlist events to the эфир
  window. `INDEX.md` calls the same event `wishlist_added`, and
  `reservation_out_of_stock` exists as its own kind alongside the `out_of_stock`
  finalization status — do not count both.
- [ ] **Every `out_of_stock` reservation has a matching wishlist `added` event.**
  Counts must be equal — an OOS бронь with no wishlist entry is a lost buyer.
- [ ] **`added` with `trigger:"order_failed"`** — these are not overflow buyers,
  they are §2 failures that were parked in the wishlist. `INDEX.md` lists them as
  incidents. Every one is a buyer who wanted an in-stock item and got nothing.
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
- [ ] `find-overbooked.js` checks whole-account state, not just this эфир — cross
  reference its output against this session's `lot_opened` codes before
  blaming the broadcast for pre-existing drift.
- [ ] **`lot_opened.availableStock: null` is the leading indicator**, confirmed
  2026-07-05: every lot opened with unknown stock (`null`) that got a
  reservation ended up overbooked by exactly the reserved quantity; every lot
  opened with a real number did not. See [[stock-synchronization]].
- [ ] **`stockUnknown: true` on `reservation_finalized`** is the same signal one
  step later and per-бронь — it names the exact positions at risk, so prefer it
  when building the overbooking list.

## 8. MoySklad ground truth — the part the logs cannot do

Nothing above proves a single order exists. Run this for any эфир that matters,
and always after a §1, §2 or §4 finding:

```bash
node scripts/verify-broadcast-against-moysklad.mjs path/to/bundle --date 2026-08-01
```

GET-only. What it checks, and what you still do by hand:

- [ ] **Every live бронь → order + position exist**, quantity is not short, and
  the money matches. Missing position = the бронь is in the log and nowhere else.
- [ ] **Price, computed the MoySklad way.** A position stores the **base price
  plus a discount percent** (`buildCustomerOrderPosition` in `moysklad.js`), so
  what the buyer pays is `price × (1 − discount/100)`. Comparing `price` alone
  reports every discounted position as broken. The script compares the net.
- [ ] **Направление расхождения решает всё.** Dearer than the log = defect, the
  buyer is charged more than they were told. Cheaper, on an order whose `updated`
  is later than the last log event = a **post-эфир manual edit** (the operator
  applying a blanket discount, for instance) — expected, and invisible to §0–§7.
  The script grades these `⚠`, not `✗`.
- [ ] **`effectivePrice` in the log is a snapshot at finalize time.** A discount
  voiced after the бронь does *not* rewrite the logged бронь — so a whole эфир
  can диff cleanly against MoySklad and still show "wrong" prices in the log.
- [ ] **Cancellations really removed.** Every `cancelled` бронь → position gone.
  Every un-executed отмена from §2.3 → position still there, remove it by hand.
- [ ] **`stale_discarded` positions** — expected to exist in MoySklad even though
  the dashboard never showed them.
- [ ] **Orders with the `#Эфир <date>` marker that the logs never mention** — a
  recovery-script re-run or a manual operator order.
- [ ] **>1 order per buyer in the campaign window** — the merge should have made
  it one.
- [ ] Still manual: **order state**. A заказ the operator has already проведено or
  paid must not be touched by any fix script — the guardrail behind
  `campaignMaxGapDays`.
- [ ] Other MoySklad-aware tools: `find-overbooked.js`,
  `fix-zero-price-positions.mjs` (dry-run by default), `merge-broadcast-orders.mjs`
  (dry-run by default), `recover-orders-from-logs.mjs`.

## 9. Limits of the tooling

Both scripts share `scripts/lib/broadcast-log.mjs`, so they cannot disagree
about what a live бронь is. What they still do not tell you:

- **Nothing outside the campaign window.** A бронь from an earlier campaign that
  should have been cancelled is out of scope by design (§2.3).
- **Cancel matching is by count, not by pairing.** `analyze` reports
  `voice_cancel_command` minus results; which specific отмена fell through, you
  find by reading `server.log` around the timestamp.
- **Comment intent is not parsed.** A buyer writing «отменяю» in free text
  without triggering the voice/command path leaves no event at all.
- **Post-эфир edits are detected, not explained** — the diff shows a value
  changed and that the order was touched later; whether that edit was correct is
  the operator's call.
- **Transcript is not read.** Every "the price was probably voiced" judgement in
  §4 is still a human reading `sessions/*.md` around the lot.

---

## Red-flag quick table

| Signal in logs | Means | Action |
|---|---|---|
| `moysklad_call` `ok:false`, 401/403 | token dead → 0 orders | [[order-recovery-from-logs]] |
| `attempts` climbing | MoySklad degrading | watch for the wall of 401/429 next |
| `safemode_toggled` mid-эфир | nothing written for that window | recreate orders by hand |
| status `safe_mode_logged` | audit-only бронь, no MoySklad record | replay from the logged payload |
| status `order_failed` | POST failed, buyer parked in wishlist | contact buyer / create by hand |
| status `stale_discarded` | order **exists** in MoySklad, app lost track | add to the §8 diff |
| `product_not_found` > 0 | артикул→товар join failed | leading-zero fallback / catalog |
| cancel command, no `reservation_cancelled` | lot already closed (this эфир or earlier day) — app can't do it | cancel the position in МойСклад by hand |
| `reservation_no_open_lot_flood_ended` | comments were suppressed | add `suppressed` to the missed count |
| order with >1 `viewerId` | grouping/counterparty bug | inspect `ensureCounterparty` |
| dup product line in order | append-quantity failed | inspect `appendPositionToCustomerOrder` |
| live position `salePrice==0` | voiced price dropped | transcript + `fix-zero-price-positions.mjs` |
| `effectivePrice != salePrice - discountAmount` | discount math wrong | §8 price diff |
| `lot_price_changed` after finalize | correction never reached the position | patch by hand |
| `discount_skipped` / `invalid_discount` on real lots | lost discount | [[voice-price-parsing]] |
| pending != promoted, `orphan_waitlist` | buyer stuck in waitlist | inspect promotion path |
| out_of_stock != wishlist added | lost overflow buyer | inspect wishlist sink |
| `stockUnknown:true` / `availableStock:null` | overbooking about to happen | `find-overbooked.js` |

## Related pages

- [[order-recovery-from-logs]] — what to do when §1 fails (auth dead).
- [[service-scripts]] — `analyze-broadcast-logs`, `fix-zero-price-positions`.
- [[logging-and-diagnostics]] — bundle structure, event kinds, flood guard, install ID.
- [[reservation-flow]] — reservation/waitlist/stock lifecycle.
- [[voice-price-parsing]] · [[voice-control-hardening-plan]] — pricing robustness.
