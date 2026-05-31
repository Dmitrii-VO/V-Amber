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

Use the Amberry39-style vault structure:

- `knowledge/raw/` stores append-only source material and redacted evidence.
- `knowledge/wiki/` stores maintained wiki pages.
- `knowledge/wiki/index.md` is the wiki entry point.
- `knowledge/wiki/log.md` is the maintenance record.
- `templates/` stores reusable Obsidian note templates.

When durable knowledge is discovered, update the relevant wiki page and append
a short entry to [log](knowledge/wiki/log.md). Keep maintained wiki filenames
lowercase and kebab-cased.

Do not store secrets, tokens, credentials, or private customer data in the
wiki. Use redacted examples and references to secure local files instead.

