# Claude Code instructions

Use [AGENTS.md](AGENTS.md) as the authoritative operating guide. Read
[knowledge/wiki/index.md](knowledge/wiki/index.md) before non-trivial project
work, and update the wiki when you discover durable project knowledge.

## Quick start

```bash
npm install
npm start
npm test
docker compose --env-file .env up --build
```

Open `http://localhost:8080` after starting. `YANDEX_SPEECHKIT_API_KEY` is
required in `.env`; VK and MoySklad degrade when not configured.

macOS launchers are documented in
[macos-launchers](knowledge/wiki/macos-launchers.md). The HTTP surface is in
[http-api](knowledge/wiki/http-api.md), release behavior is in
[release-process](knowledge/wiki/release-process.md), and architecture is in
[runtime-architecture](knowledge/wiki/runtime-architecture.md).

## Claude-specific notes

- Keep this file short. Put reference material in `knowledge/wiki/`.
- Preserve Russian domain terms from the specification: `Артикул`, `Лот`,
  `Бронь`, `Оператор`, `МойСклад`.
- Before changing lot lifecycle or reservations, follow the guardrails in
  [reservation-flow](knowledge/wiki/reservation-flow.md).
- Before changing speech parsing, check
  [voice-price-parsing](knowledge/wiki/voice-price-parsing.md),
  `server/article-extractor.js`, `server/price-detector.js`, and
  `server/discount-detector.js`.
- Every push to `main` triggers the Auto Release workflow
  (`.github/workflows/release.yml`), which auto-bumps the patch version and
  pushes a `chore: bump version to X.Y.Z [skip ci]` commit from
  `github-actions[bot]`, then cuts a `vX.Y.Z` GitHub release. So after any push
  the remote is one commit ahead — `git pull --rebase` before the next push.
  These bot commits only touch `package.json`; they are not a human
  collaborator. See [release-process](knowledge/wiki/release-process.md).
