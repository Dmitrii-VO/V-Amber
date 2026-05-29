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
preserving `.env`, `logs/`, and `node_modules/`.

If port `8080` is already in use, the update flow asks the operator to stop the
running V-Amber instance and retry.

## Related pages

- [[release-process]]
- [[operational-commands]]
- [[configuration-and-secrets]]
