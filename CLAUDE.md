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
- Deploy order, and what auto-deploys vs what does not:
  1. `main` push touching `deploy/stream-viewer/**` or `deploy/chat-service/**`
     runs `ci.yml` (tests) → only then rsync to the cloud host + restart +
     health check. Tests gate the deploy; a red test suite stops it.
  2. **The V-Amber app itself never auto-deploys** — it reaches the operator's
     Mac only via release + a manual update.
  3. **`deploy/ci/ci-deploy-dispatch.sh` is installed by hand, not by CI**, and
     `deploy/ci/**` is deliberately outside the workflow's `paths:` filter.
     Editing it in the repo changes nothing on the host until it is reinstalled
     (`setup-cloud-deploy-user.sh`, or a single `install` for just that file).
     Repo and host can silently drift — compare hashes before assuming.
  Details in [stream-integration](knowledge/wiki/stream-integration.md); the
  log entries for 2026-07-16 record both ways this deploy has already broken.
- Every push to `main` triggers the Auto Release workflow
  (`.github/workflows/release.yml`), which auto-bumps the patch version and
  pushes a `chore: bump version to X.Y.Z [skip ci]` commit from
  `github-actions[bot]`, then cuts a `vX.Y.Z` GitHub release. So after any push
  the remote is one commit ahead — `git pull --rebase` before the next push.
  These bot commits only touch `package.json`; they are not a human
  collaborator. See [release-process](knowledge/wiki/release-process.md).
