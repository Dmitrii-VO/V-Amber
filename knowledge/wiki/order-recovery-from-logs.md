# Order recovery from эфир logs

How to reconstruct MoySklad customer orders (and a supplier purchase order)
from a broadcast's session logs **after the fact** — used when MoySklad auth
failed during the live эфир and no orders were created at the time.

First done: **2026-06-28**, recovering the two 2026-06-27 эфиры. See
[[service-scripts]] for the script reference and [[reservation-flow]] /
[[moysklad-integration]] for the live flow this replays.

## When you need this

Symptom: an эфир ran, brони were spoken/commented, but **no customer orders
exist in MoySklad**. In the diagnostic bundle the session shows many
`reservation_finalized` events all with `status: "product_not_found"`,
`reason: "product_missing"`, `productId/orderId/positionId: null`, and the
session context has `productCache.lastError: "MoySklad HTTP 401"` with every
`moysklad_call` returning `httpStatus: 401`.

**Root cause is an expired/invalid MoySklad token**, not a parsing bug. The
брони were recognized fine; they just could not be written. Fix the token in
`.env` (`MOYSKLAD_LOGIN`/`MOYSKLAD_PASSWORD`) first, then recover.

## What the logs do and don't contain

A `reservation_finalized` event carries everything needed to rebuild the order
intent: `code` (артикул), `viewerId` + `viewerName`, `quantity`, `commentId`,
`commentCreatedAt`, `lotSessionId`. It does **not** contain the product link,
the counterparty link, or a real price (all `0`/`null` because resolution
failed). Those two joins are re-done against live MoySklad at recovery time:

- **article → product**: `getProductCardByCode(code)` (exact `code=` filter).
  Spoken codes sometimes drop the leading zero (`3412` vs `03412`) — the script
  retries with `0`-prefix / `padStart(5,"0")`.
- **viewer → counterparty**: `ensureCounterparty({viewerId, viewerName})`,
  matched primarily by the VK ID attribute (deterministic), then by name, then
  by `viewerId=` in the description; creates a `VK: <name>` counterparty if
  none exists.

## Procedure

1. Get working MoySklad creds into `.env`. Confirm with a read: a `GET
   entity/product?limit=1` should return `200` (the script exits if the client
   is not enabled).
2. Extract the session jsonl files for the эфир from the bundle (the big
   `sessions/*.jsonl`; the per-session `.md` is a human-readable summary).
3. Dry-run (read-only — GET products + read-only counterparty match):

   ```bash
   node scripts/recover-orders-from-logs.mjs --sessions s1.jsonl,s2.jsonl --date 2026-06-27
   ```

   Review `logs/order-recovery-result.json`: how many codes resolved, how many
   counterparties already exist vs. will be created, and the overflow list.
4. Execute (creates customer orders):

   ```bash
   node scripts/recover-orders-from-logs.mjs --sessions s1.jsonl,s2.jsonl --date 2026-06-27 --execute
   ```
5. Create the supplier purchase order for what didn't fit stock:

   ```bash
   node scripts/recover-overflow-purchase-order.mjs --supplier "ИП Галямов Дмитрий Сергеевич" --execute
   ```
6. Verify against MoySklad ground truth: list customer orders whose description
   contains `#Эфир <date>`, expand `positions.assortment`, and confirm
   `positions == reservations − overflow` with no duplicate
   `(counterparty, product)` pairs.

## Stock / overbooking policy

Multiple buyers often reserve the same lot. Operator decision (2026-06-27 run):
**first-come up to current `availableStock`; the rest are overflow** → a
supplier purchase order, *not* extra customer orders. This mirrors what the
live system would have done (overflow → wishlist/out-of-stock) and avoids
negative stock. The alternative (an order for every бронь, possibly negative
stock) is available by changing the allocation cap.

## Gotchas (each cost time at least once)

- **`stock` vs `availableStock`.** Allocate against `availableStock`
  (`= quantity` from `report/stock/all`, which respects the store filter that
  excludes "Брак"). Do **not** re-derive the cap from the physical `stock`
  field or from `report/stock/all` without the store filter — those gave a
  different (wrong, ~65 vs 76) allocation. Reservations raise `reserve` and
  lower `availableStock`, so a naive re-run re-allocates against depleted
  numbers — rely on idempotency, not on the second run's allocation count.
- **Idempotency.** Orders are grouped per buyer under the `#Эфир <date>`
  marker; before appending, the script checks `hasPositionForProduct`. A
  re-run after a partial/rate-limited run fills only the gaps. Trust the
  end-state verify, not per-run counters.
- **Rate limits.** MoySklad returns HTTP 429 under burst; the client retries
  with backoff, but a handful can still fail a run — just re-run (idempotent).
- **The local wishlist is a dead end here.** `logs/wishlist.jsonl` is local to
  whatever machine runs the code; this repo (Windows) is **not** the operator's
  production Mac, so writing wishlist entries here is invisible to the operator.
  MoySklad, by contrast, is the shared cloud — orders/PO created from any
  machine with valid creds are real. So overflow goes to a **purchase order**
  (or an operator report), never the local wishlist.
- **cp1251 is not an issue for these session jsonl** — they read as clean UTF-8
  (`Наталья Сегова`). The cp1251 caveat applies to older bundle formats, not
  the per-session jsonl read with `fs.readFileSync(f, "utf8")`.
- **Lost эфир pricing.** Customer-order prices come from the current product
  card (`salePrice`); any discounts announced on air are gone (the брони logged
  `salePrice: 0`). Purchase-order prices use `buyPrice`, which may be `0` if not
  set on the product — fill manually.

## Related pages

- [[service-scripts]] — script reference (`recover-orders-from-logs`,
  `recover-overflow-purchase-order`).
- [[reservation-flow]] — the live флоу this replays.
- [[moysklad-integration]] — product/counterparty/order/PO client.
- [[logging-and-diagnostics]] — session jsonl and diagnostic bundle format.
