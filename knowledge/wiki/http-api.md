# HTTP API

V-Amber serves the browser UI and local operator APIs from
`server/http-server.js`.

## Core routes

| Route | Method | Behavior |
|---|---|---|
| `/` | `GET` | Serves `web-ui/index.html`. Static assets are served with `cache-control: no-store`. |
| `/health` | `GET` | Returns `{ ok, version, subsystems }` where `subsystems` carries MoySklad cache health (`status`, `loadedAt`, `productCount`, `lastError`, `refreshing`), VK and SpeechKit configuration status, and current safe-mode flag. Returns `503` when MoySklad has a `lastError` or when VK token / SpeechKit key are missing. No external API is pinged — values come from the last refresh attempt. |
| `/api/vk/validate-url` | `GET` | Validates a VK live video URL. Query: `url`. |
| `/api/safe-mode` | `GET` | Returns current safe mode state. |
| `/api/safe-mode` | `POST` | Accepts `{ "enabled": true|false }`. |
| `/api/send-logs/preview` | `GET` | Lists files that would be included in the diagnostic ZIP. |
| `/api/send-logs` | `POST` | Streams the diagnostic ZIP when called with `{ "userNote": "...", "download": true }`. |
| `/api/product-codes/refresh` | `POST` | Refreshes the in-memory product-code cache from MoySklad. |
| `/api/product-codes/status` | `GET` | Returns product-code cache status. |
| `/api/settings` | `GET` | Returns persisted operator settings. |
| `/api/settings` | `PATCH` | Deep-merges settings and persists them under `logs/settings.json`. |
| `/api/moysklad/suppliers` | `GET` | Returns cached MoySklad suppliers for wishlist purchase orders. |
| `/api/moysklad/stores` | `GET` | Returns cached MoySklad stores for wishlist purchase orders. |
| `/api/stream/config` | `GET` | Returns MediaMTX RTMP URL, publish credentials, and viewer URL for the dashboard "Стрим" panel, or `{configured:false}` when `STREAM_MEDIAMTX_API_URL` is unset. Publish credentials (`publishUser`/`publishPass`) are omitted (`credentialsHidden:true` instead) when `API_TOKEN` is not set — `/api/*` has no auth at all in that mode, so the publish password would otherwise be readable by anyone reaching the dashboard. See [[stream-integration]]. |
| `/api/stream/status` | `GET` | Returns `{configured, live, readers, error?}` by polling the MediaMTX control API. Degrades to `live:false` on any failure — never throws. |
| `/api/stream/preflight` | `GET` | Read-only broadcast readiness checks (`fix:false`): config, MediaMTX API, OBS reachability, OBS stream settings. Always `200` with `{ok, steps[]}`. See [[stream-integration]]. |
| `/api/stream/start` | `POST` | One-button broadcast start: preflight with auto-fix (launch OBS, write RTMP server/key), `StartStream` in OBS, wait up to 30s for MediaMTX `ready:true`. Always `200` with `{ok, steps[], live?}` — can take ~45s worst case. |
| `/api/stream/stop` | `POST` | Stops the OBS stream output. Always `200` with `{ok, steps[]}`. |
| `/api/stream/hls/*` | `GET` | Same-origin HLS proxy for the dashboard's «Картинка эфира» preview. Transparently forwards `/api/stream/hls/<path>` to `{viewerOrigin}/live/<path>` (origin derived from `STREAM_VIEWER_URL`), streaming the body back with the upstream content-type. Exists because cloud `/live/` sends no CORS and `/efir/` forbids framing (`X-Frame-Options: DENY`), so the dashboard can neither fetch the raw HLS cross-origin nor iframe the viewer page. `501` when `STREAM_VIEWER_URL` is unset, `400` on `..`/absolute subpaths, `502` (quiet, no error log) when cloud is unreachable — hls.js polls constantly and an idle эфир is expected. See [[stream-integration]]. |

## Wishlist routes

| Route | Method | Behavior |
|---|---|---|
| `/api/wishlist/count` | `GET` | Returns active wishlist count. |
| `/api/wishlist` | `GET` | Returns active wishlist entries grouped by supplier. |
| `/api/wishlist/archive` | `GET` | Returns archived and consumed wishlist entries. |
| `/api/wishlist/draft` | `POST` | Creates a submission draft and returns grouped wishlist snapshot. |
| `/api/wishlist/entries` | `POST` | Adds a manual wishlist entry. |
| `/api/wishlist/:entryId` | `PATCH` | Edits an active wishlist entry. |
| `/api/wishlist/:entryId` | `DELETE` | Removes an active wishlist entry. |
| `/api/wishlist/check-customerorders` | `POST` | Checks whether wishlist entries already exist in open MoySklad customer orders. |
| `/api/wishlist/purchase-order` | `POST` | Creates MoySklad purchase orders from selected wishlist groups, with idempotency by draft/group hash. |

## Blocked viewer routes

| Route | Method | Behavior |
|---|---|---|
| `/api/blocked-viewers` | `GET` | Returns the blocked viewers and their count, newest block first. |
| `/api/blocked-viewers` | `POST` | Blocks a viewer by `viewerId`; optional `viewerName` and `reason`. Idempotent — a repeat block keeps the original `blockedAt`. |
| `/api/blocked-viewers/:viewerId` | `DELETE` | Unblocks a viewer. Returns `404 viewer_not_blocked` when the id was not in the list. |
| `/api/viewers/ban` | `POST` | Real VK moderation. Body: `viewerId` (required), optional `viewerName`, `reason`, `commentId`. For a VK viewer (id `< 2^31`) calls `groups.ban` on the эфир community and, if `commentId` is given, `video.deleteComment`; for a chat viewer (id ≥ `9e9`) skips the VK ban (`ban.code: "chat_viewer_no_vk_ban"`). **Always also records a soft block** (`blockedBy: "vk_ban"` on success, else `"operator"`) so the viewer stops being processed even if the VK ban fails. Blocked in safe mode (`status: "safe_mode_blocked"`). Returns `{ok, ban, deleted, entry, count}`. See [[vk-comments#Real VK ban + comment deletion (2026-07-22)]]. |
| `/api/comments/delete` | `POST` | Deletes a VK эфир comment via `video.deleteComment`. Body: `commentId` (required). Blocked in safe mode. Returns the `{ok, code?}` result. |

Blocking is **soft**: it only stops V-Amber from processing that viewer's
comments. Nothing is banned in the VK community, so the spammer keeps
seeing their own comments. See [[vk-comments#Blocking spammers]].

## Reservation digest routes

| Route | Method | Behavior |
|---|---|---|
| `/api/reservation-digests/preview` | `GET` | Builds a per-client reservation digest for a date and enriches it with send state. |
| `/api/reservation-digests/send` | `POST` | Sends selected client digests via VK DM unless already sent, blocked, or safe mode is active. |

## Safety and stability notes

`/api/send-logs` supports download mode only; remote delivery returns
`remote_delivery_disabled`. The bundle build is wrapped in a 60-second
`Promise.race` timeout so the `logsInFlight` flag cannot get stuck.
Wishlist purchase-order creation is safe-mode aware: blocked groups are
not consumed and can be retried later.

The `checkOrdersCache` in `server/http-server.js` (used by
`/api/wishlist/check-customerorders`) is a bounded LRU with cap 1000 —
re-inserting an entry refreshes its position, and the oldest entry is
evicted at the cap.

VK direct-message random IDs use `crypto.randomInt`, not `Math.random`.

## Authentication

When `API_TOKEN` is set in `.env`, all `/api/*` endpoints require the
token. `/health` and static assets remain accessible (the latter only via
the initial `?token=<value>` redirect that sets the cookie). See
[[configuration-and-secrets]] for accepted token sources and
[[runtime-architecture]] for the WS-upgrade Origin allowlist.

Unauthenticated non-`/api/*` requests now redirect to `GET /login` —
a small HTML form (no JS, no external assets) that accepts the token
via `POST application/x-www-form-urlencoded`, sets the cookie, and
redirects to `/`. Wrong token → `303` to `/login?error=1`.

## WebSocket single-broadcast guard

The WS upgrade handler on `/ws/stt` rejects a second simultaneous
connection with HTTP 409 unless the request includes `?force=1`. The
project is built around a single live console — a second tab would
publish duplicate VK cards and run two comment pollers in parallel. If
a previous session truly hung without closing, the operator can
override with `?force=1`. See `server/ws-server.js`.

## Operator WS messages

Browser → server message types (in addition to `start`, `stop`,
`setSafeMode`):

- `closeLot` — manually close the active lot. Backend calls
  `publishLotClosed(activeLot, "manual_close")`, resets `activeLot`,
  and emits a fresh state. The session continues.
- `cancelReservation` `{ viewerId, commentId }` — operator cancels a
  confirmed reservation. Backend finds the matching `reserved` /
  `reserved_appended` event, removes its MoySklad position by exact
  `positionId` (`removePositionFromOrder`), decrements
  `committedReservationCount` by the event quantity, removes the viewer
  from `acceptedUserIds`, drops the `customerOrdersByViewerId` day entry,
  and marks the event `cancelled`. Blocked under safe mode (replies with a
  `warning`, no state change). A missing/already-cancelled reservation or a
  missing stored position also replies with a `warning`. See
  [[deferred-operator-features]] #16.
- `setLotPrice` — override the active lot's price. Backend overwrites
  both `voicePrice` and `salePrice` on the active product, sets
  `priceSource: "manual"`, and republishes the VK card if comments are
  open. Bypasses the `applyVoicePrice` guard that ignores voice prices
  when a sale price is already set, because manual intent is explicit.
- `manualCode` `{ code }` — operator types the article SpeechKit
  misheard. Backend builds a synthetic `confirmed` detection
  (`source: "manual"`) and runs it through `handleConfirmedDetection`,
  so it follows the exact voice path: same code merges into the active
  lot, a different code closes the old lot and opens a new one. It does
  NOT call `detectArticle`, so the YandexGPT fallback is unreachable.
  Guarded two ways: requires an active STT stream (`activeRunId != null`,
  "Variant A"), and the code must exist in the `productCodeCache`
  catalog — an unknown code or an unloaded catalog replies with a
  `warning` and opens nothing. See [[deferred-operator-features]] #14.

## Related pages

- [[runtime-architecture]]
- [[logging-and-diagnostics]]
- [[wishlist]]
- [[reservation-digests]]
- [[configuration-and-secrets]]
- [[stream-integration]]
