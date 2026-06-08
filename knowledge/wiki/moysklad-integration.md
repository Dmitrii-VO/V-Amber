# MoySklad integration

MoySklad is used for products, stock, counterparties, customer orders,
reservations, and diagnostics.

## Runtime files

- `server/moysklad.js` is the main API client.
- `server/product-code-cache.js` caches product-code hints for article parsing.
- `server/ws-server.js` calls MoySklad during lot opening and reservation flow.
- `scripts/backfill-vk-id-dry-run.js` diagnoses VK ID fields on counterparties.

## Product lookup

The live-commerce flow uses spoken product codes to load a product card and
stock data. The product-code cache helps disambiguate spoken article codes from
sizes or prices.

`server/product-code-resolver.js` normalizes catalog-code lookups shared by
voice detection, manual code entry, and reservation-attention diagnostics. Exact
codes win first. Missing leading zeroes can resolve to a single catalog code
(`243` → `00243`), and ambiguous leading-zero matches are rejected rather than
sent to MoySklad.

## Reservation orders

For buyer reservations, the backend creates or appends customer orders and
checks active-lot stock to avoid overselling when stock is known.

Discounted reservation positions keep the original MoySklad sale price in the
position `price` field. The applied lot discount is sent through the position
`discount` percentage field, and MoySklad calculates the final line `sum`.
The integration must not pre-subtract the discount from `price`.

Live reservation orders use a daily broadcast marker in the order description,
for example `#Эфир 2026-05-24`. Cross-session merging only reuses orders for
the same counterparty and the same marker. Open MoySklad orders from earlier
days or non-broadcast orders remain separate even when their state is `Новый`.
Paid orders are not append targets: `Оплачен` and `Частично оплачен` force a
new order for later reservations, even when the marker matches.

Read calls to MoySklad (`GET`) retry transient failures: HTTP 429, 502, 503,
504, network failures, and configured request timeouts. Write calls (`POST`,
`PUT`, `DELETE`) are not retried by this generic layer, because customer-order
creation and position appends are not idempotent without a MoySklad-side key.
Diagnostic `moysklad_call` events include total attempts for retried reads.

## Safe mode

Safe mode blocks MoySklad write actions but keeps detection and logs active.
This supports dry-run sessions and later manual recovery.

## Related pages

- [[reservation-flow]]
- [[wishlist]]
- [[preorders]]
