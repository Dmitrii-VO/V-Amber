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
internet works. A direct request will not succeed no matter how it is made,
which is why the `syncId` question in [[runtime-stores]] stayed open across two
separate attempts before anyone thought to route around it.

The way around it is an SSH tunnel through a machine that does have access:

```bash
ssh -N -L 18443:api.moysklad.ru:443 <host-with-access>
curl --compressed --connect-to api.moysklad.ru:443:127.0.0.1:18443 \
  -u "$MOYSKLAD_LOGIN:$MOYSKLAD_PASSWORD" https://api.moysklad.ru/api/remap/1.2/…
```

`--connect-to` keeps the real hostname for SNI and certificate checks, and the
MoySklad credentials never leave the local machine — the tunnel carries only
encrypted TLS. Prefer this over copying credentials onto another host.

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
