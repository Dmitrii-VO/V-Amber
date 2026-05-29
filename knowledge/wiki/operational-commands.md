# Operational commands

This page records commands confirmed by the current repository state. When this
page conflicts with older prose docs, trust `package.json` and executable
config first.

## Install dependencies

```bash
npm install
```

This installs dependencies from `package-lock.json`.

## Start local Node runtime

```bash
npm start
```

This runs:

```bash
node server/index.js
```

## Start Docker runtime

```bash
docker compose --env-file .env up --build
```

Docker runs the current Node.js MVP and bind-mounts host `./logs`.

## Run tests

```bash
npm test
```

This runs:

```bash
node --test "test/**/*.test.js"
```

Older docs still say there is no verified test command. Track that mismatch in
[[documentation-drift]].

## Service scripts

These scripts are operational utilities, not normal verification commands:

```bash
node scripts/backfill-vk-id-dry-run.js
node scripts/find-overbooked.js
node scripts/replay-safe-mode.js
node scripts/replay-safe-mode.js --apply
```

Use [[service-scripts]] for behavior and safety notes.
