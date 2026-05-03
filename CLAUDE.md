# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See [AGENTS.md](AGENTS.md) for the authoritative repository notes: verified commands, current implementation state, module map, product context, and working rules for AI sessions. This file extends those notes with Claude Code-specific guidance only.

## Running the project

```bash
npm start       # node server/index.js — the only verified command
```

Open `http://localhost:8080` in a browser after starting. Select a microphone and click Start.

Mandatory at startup: `YANDEX_SPEECHKIT_API_KEY` in `.env`. Missing it crashes on launch. All other integrations (VK, MoySklad, Telegram) degrade gracefully when not configured.

## Architecture in one paragraph

All business logic lives in `server/ws-server.js`. It owns the active-lot state machine and reservation queue in memory. The browser (`web-ui/app.js`) streams raw PCM audio over WebSocket; the server forwards it to Yandex SpeechKit via gRPC (`speechkit-stream.js`), extracts product article codes from final transcripts (`article-extractor.js`), looks up inventory in MoySklad, publishes lot cards to VK, and notifies the operator via Telegram. State is entirely in-memory — it is lost on restart.

## Key flows

| Flow | Entry point |
|------|------------|
| New lot opened (voice code detected) | `ws-server.js` → `article-extractor.js` → `moysklad.js` → `vk.js` |
| Reservation received (VK "бронь" comment) | `vk.js` poll → `ws-server.js` → `moysklad.js` → `telegram.js` |
| Operator command (Telegram) | `telegram.js` → `ws-server.js` state mutation |
| Ambiguous article code | `ws-server.js` → `telegram.js` (await operator confirm before publishing) |

## Configuration

All tunable behavior is in `server/config.js` (loaded from `.env`). Add new feature flags there; never hardcode values that operators may need to adjust.

## Russian domain terms

Preserve these exactly in code, logs, and comments:

- **Артикул** — product article/code (the number spoken during livestream)
- **Лот** — active lot (product + session context)
- **Бронь** — reservation keyword detected in VK comments
- **Оператор** — livestream host
- **МойСклад** — external inventory/CRM service

## Caveats for code changes

- No test suite exists. Verify changes by running `npm start` and exercising the flow manually.
- Before changing lot lifecycle logic in `ws-server.js`, trace `activeLot`, `primaryReservation`, and waitlist Map through the full reservation flow — race conditions have caused bugs here before.
- `article-extractor.js` has a regex path and a YandexGPT fallback; changes to number parsing must handle both.
- `todo.md` tracks open bugs and planned features (Russian); check it before implementing adjacent features.
