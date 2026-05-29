# Reservation digests

Reservation digests summarize a client's open live-commerce reservations for a
given date and can be sent through VK direct messages.

## Backend flow

`server/http-server.js` exposes:

- `GET /api/reservation-digests/preview`;
- `POST /api/reservation-digests/send`.

Preview calls `moysklad.getReservationDigestForDate(date)` and enriches clients
with send state from `server/reservation-digest-log.js`.

Send filters selected `viewerIds`, skips missing VK IDs, already sent digests,
clients that cannot be sent, and safe mode. For sendable clients, it checks VK
DM permission, sends the message through `vk.sendDirectMessage`, and records
the digest send key.

## Statuses

Possible result statuses include:

- `sent`
- `already_sent`
- `missing_vk_id`
- `dm_not_allowed`
- `safe_mode_blocked`
- `failed`

## UI

`web-ui/app.js` has a reservation digest modal with date picker, preview list,
client selection, send button, and result status rendering.

## Related pages

- [[http-api]]
- [[web-dashboard]]
- [[vk-integration]]
- [[moysklad-integration]]
- [[logging-and-diagnostics]]
