# Stock synchronization

Stock synchronization keeps visible available stock aligned with MoySklad after
reservations and lot changes.

## Current knowledge

- Operator feedback from 2026-05-24 says visible stock did not change after a
  reservation.
- Unknown stock, represented as `availableStock=null`, can weaken duplicate and
  oversell protection.
- The UI and active reservation state need refresh after MoySklad order
  position creation.

## Runtime files

- `server/ws-server.js`
- `server/moysklad.js`
- `web-ui/app.js`

## Related pages

- [[operator-feedback]]
- [[reservation-flow]]
- [[moysklad-integration]]
- [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]]
