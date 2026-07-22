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

### Queue priority and poll cadence (since 2026-06-06)

`server/vk.js` runs all VK calls through one rate-limited queue (single
`minApiIntervalMs` gate, adaptive `backoffMultiplier` up to ×8 on `VK API 6`).
Since 2026-07-05 the penalty decays gradually on success (×8 → ×4 → ×2 → ×1,
one halving per successful call) instead of resetting to ×1: the instant reset
caused rate-limit thrash during comment storms — each successful publish
restored full speed and the very next poll hit `VK API 6` again (33 warnings
in 3.5 minutes during the 2026-07-05 эфир).
The queue has **two lanes**: publishing (cards/price/replies/lot-closed/photo
upload) is high priority and preempts the low-priority `video.getComments` poll,
so a polling burst never delays a reservation reply. The comment poll cadence in
`server/ws-server.js` is adaptive — ~1.5 s active, ramping to 8 s when quiet
(was a fixed 2 s). Lot cards also degrade to text-only when a photo upload fails
or VK returns `error_code 100`. Details in [[vk-comments]].

Since 2026-06-08, the poller also stays alive for a 30-second grace window after
the last open lot closes. Comments that look like reservations during that gap
are escalated as `reservationAttention` with no automatic reservation, so the
operator can handle late or between-lot bookings manually.

## Token routing (critical)

All `video.*` methods — `video.getComments`, `video.createComment`,
`video.get` — must use a **user token**, never a community/group token. VK
rejects video methods under group auth with `error_code 27`. `server/vk.js`
derives `videoToken = VK_USER_TOKEN || VK_GROUP_TOKEN || VK_ACCESS_TOKEN` for
these calls. `VK_GROUP_TOKEN` is used only for `messages.*` (community DMs).
Service comments therefore post from the user-token account's identity, not the
community page — posting video comments "as the community" is not possible via
the VK API. Full rationale and regression history in [[vk-comments]].

## Moderation

`server/vk.js` exposes two operator-driven moderation calls, both under the
**user token** (`videoToken`), routed through the high-priority queue lane:

- `banViewer({ userId, reason, comment })` → `groups.ban`. Bans the spammer
  from the эфир's community. The эфир video is community-owned (`liveOwnerId`
  negative), so the group id is `-liveOwnerId`; guarded to reject a non-community
  эфир (`owner_id ≥ 0` → `not_community`). Works because the user-token account
  administers the community — the `VK_GROUP_TOKEN` belongs to a *different*
  community and cannot ban here. Ban is community-wide, reversible via
  `groups.unban`.
- `deleteVideoComment({ commentId })` → `video.deleteComment` on `liveOwnerId`.
  Removes the comment from the эфир.

Both return a structured `{ok, code?, vkErrorCode?}` and never throw. Rationale,
token choice, and the two-community setup are in
[[vk-comments#Real VK ban + comment deletion (2026-07-22)]]. HTTP surface:
[[http-api#Blocked viewer routes]].

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
