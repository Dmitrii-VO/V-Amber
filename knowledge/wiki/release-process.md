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

`server/version-check.js` checks GitHub Releases at startup and prints a console
banner when the local `package.json` version is behind the latest tag. Set
`DISABLE_UPDATE_CHECK=1` to disable this check.

The check silently no-ops on network errors or missing releases; it must not
block server startup.

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
