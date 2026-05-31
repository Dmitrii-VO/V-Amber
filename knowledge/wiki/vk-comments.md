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
- `reserved` and `reserved_appended` replies now embed the lot code,
  e.g. «Аня, бронь подтверждена (код 03204).» When several lots are
  open simultaneously this avoids ambiguity over which article the
  service reply confirms. The code is passed in from the call site
  (`notifyReservationStatus`) via `getReservationReplyMessage(event,
  { code })`.

## VK identity for service comments

Stage 5 (chosen 2026-05-31): all `video.createComment` writes for lot
cards, lot-closed, price/discount updates, and reservation replies, as
well as `photos.getWallUploadServer` / `photos.saveWallPhoto` uploads,
are routed through a `commentToken` derived as
`VK_GROUP_TOKEN || VK_ACCESS_TOKEN || VK_USER_TOKEN`. The first two are
community access tokens — when either is present, replies appear from
the official Amberry group page, not from the operator's user account.
`VK_USER_TOKEN` stays as a back-compat fallback for legacy single-token
setups. DM-paths (`messages.send`,
`messages.isMessagesFromGroupAllowed`) still require an explicit
`VK_GROUP_TOKEN` because community DMs need community-scoped tokens.

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
