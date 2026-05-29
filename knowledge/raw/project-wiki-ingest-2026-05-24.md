---
type: source-ingest
area: project-wiki
status: captured
captured: 2026-05-24
---

# project-wiki-ingest-2026-05-24

## Source

- `AGENTS.md`
- `README.md`
- `TODO.md`
- `package.json`
- `test/` file list
- `server/` file list
- `web-ui/` file list
- `server/http-server.js` route pass
- `server/index.js` service wiring pass
- `server/*store.js` runtime persistence pass
- `scripts/*.js` operational script pass
- `web-ui/app.js` dashboard workflow pass
- `Пожелания оператора.md`
- `Sources/Log review 2026-05-24 18-45.md`
- `Wiki/*.md`
- CodeGraph context for runtime modules and wishlist implementation
- Reference vault:
  `D:\myprojects\AuctionBot Amberry\Amberry39`

## What was captured

- Current V-Amber MVP boundaries and source-of-truth order.
- Backend, web UI, test, script, and runtime-data map.
- Confirmed commands from `package.json` and Docker config.
- Main live-commerce, reservation, wishlist, preorder, logging, and integration
  flows.
- Full local HTTP API surface, including wishlist, settings, MoySklad lookups,
  reservation digests, VK URL validation, and diagnostic bundle endpoints.
- Runtime persistence under `logs/`: active state, settings, wishlist events,
  wishlist submissions, reservation digest log, and install ID.
- Service scripts for VK ID backfill dry-run, overbooked-stock scan, and
  safe-mode replay.
- Operator-test findings for quantity reservations, compact spoken price
  parsing, visible stock refresh, VK comment noise, and own-group comment
  filtering.
- Documentation drift around the now-existing `npm test` command and expanded
  backend module list.
- Amberry39-style Obsidian structure: `knowledge/raw`, `knowledge/wiki`,
  `knowledge/wiki/index.md`, `knowledge/wiki/log.md`, and `templates`.

## Durable knowledge created or updated

- [[../wiki/index|Project knowledge index]]
- [[../wiki/project-overview]]
- [[../wiki/repo-map]]
- [[../wiki/project-conventions]]
- [[../wiki/obsidian-knowledge-base]]
- [[../wiki/obsidian-plugins-guide]]
- [[../wiki/runtime-architecture]]
- [[../wiki/runtime-stores]]
- [[../wiki/configuration-and-secrets]]
- [[../wiki/operational-commands]]
- [[../wiki/http-api]]
- [[../wiki/web-dashboard]]
- [[../wiki/release-process]]
- [[../wiki/macos-launchers]]
- [[../wiki/testing-guide]]
- [[../wiki/documentation-drift]]
- [[../wiki/live-commerce-flow]]
- [[../wiki/reservation-flow]]
- [[../wiki/wishlist]]
- [[../wiki/operator-feedback]]
- [[../wiki/voice-price-parsing]]
- [[../wiki/stock-synchronization]]
- [[../wiki/vk-comments]]
- [[../wiki/preorders]]
- [[../wiki/speechkit-integration]]
- [[../wiki/vk-integration]]
- [[../wiki/moysklad-integration]]
- [[../wiki/logging-and-diagnostics]]
- [[../wiki/service-scripts]]
- [[../wiki/reservation-digests]]
- [[../wiki/runbooks-and-troubleshooting]]
- [[../wiki/log]]

## Notes

Root-level `Пожелания оператора.md` was treated as existing source material.
The maintained wiki version is [[../wiki/operator-feedback]].
