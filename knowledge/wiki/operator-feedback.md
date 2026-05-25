# Operator feedback

This page contains durable operator requests and observations from test
sessions. The original source note remains at root as `Пожелания оператора.md`;
this page is the maintained wiki version.

## Requests from 2026-05-24 testing

- ~~Support reservation quantity: buyer writes `бронь 00588 2 шт`, and the
  system reserves two units. Default quantity remains one.~~ Resolved
  2026-05-25: `server/reservation-parser.js` extracts `шт/x/*/пара`,
  clamps to `[1, 10]`, plumbed through ws-server reservation event and
  MoySklad customer-order positions. See
  [[reservation-flow#Accepted comment formats]].
- Make [[wishlist]] clearer for buyers by explaining the `список <код>` command.
- Avoid public comment noise for wishlist and service confirmations. Prefer VK
  direct messages when possible. See [[vk-comments]].
- Publish a VK lot card with price immediately when the operator says code and
  price in one phrase. See [[voice-price-parsing]].
- Improve short numeric price recognition. `цена два пять пять ноль` should
  produce `2550 ₽`, not `2 ₽`.
- Update visible stock immediately after a reservation adds a position to an
  order. See [[stock-synchronization]].

## Observations

- ~~Repeating an already reserved article can create a new lot and a new order
  position because the system protects against overselling with
  `availableStock`.~~ Resolved 2026-05-25: `mergeSameCodeRedetection` in
  `server/ws-server.js` keeps the same `lotSessionId` and reservations when
  the operator repeats the same code. See [[reservation-flow#Same-code
  re-detection]].
- If MoySklad stock is unknown, reservation can still pass.
- VK comments from the project's own group must be ignored by reservation
  handling so service comments are not processed as buyer actions.

## Related pages

- [[live-commerce-flow]]
- [[reservation-flow]]
- [[wishlist]]
- [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]]
