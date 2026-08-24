# Release process

V-Amber versions follow the `package.json` `version` and git tag convention
`vX.Y.Z`.

## GitHub Actions release workflow

`.github/workflows/release.yml` runs on every push to `main`:

- Routine commits auto-bump the patch version and publish the matching release.
- If `package.json` already contains a manual version change, the workflow uses
  that version verbatim. Use this path for minor or major bumps.
- Commits containing `[skip ci]` are skipped by the workflow.

## Startup version check

`server/version-check.js` checks GitHub Releases at startup, compares with the
local `package.json` version and reports the result three ways: a console
banner, the `update` field of `/health`, and a badge in the dashboard header.
Set `DISABLE_UPDATE_CHECK=1` to disable it.

Statuses: `update_available`, `current`, `check_failed` (with `reason`),
`disabled`. `getUpdateStatus()` returns the last result; `/health` serves it and
the dashboard renders it.

**Console alone was not enough (fixed 2026-08-24).** The banner goes to the
Terminal, but `start.command` opens the browser 1.5 s later and the logger
prints every line to that same console — the banner is buried within seconds and
the operator, who works in the dashboard, never sees it. Hence the header badge:
amber «↑ версия X — обновить» with the update instruction in the tooltip, and a
muted «обновления не проверены» when the check failed, so silence cannot mean
both "up to date" and "GitHub did not answer" (its unauthenticated rate limit is
easy to hit from one IP).

**The check never actually fired before 2026-08-24.** `parseVersion` split the
string on `[.+-]` and took element `[0]`, so «0.1.104» parsed as «0» and every
version became `0.0.0` — comparison always said "equal". That is why production
sat on 0.1.71 while the repository was at 0.1.103. The class is now `[+-]`
(pre-release/build suffix only), covered by `test/version-check.test.js`.

## Operator update path

`update.command` downloads the latest GitHub Release, applies files over the
current folder, preserves `.env`, `logs/`, `node_modules/`, and `.git`, then
runs `npm install`.

On macOS, release archives should be extracted with `ditto` before falling back
to `bsdtar` or `unzip`; this keeps updates working when the archive contains
UTF-8 filenames. An operator update from `0.1.26` to `0.1.33` confirmed the
fixed flow after the old `unzip` path failed on `Добро пожаловать.md`.

## Related pages

- [[operational-commands]]
- [[macos-launchers]]
- [[runtime-architecture]]
