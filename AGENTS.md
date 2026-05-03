# Repository notes

Repo no longer spec-only. Current tree contains runnable MVP prototype:
- `server/` Node.js backend on ESM modules.
- `web-ui/` static browser UI for microphone control and session status.
- `package.json` with single verified runtime command: `npm start`.
- `.env` for secrets, `logs/` for runtime logs, `todo.md` for product notes.

Do not treat `node_modules/`, `logs/`, or `.env` as source files.

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
- MoySklad integration for product lookup and customer order reservation.
- VK integration for live comment polling, lot-card publishing, and reservation
  handling.

Main entrypoints and modules:
- `server/index.js`: starts HTTP server.
- `server/http-server.js`: serves `web-ui/` assets.
- `server/ws-server.js`: WebSocket session flow, active lot state, VK comments,
  reservations.
- `server/speechkit-stream.js`: SpeechKit gRPC streaming session.
- `server/article-extractor.js`: spoken article parsing.
- `server/moysklad.js`: MoySklad API client.
- `server/vk.js`: VK publishing and comment polling.
- `server/telegram.js`: Telegram notifications and confirmations.
- `server/config.js`: environment-driven config.

# Verified commands

Only use commands backed by repo config:
- `npm start` runs `node server/index.js`.

No verified test, lint, build, Docker Compose, Redis, SQLite migration, or CI
commands exist in repo yet. Do not invent them.

# Environment and runtime assumptions

Runtime depends on `.env` values. `server/config.js` currently requires at
least `YANDEX_SPEECHKIT_API_KEY` at startup.

Several integrations are optional at code level and degrade to skipped actions
when not configured, but STT startup is not optional.

Logs write to `logs/server.log`.

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
particular, Redis, SQLite, Docker Compose, TypeScript, and Python audio-driver
code are described in spec but not present in this repo state.

Before adding new commands to this file, verify them from `package.json` or
other executable config first.

If docs or code drift from spec later, keep this file aligned with verified
repository state and note missing planned pieces explicitly.
