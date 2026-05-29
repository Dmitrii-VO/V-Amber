# Logging and diagnostics

V-Amber records both machine-readable and operator-readable evidence. Logs are
runtime data, but redacted findings can become `knowledge/raw/` source notes.

## Server logs

`server/logger.js` writes JSON logs to console and `logs/server.log`.
`server.log` rotates at configured size and rotated copies are included in log
bundles.

## Session logs

`server/session-log.js` writes Markdown summaries under `logs/sessions/*.md`.
These are useful source evidence for operator tests and incident analysis.

`server/session-jsonl.js` adds structured session event logs.

`server/reservation-digest-log.js` stores sent reservation-digest records so
the system can avoid sending the same VK DM summary twice for the same day,
viewer, and digest hash.

## Diagnostic bundle

`server/log-bundle.js` collects logs, session files, wishlist data, settings,
install ID, version, integration flags, and user note into a ZIP. The HTTP UI
exposes preview and download endpoints.

The bundle also includes wishlist events/submissions and settings when the
corresponding stores are available.

`server/bundle-index.js` generates a Markdown index for bundle contents.

## Install ID

`server/install-id.js` persists a per-installation UUID in `logs/install-id` to
deduplicate bug reports.

## Related pages

- [[runbooks-and-troubleshooting]]
- [[operator-feedback]]
- [[wishlist]]
- [[reservation-digests]]
- [[runtime-stores]]
