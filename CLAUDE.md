# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See [AGENTS.md](AGENTS.md) for the authoritative repository notes: verified commands, current implementation state, module map, product context, and working rules for AI sessions. This file extends those notes with Claude Code-specific guidance only.

## Running the project

```bash
npm install     # install dependencies from package-lock.json when needed
npm start       # node server/index.js - the only verified runtime command
docker compose --env-file .env up --build  # Docker Desktop runtime
```

Open `http://localhost:8080` in a browser after starting. Select a microphone and click Start.

Mandatory at startup: `YANDEX_SPEECHKIT_API_KEY` in `.env`. Missing it crashes on launch. All other integrations (VK, MoySklad, Telegram) degrade gracefully when not configured.

For macOS one-click Docker startup, use `start-docker.command`. It checks Docker
Desktop, creates a minimal `.env` on first run, builds the image, starts
Compose, and opens the browser.

## Architecture in one paragraph

Most business orchestration lives in `server/ws-server.js`. It owns the active-lot state machine, VK comment polling, reservation queue, safe mode broadcasts, discount application, and per-session logging. The browser (`web-ui/app.js`) streams raw PCM audio over WebSocket; the server forwards it to Yandex SpeechKit via gRPC (`speechkit-stream.js`), extracts product article codes from final transcripts (`article-extractor.js`), detects spoken discounts (`discount-detector.js`), looks up inventory in MoySklad, publishes lot cards to VK, and notifies the operator via Telegram. Runtime state is in-memory and is lost on restart; durable output is limited to `logs/server.log` and `logs/sessions/*.md`.

## Key flows

| Flow | Entry point |
|------|------------|
| New lot opened (voice code detected) | `ws-server.js` → `article-extractor.js` → `moysklad.js` → `vk.js` |
| Reservation received (VK "бронь" comment) | `vk.js` poll → `ws-server.js` → `moysklad.js` → `telegram.js` |
| Discount command (voice or Telegram) | `discount-detector.js` / `telegram.js` → `ws-server.js` → `vk.js` / `telegram.js` |
| Ambiguous article code | `ws-server.js` → `telegram.js` (await operator confirm before publishing) |
| Safe mode toggle | `web-ui/app.js` or `/api/safe-mode` → `safe-mode.js` write guards |

## HTTP surface

| Route | Behavior |
|-------|----------|
| `GET /` | Serves `web-ui/index.html` |
| `GET /health` | Returns `{ ok: true }` |
| `GET /api/safe-mode` | Returns current safe mode state |
| `POST /api/safe-mode` | Accepts `{ "enabled": true|false }` |

## Configuration

All tunable behavior is in `server/config.js` (loaded from `.env`). Add new feature flags there; never hardcode values that operators may need to adjust.

Docker Compose also reads the same `.env` file. It maps `${PORT:-8080}` from the
host to the same port in the container and bind-mounts `./logs` to `/app/logs`.

## Russian domain terms

Preserve these exactly in code, logs, and comments:

- **Артикул** — product article/code (the number spoken during livestream)
- **Лот** — active lot (product + session context)
- **Бронь** — reservation keyword detected in VK comments
- **Оператор** — livestream host
- **МойСклад** — external inventory/CRM service

## Caveats for code changes

- No test suite exists. Verify changes by running `npm start` and exercising the flow manually.
- Before changing lot lifecycle logic in `ws-server.js`, trace `activeLot`, `primaryReservation`, waitlist event status, `customerOrderSessionVersion`, and safe mode behavior through the full reservation flow. Race conditions have caused bugs here before.
- `article-extractor.js` has a regex path and a YandexGPT fallback; changes to number parsing must handle both.
- `safe-mode.js` wraps external write methods for Telegram, MoySklad, and VK. Keep write-blocking behavior explicit when adding new side effects.
- `todo.md` tracks open bugs and planned features (Russian); check it before implementing adjacent features.
- Versioning is automated: pushing to `main` triggers `.github/workflows/release.yml`, which patch-bumps `package.json` and publishes a matching `vX.Y.Z` release. For minor/major bumps, edit `version` in the same commit. The startup check in `server/version-check.js` uses the latest release tag to detect outdated installs.
