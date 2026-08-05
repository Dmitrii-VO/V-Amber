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

## Dev machine limits

`api.moysklad.ru`, `online.moysklad.ru`, and `dev.moysklad.ru` are **unreachable
from the Windows dev machine** — TCP connect times out, while the rest of the
internet works. So MoySklad API behavior cannot be verified from the repo
machine, no matter how the request is made; assumptions about the API have to
be settled on the operator's Mac or left explicitly marked as unverified. This
is why the `syncId` upsert question in [[runtime-stores]] stayed open across
two separate attempts.

## Documentation conventions

`Amberry_Voice_Technical_Specification.md`, `README.md`, `AGENTS.md`,
`CLAUDE.md`, `TODO.md`, and this wiki are active working documents even when
some are ignored by local git config. Keep `AGENTS.md` and `CLAUDE.md` short:
they are operating guides, not project encyclopedias.

## Obsidian conventions

The canonical workflow for the Obsidian vault — structure, log entry format,
new-page vs append rules, wikilink hygiene, raw-note contract, and the
documentation-drift protocol — lives in [[obsidian-knowledge-base]]. This
page intentionally does not duplicate that content; read the canonical page
before touching the wiki.
