# VK comments

VK comments are both the buyer command channel and the publication channel for
lot cards, price updates, reservation replies, and wishlist activity.

## Current knowledge

- Public comments can become noisy when every reservation and wishlist action
  posts a reply.
- Operator feedback prefers private or less noisy wishlist confirmations.
- Lot-card comments should include price immediately when the operator speaks
  code and price together.
- Comments authored by the bot's own account are ignored by the poller
  (`server/ws-server.js`, filter `comment.from_id === selfUserId`). The id is
  resolved once via `vk.getSelfUserId()` (`users.get` under the user token, or
  `VK_SELF_USER_ID` env override). Without this the bot re-ingested its own
  «бронь подтверждена (код …)» reply as a fresh reservation from itself — see
  the 2026-06-03 22:33 session, account «Amber Standard» (id 816076245) booked
  every lot against itself, producing bogus `out_of_stock` and phantom wishlist
  entries (and, at stock ≥2, would have created a phantom MoySklad order).
- Published service comments do NOT include the internal `lotSessionId:` line
  (it is operator-facing noise; nothing parses it back from chat). The lot card
  also omits the price line entirely when price is 0 — the operator names the
  price by voice and `publishPriceUpdate` posts it, avoiding a «Цена: 0 ₽» card.
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

**All `video.*` methods require a user token, not a community token.**
VK rejects `video.getComments`, `video.createComment` and `video.get`
under a group/community token with `error_code 27` ("Group authorization
failed: method is unavailable with group auth"; `video.get` also returns
`error_code 5` "invalid token type"). So every video-comment path — lot
cards, lot-closed, price/discount updates, reservation replies, the
`photos.getWallUploadServer` / `photos.saveWallPhoto` uploads attached to
them, comment polling, and live-URL validation — is routed through a
`videoToken` derived as `VK_USER_TOKEN || VK_GROUP_TOKEN ||
VK_ACCESS_TOKEN`. The group/access fallbacks exist only for legacy
single-token configs. Service comments therefore appear from the
operator's user account; posting live-video comments **from the group is
not possible** through the VK API.

DM-paths (`messages.send`, `messages.isMessagesFromGroupAllowed`) still
require an explicit `VK_GROUP_TOKEN` because community DMs need
community-scoped tokens — that is the only place the group token is used.

### History / regression (2026-06)

The earlier "Stage 5" attempt (2026-05-31, commit `8a33a6d`) routed video
comments through a community-first `commentToken`
(`VK_GROUP_TOKEN || ...`) to make replies appear from the Amberry group
page. That intent is unattainable at the VK API level. Once a
`VK_GROUP_TOKEN` was added to `.env` (needed for DMs), every video.*
call started failing with `error_code 27`: comment polling died
(`comment_poll_failed`, no reservations ingested) and no lot cards
posted. The 30 May session — which had no group token, so the calls fell
back to the user token — was the last that worked (28 successful
publishes, 0 errors). The fix above restores that user-token behavior
while keeping the group token for DMs.

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
