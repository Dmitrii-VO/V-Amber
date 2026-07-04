# Stream integration (MediaMTX)

Self-hosted RTMP/HLS video as an alternative to VK Live, added because VK
Live had reliability problems for the operator. This is an independent
video channel — it does not touch the existing VK-comment order flow
(article detection, reservations, MoySklad writes stay on VK exactly as
before). MVP scope only: no OBS automation, just connection info + a
live/not-live indicator in the dashboard.

## Infrastructure

MediaMTX (`bluenviron/mediamtx`, Docker) runs on the `cloud` host
(cloud.ru; IP withheld from wiki — reach it via the `cloud` SSH alias),
which also hosts unrelated production services
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
  2026-07-02). Cloud.ru's own security-group firewall (`SSH-access_ru.AZ-2`
  in the console) also had to be opened separately by the account owner —
  `ufw` alone was not sufficient for external reachability on this host.
  **Done 2026-07-02**: rules added for `1935:1935/tcp` and `8888:8888/tcp`
  from `0.0.0.0/0`, confirmed both ports externally reachable (raw TCP
  connect from outside `cloud` succeeded on both; MediaMTX's own logs
  independently show unsolicited internet scanner connections hitting
  `1935` the same day, confirming the port is world-visible). RTMP publish
  auth confirmed working externally-facing too — `authInternalUsers`
  rejects unauthenticated publish attempts as expected and accepts
  `rtmp://<host>:1935/live?user=publisher&pass=<publishPass>` (note: the
  `user:pass@host` URL form fails DNS resolution in ffmpeg's native RTMP
  muxer — use the query-string form).

Verified end-to-end with a throwaway `mwader/static-ffmpeg` container
pushing a test pattern: RTMP publish → `ready: true` on
`GET /v3/paths/get/live` → working multi-track HLS playlist on
`/live/index.m3u8`. Container stayed under 512 MB / 1% CPU under that load.

## Reaching the API from V-Amber

**2026-07-03: SSH tunnel replaced with an authenticated reverse proxy.**
The host nginx on `cloud` (the one serving `www.xn--80azkg6cn.space`) got a
`location /mediamtx/` in its 443 vhost
(`/etc/nginx/sites-enabled/amberapp_domain.conf`) that proxies to
`127.0.0.1:9997` and returns `401` unless the request carries the right
`X-Stream-Token` header. The token lives only in that nginx config and in
the operator's `.env` (`STREAM_MEDIAMTX_API_TOKEN`) — never in the wiki or
repo. V-Amber therefore sets
`STREAM_MEDIAMTX_API_URL=https://www.xn--80azkg6cn.space/mediamtx` and no
longer needs any SSH access for the status/orchestration path. The old
tunnel (`ssh -L 9997:127.0.0.1:9997 cloud` + `http://127.0.0.1:9997`) still
works as a fallback; with no token configured the header is simply omitted.

Editing that nginx config follows the local convention: back up to
`*.bak.<epoch>` first, `nginx -t`, then reload. Note the `.bak` files sit in
`sites-enabled/` and are parsed by nginx too — hence the pre-existing
"conflicting server name" warnings on `nginx -t`; harmless but noisy.

## Server-side pieces

- `server/config.js` — `config.stream` block (all fields optional; the
  feature is fully disabled/hidden when `STREAM_MEDIAMTX_API_URL` is
  unset). See [[configuration-and-secrets]] for the variable list.
- `server/stream-status.js` — `getStreamStatus()` polls
  `GET {apiUrl}/v3/paths/get/{pathName}` with an `AbortController` timeout
  (mirrors the `fetchWithTimeout` pattern in `server/moysklad.js`) and
  degrades to `{ live: false, error }` on any failure — this is a
  best-effort UI indicator, not a critical path. `config.stream.apiUrl`
  strips a trailing slash so a trailing-`/` in `STREAM_MEDIAMTX_API_URL`
  can't produce a double-slash request path.
- `server/http-server.js` routes (covered by the existing `API_TOKEN`
  middleware *only when API_TOKEN is set* — see [[http-api]] and the
  credentials note below for what happens when it isn't):
  - `GET /api/stream/config` — returns RTMP URL, publish user/pass, an
    `obsStreamKey`, and viewer URL for the dashboard to display, or
    `{configured:false}`.
    **Fails closed on credentials**: when `API_TOKEN` is unset, `/api/*`
    has no authentication at all (see [[configuration-and-secrets]]), so
    this route omits `publishUser`/`publishPass`/`obsStreamKey` and
    returns `credentialsHidden: true` instead — otherwise the MediaMTX
    publish password would be readable by anyone who can reach the
    dashboard. The dashboard shows a placeholder telling the operator to
    set `API_TOKEN` to unlock the key field.
    `obsStreamKey` = `${pathName}?user=${publishUser}&pass=${publishPass}`
    — MediaMTX's `authInternalUsers` needs both `user` and `pass`, but
    OBS's Server/Stream-Key split has no separate username field, so both
    travel together in the key. `STREAM_RTMP_URL` must be the bare server
    (no `/live`) for OBS's Server+"/"+Key concatenation to land on the
    right path — confirmed 2026-07-02 against the live `cloud` deployment
    (the `user:pass@host` URL form fails DNS resolution in ffmpeg's
    native RTMP muxer; the query-string form on the key is what works).
  - `GET /api/stream/status` — returns `{configured, live, readers, error?}`.
    Always `200` with this same shape, including the (theoretical) case
    where `getStreamStatus()` itself throws — no separate `500` shape for
    callers to branch on.

## Dashboard panel

`web-ui/index.html` `#streamPanel` (hidden unless configured) sits in the
right column above "Брони", styled with the existing `.panel` classes.
`web-ui/app.js`:

- `initStreamPanel()` — fetches `/api/stream/config` once at page load,
  fills the RTMP/key/viewer-link fields, unhides the panel and the action
  buttons. **No background polling at page load** (2026-07-03; the original
  5s `setInterval` spammed `status_poll_failed` WARNs whenever MediaMTX
  wasn't reachable).
- `pollStreamStatus()` — updates a `.dot` (reusing `dot--live`/`dot--warn`/
  `dot--err`, same classes as `setSessionPill`) and a status label
  ("В эфире · N зрителей" / "Стрим не запущен" / "Ошибка связи с сервером: …"
  — the error text is appended so an operator mid-incident can see *why*,
  not just that something's wrong). Guarded by `state.streamStatusPolling`
  so a slow request can't overlap with the next 5s tick. Returns the
  outcome (`"live" | "offline" | "error" | "unconfigured" | null`) so the
  polling loop can decide whether to keep going.
- «Проверить эфир» (`toggleStreamPolling`) — starts a 5s polling loop that
  keeps running while live (to update the viewer count) and auto-stops
  after `STREAM_OFFLINE_MAX_CYCLES` (3) consecutive offline/error cycles.
- «Запустить эфир» / «Остановить» (`startBroadcastFromUi` /
  `stopBroadcastFromUi`) — call `/api/stream/start` / `/api/stream/stop`
  and render the orchestrator's step list into `#streamChecklist`
  (`renderStreamChecklist`, textContent-only — no innerHTML injection).
  On successful start the status polling loop is started automatically.
- Each field has a "Копировать" button (`.stream-copy`,
  `navigator.clipboard.writeText`) — this is the first clipboard-copy
  utility in the codebase.

## One-button broadcast orchestration (2026-07-03)

- `server/obs-client.js` — minimal obs-websocket v5 client on the existing
  `ws` dependency (no new packages). One short-lived connection per
  operation, everything under `config.obs.timeoutMs`, typed `ObsError`
  codes (`unreachable` / `auth_failed` / `timeout` / `request_failed`).
  Auth handshake: `base64(sha256(base64(sha256(pass+salt)) + challenge))`;
  close code `4009` = wrong password.
- `server/stream-orchestrator.js` — `preflightBroadcast({fix})`,
  `startBroadcast()`, `stopBroadcast()`. Never throws; always returns
  `{ok, steps: [{id, label, status: ok|fixed|fail, detail, hint}]}` so a
  stream failure can't disturb the rest of the dashboard. Auto-fixes when
  `fix:true`: launches OBS locally if unreachable (spawn, detached, no
  shell; on win32 cwd must be OBS's `bin/64bit` dir or OBS refuses to
  start), writes the RTMP server/key into OBS
  (`SetStreamServiceSettings`, `rtmp_custom`) unless OBS is currently
  streaming (settings are locked mid-stream). `startBroadcast()` then
  `StartStream`s and polls MediaMTX up to 30s for `ready:true`.
- Routes (`server/http-server.js`, behind the same `API_TOKEN`
  middleware): `GET /api/stream/preflight` (diagnostic, `fix:false`),
  `POST /api/stream/start`, `POST /api/stream/stop` — all always `200`
  with the `{ok, steps}` shape.
- Config: `config.obs` — `OBS_WEBSOCKET_URL` (default
  `ws://127.0.0.1:4455`), `OBS_WEBSOCKET_PASSWORD`, `OBS_TIMEOUT_MS`.
  V-Amber and OBS run on the same operator machine, so localhost is right.

## Deliberately out of scope

- Installing OBS automatically — a `fail` step links the operator to
  https://obsproject.com/download with WebSocket-enable instructions
  instead.
- No changes to VK comment parsing, reservations, or MoySklad order flow.

## Related pages

- [[configuration-and-secrets]]
- [[http-api]]
- [[web-dashboard]]
- [[runtime-architecture]]
