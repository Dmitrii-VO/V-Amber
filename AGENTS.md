# Repository notes

Repo no longer spec-only. Current tree contains runnable MVP prototype:
- `server/` Node.js backend on ESM modules.
- `web-ui/` static browser UI for microphone control and session status.
- `package.json` with local Node.js runtime command: `npm start`.
- `Dockerfile`, `docker-compose.yml`, and `start-docker.command` for Docker
  Desktop based macOS startup.
- `.env` for secrets, `logs/` for runtime logs, `todo.md` for product notes.

Do not treat `node_modules/`, `logs/`, or `.env` as source files.
`Amberry_Voice_Technical_Specification.md`, `todo.md`, `PLAN.md`,
`AGENTS.md`, `CLAUDE.md`, and `V-Amber.zip` are ignored by `.gitignore` in
this local workspace, but they are still active working documents when the user
asks to update them.

# Source of truth

`Amberry_Voice_Technical_Specification.md` remains product source of truth for
scope, business rules, and terminology.

When spec conflicts with executable code or verified runtime behavior, trust
code for current implementation details and update docs accordingly.

Spec language is Russian. Preserve product terms and external API names exactly
when adding code or docs.

# Current implementation

Current stack in repo:
- JavaScript on Node.js, not TypeScript yet.
- Browser Web UI served by local HTTP server.
- WebSocket audio streaming from browser to backend.
- Yandex SpeechKit Streaming API integration for realtime STT.
- Article extraction from transcript with regex/number-word parsing and
  YandexGPT fallback config.
- Telegram callback workflow for ambiguous article confirmation.
- Voice discount detection and Telegram-triggered discount application.
- MoySklad integration for product lookup and customer order reservation.
- VK integration for live comment polling, lot-card publishing, and reservation
  handling.
- Safe mode that blocks external write actions while still logging detected
  events.
- JSON server logging plus per-session Markdown logs under `logs/sessions/`.
- Docker packaging for current Node.js MVP, with `logs/` mounted from the host.

Main entrypoints and modules:
- `server/index.js`: starts HTTP server.
- `server/http-server.js`: serves `web-ui/` assets, `/health`, and
  `/api/safe-mode`.
- `server/ws-server.js`: WebSocket session flow, active lot state, VK comments,
  reservations, discounts, safe mode broadcasts.
- `server/speechkit-stream.js`: SpeechKit gRPC streaming session.
- `server/article-extractor.js`: spoken article parsing.
- `server/discount-detector.js`: spoken discount parsing.
- `server/moysklad.js`: MoySklad API client.
- `server/vk.js`: VK publishing and comment polling.
- `server/telegram.js`: Telegram notifications and confirmations.
- `server/config.js`: environment-driven config.
- `server/safe-mode.js`: process-wide safe mode state and write guards.
- `server/session-log.js`: per-stream Markdown session log writer.
- `server/logger.js`: JSON console/file logger.
- `server/version-check.js`: startup check against GitHub Releases that prints
  a console banner when local `package.json` version is behind the latest tag.
  Disabled by `DISABLE_UPDATE_CHECK=1`.
- `.github/workflows/release.yml`: on push to `main`, auto-bumps patch version
  (or honors a manual bump in `package.json`) and publishes the matching
  `vX.Y.Z` GitHub Release. Skips itself on commits containing `[skip ci]`.
- `Dockerfile`: Node 20 production image for the MVP.
- `docker-compose.yml`: local one-service runtime, `.env` injection, port
  mapping, and `logs/` bind mount.
- `start-docker.command`: macOS double-click Docker launcher with first-run
  minimal `.env` setup.

# Verified commands

Only use commands backed by repo config:
- `npm start` runs `node server/index.js`.
- `docker compose --env-file .env up --build` builds and runs the Dockerized
  MVP.

`npm install` is valid for installing dependencies from `package-lock.json`, but
it is not a verification command.

No verified test, lint, standalone build, Redis, or SQLite migration commands
exist in repo yet. Do not invent them. The only CI in the repo is the auto
release workflow described above; do not add unrelated jobs to it.

# Release process

Versions follow `package.json` `version` ↔ git tag `vX.Y.Z`. The release
workflow runs on every push to `main`:

- For routine commits, it bumps patch automatically and tags the result.
- For minor or major bumps, edit `version` in `package.json` in the same push;
  the workflow will use that value verbatim.

The startup banner in `server/version-check.js` relies on this convention — if
the workflow is disabled or tags are created out of band, the check will
silently no-op rather than fail the server.

# Environment and runtime assumptions

Runtime depends on `.env` values. `server/config.js` currently requires at
least `YANDEX_SPEECHKIT_API_KEY` at startup.

Several integrations are optional at code level and degrade to skipped actions
when not configured, but STT startup is not optional.

Logs write to `logs/server.log`; stream session summaries write to
`logs/sessions/*.md`.

Docker runtime uses the host `.env` file and bind-mounts host `./logs` to
container `/app/logs`. Browser microphone access still happens in the host
browser through `http://localhost:<PORT>`, not inside the container.

HTTP surface:
- `GET /` serves `web-ui/index.html`.
- `GET /health` returns `{ ok: true }`.
- `GET /api/safe-mode` returns current safe mode state.
- `POST /api/safe-mode` accepts JSON `{ "enabled": true|false }`.

Web UI sends microphone PCM frames over WebSocket. It also lets the operator
choose a microphone, enter or persist a VK live video URL, start/stop streaming,
view transcript/session state, and toggle safe mode.

# Product context

Project goal unchanged: voice-assisted live-commerce workflow for VK.

Implemented or partially implemented integrations in code:
- Yandex SpeechKit Streaming API.
- YandexGPT fallback configuration for article extraction.
- VK API for live comment read/publish flow.
- MoySklad API for product lookup and reservation orders.
- Telegram Bot API for operator notifications and confirmations.

# Working rules for future sessions

Prefer minimal changes inside existing modules. Repo already has working JS
implementation patterns; follow them unless user asks for refactor.

Do not assume planned architecture from spec is already present. In
particular, Redis, SQLite, TypeScript, and Python audio-driver code are
described in spec but not present in this repo state. Docker Compose is present
only as a local packaging/runtime wrapper for the current Node.js MVP.

Before adding new commands to this file, verify them from `package.json` or
other executable config first.

Before changing reservation behavior, trace `activeLot`, `primaryReservation`,
waitlist event status, `customerOrderSessionVersion`, and safe mode handling in
`server/ws-server.js`.

Before changing article or discount parsing, check both regex/number-word logic
and YandexGPT fallback behavior where applicable.

If docs or code drift from spec later, keep this file aligned with verified
repository state and note missing planned pieces explicitly.
