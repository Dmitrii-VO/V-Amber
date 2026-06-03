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

## Token routing (critical)

All `video.*` methods — `video.getComments`, `video.createComment`,
`video.get` — must use a **user token**, never a community/group token. VK
rejects video methods under group auth with `error_code 27`. `server/vk.js`
derives `videoToken = VK_USER_TOKEN || VK_GROUP_TOKEN || VK_ACCESS_TOKEN` for
these calls. `VK_GROUP_TOKEN` is used only for `messages.*` (community DMs).
Service comments therefore post from the user-token account's identity, not the
community page — posting video comments "as the community" is not possible via
the VK API. Full rationale and regression history in [[vk-comments]].

## Reservation comments

Buyer comments such as `бронь` are processed against the current active lot.
The poller ignores comments authored by the bot's own account
(`from_id === vk.getSelfUserId()`, resolved via `users.get` or `VK_SELF_USER_ID`)
so the bot never re-ingests its own confirmation replies as buyer reservations.
See [[vk-comments]] and [[operator-feedback]].

## Related pages

- [[reservation-flow]]
- [[live-commerce-flow]]
- [[configuration-and-secrets]]
