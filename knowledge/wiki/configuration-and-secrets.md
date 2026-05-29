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

- `VOICE_ARTICLE_TRIGGERS`
- `VOICE_ARTICLE_MIN_LENGTH`
- `VOICE_ARTICLE_MAX_LENGTH`

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

## Optional integrations

VK and MoySklad are optional at code level: without configuration, related
actions are skipped or logged. SpeechKit is not optional for normal startup.

## Safety

`.env` is runtime configuration and must not be treated as source. Use
`.env.example` for public examples and this page for variable groups.
