# Preorders

Preorders are a planned workflow for out-of-stock live-commerce cases. The plan
is currently documented in `TODO.md`; it is not confirmed runtime behavior yet.

## Desired behavior

When active-lot stock is exhausted:

- the first reservation within stock remains a normal reservation;
- later `бронь` comments become preorders;
- MoySklad gets a customer order with status `Предзаказ`;
- the position uses `reserve: 0`, because stock is absent;
- UI groups preorders by supplier;
- the operator can create `entity/purchaseorder` for a supplier.

## MoySklad setup

The plan requires a customer-order status named `Предзаказ`. `TODO.md`
suggests adding its UUID to `.env` as `MOYSKLAD_PREORDER_STATE_ID`. Product
cards should have `Поставщик` filled; otherwise preorders fall into a
`Без поставщика` group.

## Planned implementation areas

- `server/config.js`
- `server/moysklad.js`
- `server/ws-server.js`
- `server/session-log.js`
- `server/http-server.js`
- `web-ui/index.html`
- `web-ui/app.js`
- `test/preorder.test.js`

## Related pages

- [[reservation-flow]]
- [[moysklad-integration]]
- [[documentation-drift]]
