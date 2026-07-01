# Stream integration (MediaMTX)

Self-hosted RTMP/HLS video as an alternative to VK Live, added because VK
Live had reliability problems for the operator. This is an independent
video channel — it does not touch the existing VK-comment order flow
(article detection, reservations, MoySklad writes stay on VK exactly as
before). MVP scope only: no OBS automation, just connection info + a
live/not-live indicator in the dashboard.

## Infrastructure

MediaMTX (`bluenviron/mediamtx`, Docker) runs on the `cloud` host
(176.108.255.4, cloud.ru), which also hosts unrelated production services
(auctionbot, pay-service, n8n). Deployed under `~/mediamtx/` with:

- `docker-compose.yml` — `network_mode: host`, `cpus: "0.5"`,
  `mem_limit: 512m` so a busy эфир can't starve the payment service on the
  same box.
- `mediamtx.yml` — only RTMP (`:1935`), HLS (`:8888`), and the control API
  are enabled; RTSP/WebRTC/SRT/MoQ are explicitly turned off to shrink the
  attack surface and idle footprint. The API (`apiAddress: 127.0.0.1:9997`)
  binds to loopback only — it is never exposed publicly.
- Auth uses MediaMTX's `authInternalUsers` (not the older per-path
  `publishUser`/`publishPass`, which newer MediaMTX versions have moved
  away from): a `publisher` user can publish to path `live`; anonymous
  `read` is allowed on `live` for viewers; `api`/`metrics`/`pprof` are only
  granted to loopback.
- `ufw` on `cloud` allows `1935/tcp` and `8888/tcp` from anywhere (opened
  2026-07-02). **Cloud.ru's own security-group firewall may still block
  these ports at the provider level and needs to be opened separately by
  the account owner** — `ufw` alone is not sufficient for external
  reachability on this host.

Verified end-to-end with a throwaway `mwader/static-ffmpeg` container
pushing a test pattern: RTMP publish → `ready: true` on
`GET /v3/paths/get/live` → working multi-track HLS playlist on
`/live/index.m3u8`. Container stayed under 512 MB / 1% CPU under that load.

## Reaching the API from V-Amber

V-Amber (running on the operator's machine, not on `cloud`) talks to the
MediaMTX control API over an SSH tunnel for now:
`ssh -L 9997:127.0.0.1:9997 cloud`, then `STREAM_MEDIAMTX_API_URL=http://127.0.0.1:9997`.
This is fine for testing; a real deployment should instead put the API
behind an authenticated reverse proxy on `cloud` and drop the tunnel
requirement — not done in this MVP.

## Server-side pieces

- `server/config.js` — `config.stream` block (all fields optional; the
  feature is fully disabled/hidden when `STREAM_MEDIAMTX_API_URL` is
  unset). See [[configuration-and-secrets]] for the variable list.
- `server/stream-status.js` — `getStreamStatus()` polls
  `GET {apiUrl}/v3/paths/get/{pathName}` with an `AbortController` timeout
  (mirrors the `fetchWithTimeout` pattern in `server/moysklad.js`) and
  degrades to `{ live: false, error }` on any failure — this is a
  best-effort UI indicator, not a critical path.
- `server/http-server.js` routes (covered by the existing `API_TOKEN`
  middleware *only when API_TOKEN is set* — see [[http-api]] and the
  credentials note below for what happens when it isn't):
  - `GET /api/stream/config` — returns RTMP URL, publish user/pass, and
    viewer URL for the dashboard to display, or `{configured:false}`.
    **Fails closed on credentials**: when `API_TOKEN` is unset, `/api/*`
    has no authentication at all (see [[configuration-and-secrets]]), so
    this route omits `publishUser`/`publishPass` and returns
    `credentialsHidden: true` instead — otherwise the MediaMTX publish
    password would be readable by anyone who can reach the dashboard.
    The dashboard shows a placeholder telling the operator to set
    `API_TOKEN` to unlock the key field.
  - `GET /api/stream/status` — returns `{configured, live, readers, error?}`.

## Dashboard panel

`web-ui/index.html` `#streamPanel` (hidden unless configured) sits in the
right column above "Брони", styled with the existing `.panel` classes.
`web-ui/app.js`:

- `initStreamPanel()` — fetches `/api/stream/config` once at page load,
  fills the RTMP/key/viewer-link fields, unhides the panel, and starts
  `pollStreamStatus()` on a 5s `setInterval`.
- `pollStreamStatus()` — updates a `.dot` (reusing `dot--live`/`dot--warn`/
  `dot--err`, same classes as `setSessionPill`) and a status label
  ("В эфире · N зрителей" / "Стрим не запущен" / "Ошибка связи с сервером").
- Each field has a "Копировать" button (`.stream-copy`,
  `navigator.clipboard.writeText`) — this is the first clipboard-copy
  utility in the codebase.

## Deliberately out of scope (MVP)

- No OBS WebSocket automation — the operator starts/stops the RTMP push
  from OBS manually; the panel only shows connection info and status.
- No public-facing auth in front of the MediaMTX API — SSH tunnel only.
- No changes to VK comment parsing, reservations, or MoySklad order flow.

## Related pages

- [[configuration-and-secrets]]
- [[http-api]]
- [[web-dashboard]]
- [[runtime-architecture]]
