# VK comments

VK comments are both the buyer command channel and the publication channel for
lot cards, price updates, reservation replies, and wishlist activity.

## Current knowledge

- Public comments can become noisy when every reservation and wishlist action
  posts a reply.
- Operator feedback prefers private or less noisy wishlist confirmations.
- Lot-card comments should include price immediately when the operator speaks
  code and price together.
- Comments from the own VK group must be ignored for reservation matching.
- Reservation intent is parsed by `server/reservation-parser.js`; the accepted
  vocabulary now extends well beyond `бронь <код>` (bare codes, `+<код>`,
  `беру/возьму/хочу/держи/+`, short `бр/брн/брнь`). See
  [[reservation-flow#Accepted comment formats]].
- Service `order_failed` reply now shows the buyer concrete formats
  (`"03204"`, `"бр 03204"`, `"беру 03204"`, `"+03204"`) instead of only
  `"Бронь"`.
- `out_of_stock` reservation overflow is silent in public VK comments. The
  server still adds the buyer to [[wishlist]] via
  `out_of_stock_reservation`, but `getReservationReplyMessage` returns an
  empty string for that status so the operator can run W6 manual follow-up
  without public comment noise.

## Runtime files

- `server/vk.js`
- `server/ws-server.js`
- `web-ui/app.js`

## Related pages

- [[operator-feedback]]
- [[wishlist]]
- [[reservation-flow]]
- [[vk-integration]]
- [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]]
