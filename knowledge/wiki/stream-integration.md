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

## Эфир mode toggle (2026-07-06)

`#efirModeToggle` in the topbar (`web-ui/index.html`, next to `#sessionPill`)
lets the operator switch between "ВК эфир" and "Свой эфир" so only the
controls for the broadcast method actually in use are shown: VK mode shows
`#vkLiveUrlWrap`; own-server mode shows `#streamPanel` and `#chatPanel`
(each still gated on being configured via `state.streamConfigured` /
`state.chatConfigured`). The choice is persisted in
`localStorage["efirMode"]` (`web-ui/app.js`, `applyEfirMode()`).

**This is UI-only.** VK-comment polling (`server/vk.js`) and the viewer-chat
poll (`/api/chat/messages`) keep running in parallel regardless of which
mode is selected in the UI — the toggle never reaches the server. This is
deliberate: a future multi-platform setup may run VK and the self-hosted
stream at the same time, and coupling reservation intake to the UI's
current tab would silently drop orders from the hidden channel.

## Dashboard panel

`web-ui/index.html` `#streamPanel` (hidden unless configured, and only
shown when `#efirModeToggle` is set to "Свой эфир") sits in the right
column above "Брони", styled with the existing `.panel` classes.
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

### Shooting from a phone while OBS/V-Amber run on the Mac (2026-07-06, question)

Operator question: V-Amber runs on the MacBook, but they want to shoot the
эфир with an iPhone. Since orchestration talks to OBS over
`ws://127.0.0.1:4455` (previous bullet), OBS itself must keep running on
the same Mac as V-Amber — the iPhone should feed OBS as a **camera/mic
source**, not run its own OBS/encoder. This needs no V-Amber code changes,
only an OBS scene source:

- **Continuity Camera (recommended, free)** — macOS Ventura+/iOS 16+, same
  Apple ID, Wi-Fi+Bluetooth on (or a USB-C cable for a more stable feed
  and to keep the phone charged). The iPhone shows up as a normal
  `Video Capture Device` in OBS (AVFoundation), no extra app/plugin. This
  is the default recommendation — it slots the phone in as OBS's camera
  and leaves the rest of the one-button flow (`Запустить эфир` /
  `Остановить`) untouched.
- **Fallback (older macOS/iPhone, or Continuity Camera unavailable)** —
  a virtual-webcam companion app (Camo, EpocCam, iVCam): install on both
  iPhone and Mac, pick the resulting virtual camera as the OBS source.
  Same architecture, just an extra app instead of a system feature.
- **Not recommended**: pushing RTMP directly from the iPhone (e.g. Larix
  Broadcaster) straight to MediaMTX. It would bypass OBS entirely, so
  `startBroadcast()`/`stopBroadcast()` (which drive OBS, not MediaMTX)
  would no longer control the эфир — the operator would have to start/stop
  the phone's RTMP push manually and only «Проверить эфир» (MediaMTX
  status) would still make sense.

## Chat session reset, tied to «Запустить эфир» (2026-07-06 — implemented)

**Problem**: `deploy/chat-service/server.js` keeps one continuous
`messages.jsonl` forever — there is no concept of "эфир session". Both
the operator dashboard's `#chatPanel` and the public `/efir/` page read
the same `/chat/messages` feed, so every new broadcast still shows
whatever was last said (including stale test messages from a previous,
unrelated эфир). The reservation-matching feed (`GET /chat/feed`, used by
`server/ws-server.js`'s `startChatPolling()`) is **not** affected by this —
its cursor already resets per audio session — this plan is only about the
human-visible chat log.

**Decision (user, 2026-07-06)**: no standalone "new session" button.
Instead, prompt the operator right when they click «Запустить эфир»
(`streamStartButton`, own-server broadcast mode): *"начать новую сессию
чата или продолжить старую?"* — as a non-blocking inline banner, the same
pattern as `#cacheBanner`'s pre-session product-code-cache prompt. This
piggybacks the chat-session boundary on the moment a new эфир actually
begins for viewers, and gives an explicit way to say **no** to a reset
when OBS/network dropped and the operator restarts the same broadcast (so
the ongoing chat isn't senselessly wiped on a reconnect).

**Design**:

1. `deploy/chat-service/server.js` — add a message `kind: "session"`
   marker (alongside the existing `"viewer"`/`"service"` kinds). A new
   `POST /chat/session/new` route (operator-only, same `X-Chat-Token` gate
   as `/chat/service`) appends the marker and moves an in-memory
   `sessionStartSeq` forward. `sessionStartSeq` is restored on boot by
   scanning loaded `messages.jsonl` for the last `kind:"session"` record
   (no extra state file). **Nothing is ever deleted** — `messages.jsonl`
   keeps full history, matching this project's append-only-log convention
   (wishlist-store, name-cache-store, order-recovery-from-logs).
2. `GET /chat/messages` (public — read by both the dashboard panel and
   `/efir/`) floors its result at `sessionStartSeq` in addition to the
   existing `after` cursor, so nobody (operator or viewer) can page back
   before the latest reset. `GET /chat/feed` (reservation intake) is
   unchanged. `GET /chat/health` gains `sessionStartSeq` for diagnostics.
3. `server/chat-client.js` — new `postNewSession()`, mirrors
   `postServiceMessage()`.
4. `server/http-server.js` — new `POST /api/chat/session` behind the
   existing `API_TOKEN` gate, next to the existing `/api/chat/messages`
   proxy, calling `chatClient.postNewSession()`.
5. `web-ui/index.html` — new `#chatSessionBanner` (same shape as
   `#cacheBanner`: two buttons, no "remember" checkbox — this must ask
   every time, not silently reuse the last answer). `web-ui/app.js` — new
   `askChatSessionChoice()` promise helper (mirrors `askCacheChoice()`).
   The `streamStartButton` handler awaits it **before** calling the real
   `startBroadcastFromUi()`, but only when `state.chatConfigured`; picking
   "новая сессия" fires `POST /api/chat/session` first (best-effort — a
   chat-service hiccup must not block the actual broadcast start).
6. Render the `kind:"session"` marker as a plain centered divider (not a
   chat bubble) in both the dashboard's `renderChatMessage()` and
   `deploy/stream-viewer/app.js`'s message renderer.

**Deploy note**: steps 1–2 live in `deploy/chat-service`, which only ships
via `.github/workflows/deploy-stream.yml` on push to `main` — steps 3–6
ship via the normal V-Amber release/update path on the operator's Mac.
Both legs need to land before the banner works end-to-end.

**Verification (2026-07-06)**: full flow tested against a throwaway local
`chat-service` instance (temporary `.env` override, reverted after) —
`POST /chat/session/new` auth-gated correctly (401 without/with wrong
`X-Chat-Token`), `GET /chat/messages` floors both fresh loads and
stale-cursor requests at `sessionStartSeq`, the boundary survives a
chat-service restart (rescanned from `messages.jsonl`), and the dashboard
banner → `POST /api/chat/session` → `POST /api/stream/start` sequencing
fired in the right order end-to-end. `npm test` stayed 313/313 throughout
(this feature has no dedicated automated test — `http-server.js` has no
existing test harness to extend; verification was manual, matching how
the эфир mode toggle above was verified).

**Testing gotcha found the hard way**: this Windows dev checkout has a
real OBS Studio reachable at the default `ws://127.0.0.1:4455` with a
scene already wired to this project's RTMP settings. Clicking «Запустить
эфир» against the **real** `STREAM_MEDIAMTX_API_URL`/OBS config (only
`STREAM_CHAT_URL` was overridden for this test, not MediaMTX/OBS) actually
launched OBS and started a real ~1-minute publish to production MediaMTX
(`obs_autolaunch_attempt` → `obs_stream_started` → `broadcast_started` in
the logs) — `readers` stayed 0 throughout, and it was stopped immediately
via `POST /api/stream/stop` once noticed. **Future local testing of
`/api/stream/start`/the new banner must also stub or override
`STREAM_MEDIAMTX_API_URL`/`OBS_WEBSOCKET_URL`** (not just chat), or use a
dedicated test/staging RTMP path, to avoid touching the real broadcast
pipeline again.

## Viewer page (2026-07-05)

`deploy/stream-viewer/` holds the public watch page: a single dark-themed
`index.html` plus a **vendored** `hls.min.js` (hls.js 1.6 — vendored rather
than CDN because the audience is in RU where jsdelivr is unreliable). It is
served by the same host nginx on `cloud` at
`https://www.xn--80azkg6cn.space/efir/`; the HLS stream is proxied
same-origin via `location /live/ → 127.0.0.1:8888` (no mixed content, no
CORS). Deploy steps and the nginx snippet live in
`deploy/stream-viewer/README.md` / `nginx-locations.conf`.

Page behavior: autoplay starts muted (browser policy) with an
«Включить звук» button; when no stream is up it shows «Эфир ещё не начался»
and silently retries every 7s, so viewers can open the link before the
broadcast starts. Safari/iOS uses native HLS, everything else hls.js.
`STREAM_VIEWER_URL` in the operator `.env` should point to `/efir/`, not to
the raw `.m3u8`.

## Viewer chat as a second reservation source (2026-07-05)

Own chat on `/efir/` so buyers can write «бронь 03204» without VK. It is
**additive**: the VK comment poller is untouched and both sources run in
parallel — one lot, one stock gate, one MoySklad order path; a broadcast can
take reservations from VK and the chat simultaneously.

- **`deploy/chat-service/`** — zero-dependency node:http service on `cloud`
  (docker, `127.0.0.1:8890`, nginx `location /chat/`). Endpoints, rate
  limits, and deploy steps in its README.
  - **Primary join: «Войти через VK»** (VK ID, OAuth 2.1 + PKCE — public
    client, no app secret stored anywhere). Added 2026-07-05 after the user
    flagged that synthetic chat ids would duplicate returning buyers: the
    MoySklad counterparty mapping is keyed on **VK id**
    (`findCounterpartyByVkId`/`stampVkIdOnCounterparty`), so a chat viewer
    authenticated via VK ID carries their **real VK user id** and maps to the
    same counterparty as their old VK-comment reservations. Name + verified
    phone come from `id.vk.com/oauth2/user_info` (scope
    `vkid.personal_info phone`). Needs a VK ID web app (`VK_APP_ID`,
    redirect `/chat/auth/vk/callback`, `PUBLIC_BASE_URL`) — see the README;
    without it the button is hidden. The callback hands the chat token to
    the page via a same-origin bridge page that writes `localStorage` and
    redirects back to `/efir/`.
  - **Fallback join: name + phone** (a бронь without a contact is useless;
    the phone is shown only to the operator feed, never to the public chat).
    These viewers get numeric ids in the **9e9+ range**
    (`ID_BASE = 9_000_000_000`) that can never collide with real VK ids
    (< 2^31), so the money path (counterparty, dedup, cancel by
    `viewerId+commentId`) still works — they just start a fresh counterparty.
    Message `commentId`s are always `9e9+seq` regardless of auth method.
- **`server/chat-client.js`** — V-Amber-side client: `fetchFeed(afterSeq)`
  (`afterSeq === null` → cursor init only, history is never replayed —
  mirrors the VK poller's last-comment-id init) and best-effort
  `postServiceMessage(text)`. Auth via `X-Chat-Token`.
- **`server/ws-server.js`** — the per-comment processing that used to live
  inline in the VK poll loop is extracted into `ingestViewerComment(comment)`
  taking the normalized shape `{id, viewerId, viewerName, text, createdAt,
  source: "vk"|"chat", phone?}`; the VK loop and the new chat poll loop both
  call it, so parsing/matching/stock/MoySklad are literally the same code.
  `startChatPolling()` mirrors the VK poller lifecycle (starts on lot open,
  stops after the 30s no-open-lot grace) but has its **own generation
  counter**: a VK poison (error 801) must not kill chat intake, and vice
  versa. `notifyReservationStatus` routes the buyer reply by `event.source` —
  chat reservations get a service message in the chat («Янтарь: …, бронь
  подтверждена (код …)»), VK ones reply in VK as before.
- **Logging/recovery**: same event names (`comment_seen`,
  `reservation_detected`, `reservation_no_open_lot`, …) with logger component
  `chat` instead of `vk`, plus `source` and `viewerPhone` in the meta — so
  the order-recovery-from-logs tooling keeps working and the operator has the
  buyer's phone in the log line.
- Config: `config.chat` (`STREAM_CHAT_URL`, `STREAM_CHAT_TOKEN`,
  `STREAM_CHAT_TIMEOUT_MS`, `STREAM_CHAT_POLL_MS`). Without the URL the chat
  poller never starts and behavior is exactly pre-chat.
- Tests: `test/ws-server.chat-source.test.js` (chat бронь through the shared
  pipeline + reply routing; VK and chat sharing one lot's stock counter),
  `createChatClientMock` in `test/helpers/ws-harness.js`.

## Deploy automation (CI, 2026-07-05)

Both `deploy/stream-viewer/` and `deploy/chat-service/` used to be deployed by
hand (`ssh`/`scp` commands in their READMEs). `.github/workflows/deploy-stream.yml`
now automates this: on every push to `main` that touches `deploy/stream-viewer/**`
or `deploy/chat-service/**`, it rsyncs the changed files to `cloud` and (for
chat) runs `docker compose restart chat`, then curls both public URLs as a
smoke test. It deliberately triggers **only on `push` to `main`, never on
`pull_request`** — the repo is public, and GitHub does not expose repo secrets
to workflows triggered from fork PRs, so keeping the trigger push-only is what
keeps the deploy secrets safe.

**Why a new `ci-deploy` user instead of reusing the existing deploy path**:
`user1` (the account used for every manual `ssh cloud` command elsewhere in
this wiki) has passwordless `sudo ALL` and is in the `docker` group — i.e. it
is root-equivalent on a host that also runs unrelated production services
(auctionbot, pay-service, n8n). Putting that key into GitHub Actions secrets
would mean a leaked secret = root on a box with a payment service. So CI gets
its own low-privilege account instead:

- `ci-deploy` — created by
  [`deploy/ci/setup-cloud-deploy-user.sh`](../../deploy/ci/setup-cloud-deploy-user.sh)
  (idempotent, run once with the CI public key as its argument). It's in
  groups `docker` (needed to restart the chat container over the docker
  socket — unavoidable, docker-group membership is itself root-equivalent,
  this is the one real privilege the account needs) and `www-data` (so it can
  write into `/var/www/stream-viewer`, which is `chown www-data`, without
  `chown`-ing it away from nginx every deploy). It has **no sudo**.
- Its SSH key is restricted with a **forced command**
  ([`deploy/ci/ci-deploy-dispatch.sh`](../../deploy/ci/ci-deploy-dispatch.sh))
  so the key cannot open an interactive shell — sshd always runs the
  dispatcher, which inspects `$SSH_ORIGINAL_COMMAND` and allows exactly three
  things: `rrsync -wo` into `/var/www/stream-viewer/`, `rrsync -wo` into
  `/srv/chat-service/`, or the literal fixed string `restart-chat` (→
  `docker compose restart chat`). Anything else is rejected. This caps the
  blast radius of a leaked CI secret to "can overwrite these two directories
  and restart this one container" — not a general-purpose shell, not access
  to auctionbot/pay-service/n8n on the same box.
- `chat-service` was **relocated from `~user1/chat-service` to
  `/srv/chat-service`**, owned by `ci-deploy`, as part of that same setup
  script — `ci-deploy` isn't in `user1`'s group and can't write inside
  `/home/user1`, so the service had to move to a neutral path both accounts
  can reason about. The docker-compose bind mounts (`./server.js`, `./data`)
  are relative, so the move is transparent to the running container; only the
  host-side path changed. `deploy/chat-service/README.md`'s manual/fallback
  steps were updated to the new path.

**GitHub secrets** (Settings → Secrets and variables → Actions):

| Secret | Contents | Why a secret and not plain workflow text |
|---|---|---|
| `DEPLOY_SSH_KEY` | private half of the dedicated CI keypair (ed25519, no passphrase — required for unattended CI) | obviously sensitive |
| `DEPLOY_SSH_HOST` | the `cloud` IP | wiki convention keeps this IP out of anywhere publicly readable (see infra section above); the workflow file is in a public repo, so it gets the same treatment as the wiki instead of being hardcoded |
| `DEPLOY_SSH_KNOWN_HOSTS` | `ssh-keyscan` output for that IP | pins the host key so the workflow can't be MITM'd by `StrictHostKeyChecking=no`; also embeds the IP, hence also a secret |

**Rotation/revocation**: to cut off CI access, delete the one `authorized_keys`
line under `/home/ci-deploy/.ssh/` on `cloud` (or `sudo userdel -r ci-deploy`
to remove the account entirely) and rotate the three GitHub secrets. Nothing
else on the box depends on that account.

**Known pre-existing condition, not fixed by this change**: `user1` itself
still has passwordless `sudo ALL` + `docker` group and is still what every
manual `ssh cloud` command in this wiki uses — this design only makes sure
*CI* doesn't inherit that exposure, it doesn't tighten `user1`. Worth revisiting
separately.

## Dashboard live preview + comments feed (2026-07-22)

Roman broadcasts with the iPhone as OBS's Continuity Camera, so the phone screen
shows only the "connected to Mac" state — he can't watch the эфир picture or read
comments on it. Both were brought onto the laptop dashboard. UI details in
[[web-dashboard#Live preview + comments feed (center column, 2026-07-22)]];
the stream-side pieces:

- **`config.stream.viewerOrigin`** (`server/config.js`) — the origin of
  `STREAM_VIEWER_URL` (e.g. `https://…` without `/efir/`). Empty when
  `STREAM_VIEWER_URL` is unset.
- **`GET /api/stream/hls/*`** (`server/http-server.js`) — a same-origin HLS
  proxy: forwards `/api/stream/hls/<path>` → `{viewerOrigin}/live/<path>`,
  streaming the body (`Readable.fromWeb`) with the upstream content-type. Needed
  because cloud `/live/` sends **no CORS** (dashboard on `localhost` can't fetch
  the raw `.m3u8` cross-origin) and `/efir/` sends `X-Frame-Options: DENY` +
  `frame-ancestors 'none'` (can't iframe the viewer page either). MediaMTX HLS
  playlists reference segments by **relative** path, so segment requests land
  back on this proxy automatically — no URL rewriting. Verified end-to-end
  against the live cloud MediaMTX (idle эфир returns MediaMTX's own
  `"no stream is available on path 'live'"` 404; a running эфир returns the
  playlist). One operator watching their own low-volume stream — proxying
  segments through the local node process is fine. Note the split gating: the
  proxy works whenever `viewerOrigin` (from `STREAM_VIEWER_URL`) is set, but the
  dashboard only auto-shows the preview when the stream is *also* configured
  (`STREAM_MEDIAMTX_API_URL`, via `/api/stream/config`).
- **`web-ui/hls.min.js`** — hls.js vendored into the dashboard (copy of
  `deploy/stream-viewer/hls.min.js`), loaded as a plain `<script>` before the
  module `app.js` so `window.Hls` is global.
- **`viewerComment` WS message** (`server/ws-server.js`) — emitted per
  non-blocked comment from `ingestViewerComment` for the «Комментарии зала»
  feed; additive, does not touch reservation logic. Tests:
  `test/ws-server.viewer-comment.test.js`.

This is preview-only and read-only against the stream — it does not change the
broadcast pipeline, VK/MoySklad flow, or the one-button orchestration.

## Dual-stream: mirror the эфир to VK (2026-07-22)

Roman's request #1 — broadcast to VK **and** the own platform at once. Order
intake from both sources already runs in parallel (the VK poller and chat poller
are both always on); this adds the **video** to VK too.

**Mechanism: a V-Amber-managed local ffmpeg relay** (`server/stream-relay.js`).
`ffmpeg -i <MediaMTX RTMP> -c copy -f flv <VK RTMP+key>` reads the own stream
back from MediaMTX and pushes it to VK Live, `-c copy` (no re-encode, minimal
CPU). Chosen over an OBS multi-RTMP plugin (not controllable via obs-websocket)
and a cloud-side restream (deploy-gated, touches the prod host).

- **Topology / why it's safe**: the own stream stays **direct** (OBS→MediaMTX,
  unchanged and orchestrated as before). The relay is a **secondary, best-effort**
  channel — if ffmpeg dies it self-restarts a bounded number of times
  (`relayRestartMax`, default 5) and **never affects the own stream**. Roman
  moved off VK Live precisely for reliability, so VK must not be able to
  jeopardise the own эфир.
- **Bandwidth trade-off**: the relay pulls from cloud MediaMTX and pushes to VK,
  so the operator's uplink carries the stream twice (to MediaMTX + to VK). For a
  single shopping эфир at a moderate bitrate that's acceptable; documented here
  so it isn't a surprise.
- **Orchestration** (`server/stream-orchestrator.js`): after MediaMTX confirms
  the own stream is live, `startVkRelayStep` starts the relay and adds a
  «Дубль в ВК» step to the `{ok, steps}` result (informational — a relay failure
  never flips the broadcast to `ok:false`). `stopBroadcast` stops the relay
  first, unconditionally and idempotently.
- **Config** (`config.stream`, all optional — no `vkTargetUrl` ⇒ dual-stream
  off): `STREAM_VK_TARGET_URL` (full VK push URL) **or** `STREAM_VK_RTMP_URL` +
  `STREAM_VK_KEY` (server + key from VK «Трансляции», combined as
  `server/key`); `STREAM_RELAY_SOURCE_URL` (defaults to
  `STREAM_RTMP_URL/​<pathName>` — MediaMTX allows anonymous read on `live`);
  `STREAM_FFMPEG_PATH` (default `ffmpeg`); `STREAM_RELAY_RESTART_MAX/DELAY_MS`.
- **Status**: `GET /api/stream/status` now includes `relay: {configured, state
  (idle|running|error), restarts, lastError}`; the dashboard stream panel shows a
  «Дубль в ВК: активен/не запущен/ошибка» line (`#streamRelayLine`).
- **Operator prerequisites (manual, one-time per эфир)**: ffmpeg installed on the
  Mac; a VK Live broadcast created in VK «Трансляции» to get its RTMP server +
  key (VK's live-create isn't automated); paste those into the config. The VK
  live **video URL** for comment polling is the existing `VK_LIVE_VIDEO_URL`.
- **Tests**: `test/stream-relay.test.js` (command build, bounded restart on
  unexpected exit, stop kills + blocks restart, not-configured/​spawn-fail
  guards) — with a fake `spawn`, so no real ffmpeg/VK push runs.

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
