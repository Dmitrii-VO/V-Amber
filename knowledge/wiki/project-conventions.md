# Project conventions

V-Amber is a small Node.js MVP. Prefer minimal changes inside existing modules
and follow the current JavaScript style unless the user asks for a refactor.

## Code conventions

- Use JavaScript on Node.js ES Modules.
- Keep integrations optional where the current code already degrades
  gracefully, except for SpeechKit startup requirements.
- Preserve Russian product terms from the specification.
- Before changing reservations, trace `activeLot`, `primaryReservation`,
  waitlist event status, `customerOrderSessionVersion`, and safe mode behavior
  in `server/ws-server.js`.
- Before changing article, discount, or price parsing, check rule-based parsing
  and MoySklad product-code cache behavior.

## Documentation conventions

`Amberry_Voice_Technical_Specification.md`, `README.md`, `AGENTS.md`,
`CLAUDE.md`, `TODO.md`, and this wiki are active working documents even when
some are ignored by local git config.

When durable knowledge is discovered, update `knowledge/wiki/` and append a
short maintenance entry to [[log]]. Keep `AGENTS.md` and `CLAUDE.md` short:
they are operating guides, not project encyclopedias. If the evidence is a
source snapshot, add it under `knowledge/raw/`.

## Obsidian conventions

This vault follows the Amberry39 pattern:

- source snapshots live in `knowledge/raw/`;
- maintained wiki pages live in `knowledge/wiki/`;
- filenames are lowercase and kebab-cased;
- `knowledge/wiki/index.md` is the first page agents read;
- `knowledge/wiki/log.md` is the chronological maintenance record;
- templates live in `templates/`.

See [[obsidian-knowledge-base]].
