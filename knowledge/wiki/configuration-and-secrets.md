# Configuration and secrets

V-Amber reads runtime configuration from `.env` through `server/config.js`.
Never copy real secret values into the wiki.

## Required startup value

`YANDEX_SPEECHKIT_API_KEY` is required for backend startup.

## Main variable groups

Speech recognition:

- `YANDEX_SPEECHKIT_API_KEY`
- `YANDEX_SPEECHKIT_FOLDER_ID`
- `YANDEX_SPEECHKIT_LANG`
- `YANDEX_SPEECHKIT_MODEL`

VK:

- `VK_TOKEN`
- `VK_GROUP_TOKEN` / `VK_ACCESS_TOKEN` — токен сообщества Amberry,
  под которым публикуются комментарии и грузятся фото к live-видео.
  **Должен принадлежать той группе, от чьего имени должны идти ответы
  покупателям.** Если токен от другой группы (исторически попадал «Amber
  Standard»), VK-комментарии уходят от чужого имени — оператор в эфире
  замечает «надо чтобы не амбар стандарт писал». Где взять: VK → Управление
  сообществом → Работа с API → Создать ключ доступа с правами `wall`,
  `photos`, `messages`. Передать оператору приватным каналом, в `.env`
  переменную не коммитить. Для проверки в дашборде смотрите footer/диагностику
  — там виден `groupId`, а ответы должны приходить от Amberry.
- `VK_LIVE_VIDEO_URL`
- `VK_GROUP_ID`
- `VK_API_MIN_INTERVAL_MS`
- `VK_API_RATE_LIMIT_BACKOFF_MS`

MoySklad:

- `MOYSKLAD_LOGIN`
- `MOYSKLAD_PASSWORD`
- `MOYSKLAD_ORGANIZATION_ID`
- `MOYSKLAD_STORE_ID`
- `MOYSKLAD_VK_ID_ATTRIBUTE_ID`

Article parsing:

- `VOICE_ARTICLE_TRIGGERS` — comma-separated phrases that introduce a lot code.
  Default is `код товара`; when the standard triggers are used,
  `parseArticleTriggers` (`server/config.js`) also auto-adds `артикул` **and the
  short `код`**, so «код товара 01234», «артикул 01234» and «код 01234» all open
  the lot out of the box (the short `код` was added 2026-06-06).
- `VOICE_ARTICLE_MIN_LENGTH`
- `VOICE_ARTICLE_MAX_LENGTH`

Stream (MediaMTX, added 2026-07-02) — optional self-hosted RTMP/HLS
alternative to VK Live, see [[stream-integration]]:

- `STREAM_MEDIAMTX_API_URL` — base URL of the MediaMTX control API.
  Since 2026-07-03 this is the authenticated nginx reverse-proxy on `cloud`
  (`https://<domain>/mediamtx`); an SSH-tunnel local endpoint still works
  as a fallback. Feature is disabled/hidden when unset.
- `STREAM_MEDIAMTX_API_TOKEN` — secret expected by that proxy in the
  `X-Stream-Token` header; omitted from requests when empty (tunnel mode).
  Real value lives only in `.env` and the nginx config on `cloud`.
- `STREAM_PATH_NAME` — MediaMTX path name, default `live`.
- `STREAM_RTMP_URL` — RTMP server URL for OBS, **bare, no path**
  (`rtmp://<host>:1935`). OBS's Server/Stream-Key split has no separate
  username field, so MediaMTX's `user`+`pass` travel together as query
  params on the path — the dashboard builds that combined value
  server-side (`obsStreamKey` in `GET /api/stream/config`) and shows it as
  the "Ключ публикации" field. Do not put `/live` on `STREAM_RTMP_URL`
  itself or OBS's Server+"/"+Key concatenation ends up with a stray slash
  before the query string and MediaMTX rejects the path.
- `STREAM_PUBLISH_USER` / `STREAM_PUBLISH_PASS` — publish credentials.
  Real values must stay in `.env` only.
- `STREAM_VIEWER_URL` — HLS playback URL shared with viewers.
- `STREAM_STATUS_TIMEOUT_MS` — timeout for the status poll, default 3000.
- `OBS_WEBSOCKET_URL` / `OBS_WEBSOCKET_PASSWORD` / `OBS_TIMEOUT_MS` —
  obs-websocket endpoint on the operator machine (default
  `ws://127.0.0.1:4455`, timeout 4000ms) for the one-button broadcast
  start/stop; see [[stream-integration]]. Password comes from OBS: Сервис
  → Настройки сервера WebSocket.

Server bind and access control (added 2026-05-29):

- `HOST` — listen address. Defaults to `0.0.0.0` (needed for Docker port
  mapping). Set to `127.0.0.1` for local-only access. Read in
  `server/config.js` and applied in `server/index.js` `httpServer.listen`.
- `API_TOKEN` — optional shared token. When set, every `/api/*` request
  and every WebSocket upgrade on `/ws/stt` must present the token. Accepted
  via `Authorization: Bearer <token>`, `x-api-token` header, `api_token`
  cookie, or `?token=<value>` query. First visit with `?token=` sets an
  `HttpOnly; SameSite=Lax` cookie and redirects without the token in the
  URL — the static frontend keeps working unchanged. Implementation:
  `server/auth.js` with `crypto.timingSafeEqual` for constant-time compare.
- `ALLOWED_ORIGINS` — CSV list of permitted `Origin` headers for WS
  upgrade. When unset, the default allowlist is loopback only
  (`localhost`, `127.0.0.1`, `[::1]`). When set, the list fully replaces
  the loopback default, so a real domain deployment must list its own
  origin here.

When `API_TOKEN` is set, unauthenticated non-`/api/*` requests are
redirected to `GET /login` — a tiny self-contained HTML form (no
external assets) that accepts the token via POST and sets the cookie.
See [[http-api#Authentication]].

## Optional integrations

VK and MoySklad are optional at code level: without configuration, related
actions are skipped or logged. SpeechKit is not optional for normal startup.

## Safety

`.env` is runtime configuration and must not be treated as source. Use
`.env.example` for public examples and this page for variable groups.
