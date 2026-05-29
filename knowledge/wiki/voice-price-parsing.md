# Voice price parsing

Voice price parsing extracts sale prices from operator speech and applies them
to the active lot before publication or reservation.

## Current knowledge

- Full phrases such as `две тысячи пятьсот пятьдесят` can resolve to `2550`.
- Compact digit phrases need better handling. During the 2026-05-24 test,
  `цена два пять пять ноль` was parsed as `2 ₽`, not `2550 ₽`.
- Operator feedback asks the system to publish price together with the lot card
  when code and price are spoken in one phrase.

## Runtime files

- `server/price-detector.js`
- `server/discount-detector.js`
- `server/ws-server.js`
- `web-ui/app.js`

## Related pages

- [[operator-feedback]]
- [[live-commerce-flow]]
- [[vk-comments]]
- [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]]
