# Repository instructions

Read [knowledge/wiki/index.md](knowledge/wiki/index.md) before non-trivial
project work. Keep durable project knowledge in the Obsidian wiki instead of
expanding this file with reference material.

## Source of truth

- `Amberry_Voice_Technical_Specification.md` is the product source of truth for
  scope, business rules, and Russian terminology.
- Current code is the source of truth for implemented behavior.
- If docs and code disagree, trust current code for implementation details and
  record the mismatch in [documentation-drift](knowledge/wiki/documentation-drift.md).
- Preserve product terms and external API names exactly when adding code or
  docs.

## Current runtime

V-Amber is a runnable Node.js MVP, not a spec-only repository. The maintained
architecture map is in [repo-map](knowledge/wiki/repo-map.md) and
[runtime-architecture](knowledge/wiki/runtime-architecture.md).

Do not treat these as source files:

- `node_modules/`
- `logs/`
- `.env`

## Verified commands

Use commands backed by repository config:

```bash
npm install
npm start
npm test
docker compose --env-file .env up --build
```

`npm start` runs `node server/index.js`. `npm test` runs Node's built-in test
runner over `test/**/*.test.js`. More command notes live in
[operational-commands](knowledge/wiki/operational-commands.md).

## Working rules

- Prefer minimal changes inside existing modules and follow current JavaScript
  patterns unless the user asks for a refactor.
- **Avoid "God Modules"**: Maintain files within a reasonable size (ideally < 800 lines). If a file grows beyond this, refactor into domain-driven sub-modules (e.g., in a `domain/` directory).
- Do not assume planned architecture from the specification is implemented.
  Redis, SQLite, TypeScript, and Python audio-driver code are not part of the
  current runtime.
- Before adding new commands to docs, verify them from `package.json` or other
  executable config.
- Before changing reservation behavior, trace `activeLot`,
  `primaryReservation`, waitlist event status, `customerOrderSessionVersion`,
  and safe mode handling in `server/ws-server.js`.
- Before changing article, price, or discount parsing, check rule-based parsing
  and MoySklad product-code cache behavior.
- When changing external write behavior, keep safe mode blocking explicit.

## Obsidian workflow

The full agent contract for working with the wiki — log entry format, new-page
vs append rules, filename conventions, wikilink hygiene, raw-note contract,
and the documentation-drift workflow — lives in
[obsidian-knowledge-base](knowledge/wiki/obsidian-knowledge-base.md). Read it
before touching the wiki. The short version:

- `knowledge/raw/` is append-only source material; `knowledge/wiki/` is
  maintained synthesis; `knowledge/wiki/index.md` and `log.md` are the entry
  point and chronological record.
- Lowercase, kebab-cased filenames; never store secrets in the wiki.
- When durable knowledge is discovered, update the relevant page and append a
  short entry to [log](knowledge/wiki/log.md).

