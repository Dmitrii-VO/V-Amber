# macOS launchers

V-Amber includes double-click launcher scripts for local operators on macOS.

## Local Node launcher

`start.command` starts the local Node.js runtime. On first run, it helps create
minimal `.env` configuration.

## Docker launcher

`start-docker.command` starts the Docker Desktop runtime. It builds and runs
the current Node.js MVP through Docker Compose and bind-mounts `logs/` from the
host.

## Update launcher

`update.command` downloads and installs the latest GitHub Release while
preserving `.env`, `logs/`, `node_modules/`, and `.git`.

The updater extracts the GitHub release archive with macOS `ditto` first,
falling back to `bsdtar` and then `unzip`. This avoids the older macOS `unzip`
failure seen on release archives that contain UTF-8 Cyrillic filenames such as
`Добро пожаловать.md`, where `unzip` may show `????.md` and report a misleading
`disk full?` write error.

If port `8080` is already in use, the update flow asks the operator to stop the
running V-Amber instance and retry.

Older downloaded copies may have `.command` files without executable bits or
with Apple's quarantine attribute. Fix the local copy from the project folder:

```bash
chmod +x *.command
xattr -d com.apple.quarantine *.command 2>/dev/null || true
```

After this one-time repair, double-click launchers should open normally.

## Related pages

- [[release-process]]
- [[operational-commands]]
- [[configuration-and-secrets]]
