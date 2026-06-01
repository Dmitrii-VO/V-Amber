# Logging and diagnostics

V-Amber records both machine-readable and operator-readable evidence. Logs are
runtime data, but redacted findings can become `knowledge/raw/` source notes.

## Server logs

Use server logs for low-level runtime diagnostics and for events that are not
attached to an active broadcast session.

`server/logger.js` writes JSON logs to console and `logs/server.log`.
`server.log` rotates at configured size and rotated copies are included in log
bundles. The diagnostic bundle path calls `logger.flush()` before reading log
files so the most recent server log records are included when the operator
downloads logs immediately after an incident.

## Session logs

Use session logs as the main source for reconstructing a broadcast after the
fact. The Markdown file stays human-readable, and the JSONL file carries the
machine-readable event stream.

`server/session-log.js` writes Markdown summaries under `logs/sessions/*.md`.
Session filenames include seconds, milliseconds, and a process-local counter so
rapid stop/start cycles do not overwrite earlier session files.

`server/session-jsonl.js` adds structured session event logs under
`logs/sessions/*.jsonl`. Each event carries the active `connectionId` when a
session is running. Important broadcast events include:

- `session_started` and `session_ended`;
- `transcript_final`;
- `lot_opened`, `lot_closed`, and `lot_price_changed`;
- `manual_code_submitted`;
- `vk_comment`;
- `reservation_detected` for the first parsed buyer comment;
- `reservation_finalized` for the final outcome, such as `reserved`,
  `reserved_appended`, `waitlist_pending`, `out_of_stock`,
  `safe_mode_logged`, `order_failed`, `product_not_found`, `cancelled`, or
  `stale_discarded`;
- `reservation_quantity_appended`;
- `moysklad_call` routed through the diagnostic router while a session is
  active;
- `state_snapshot`, which includes all open lots, not only the current
  active lot.

`reservation_accepted` is a legacy JSONL name from older bundles. Treat it as
an early comment-detection fallback only, not proof that MoySklad accepted a
reservation.

`server/reservation-digest-log.js` stores sent reservation-digest records so
the system can avoid sending the same VK DM summary twice for the same day,
viewer, and digest hash.

## Diagnostic bundle

Use the diagnostic bundle when you need one ZIP that explains what happened in
an operator session.

`server/log-bundle.js` collects logs, session files, wishlist data, settings,
install ID, version, integration flags, and user note into a ZIP. The HTTP UI
exposes preview and download endpoints.

The bundle also includes wishlist events/submissions and settings when the
corresponding stores are available.

`server/bundle-index.js` generates a Markdown index for bundle contents. Its
"Броней принято" count prefers `reservation_finalized` statuses and counts
only `reserved` / `reserved_appended` as accepted. For old bundles without
final statuses, it falls back to legacy `reservation_accepted` records.

## Install ID

`server/install-id.js` persists a per-installation UUID in `logs/install-id` to
deduplicate bug reports.

## Related pages

- [[runbooks-and-troubleshooting]]
- [[operator-feedback]]
- [[wishlist]]
- [[reservation-digests]]
- [[runtime-stores]]
