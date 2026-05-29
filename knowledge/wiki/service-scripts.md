# Service scripts

`scripts/` contains one-off diagnostics and recovery helpers. They read `.env`
and are not part of the normal runtime loop.

## backfill-vk-id-dry-run

```bash
node scripts/backfill-vk-id-dry-run.js
```

Scans MoySklad counterparties, finds the `VK ID` attribute, counts already
populated values, detects `viewerId=` candidates in descriptions, and reports
duplicate groups. It is dry-run only and does not write to MoySklad.

## find-overbooked

```bash
node scripts/find-overbooked.js
```

Scans the MoySklad stock report and prints products where available stock is
negative, sorted by the largest deficits. Useful when reservation behavior or
manual corrections may have overbooked inventory.

## replay-safe-mode

```bash
node scripts/replay-safe-mode.js
node scripts/replay-safe-mode.js --log=logs/worklogs/server.log
node scripts/replay-safe-mode.js --bundle=logs/v-amber-logs-...zip
node scripts/replay-safe-mode.js --apply
```

Parses `safe-mode` `reservation_logged_only` events from `server.log`. Without
`--apply`, it prints a dry-run table. With `--apply`, it creates MoySklad
customer orders through the existing client and skips already-applied
reservations on repeat runs.

Reading ZIP bundles requires `adm-zip`; if it is unavailable, extract the
bundle manually and pass `--log=PATH`.

## Related pages

- [[moysklad-integration]]
- [[reservation-flow]]
- [[logging-and-diagnostics]]
- [[operational-commands]]
