# VK integration

VK API is used for live video comments, lot-card publication, reservation
replies, discount notifications, and lot close messages.

## Runtime files

- `server/vk.js` owns VK API calls, URL validation, comment polling, and
  throttling/backoff.
- `server/ws-server.js` coordinates VK events with active lots and reservation
  state.
- `web-ui/app.js` lets the operator provide or persist a VK live video URL.

## Operational notes

The VK client includes rate-limit protection for `VK API 6`. The live video URL
must be valid and must not parse to zero IDs.

## Reservation comments

Buyer comments such as `бронь` are processed against the current active lot.
Own-group service comments must not be treated as buyer reservations. See
[[operator-feedback]].

## Related pages

- [[reservation-flow]]
- [[live-commerce-flow]]
- [[configuration-and-secrets]]
