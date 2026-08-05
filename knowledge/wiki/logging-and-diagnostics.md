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

Test runs (`node --test` sets `NODE_TEST_CONTEXT`) write to
`logs/server.test.log` instead, so `npm test` no longer pollutes the real
server log. `V_AMBER_LOG_FILE` overrides the path entirely — but log bundles
only collect `logs/server.log*`, so an override diverts logs out of bundles.

### Flood suppression in `reservation_no_open_lot`

Since v0.1.70, bursts of "code without an open lot" comments (in-stream
giveaways: viewers post hundreds of bare 3-digit numbers, e.g. 987 warns in
ten minutes on 2026-07-25) are rate-limited by `server/comment-flood-guard.js`:
past 8 events per 60s window the per-comment WARN and dashboard
`reservationAttention` are suppressed. When reading logs, expect one
`reservation_no_open_lot_flood` warn at burst start and a
`reservation_no_open_lot_flood_ended` summary carrying `suppressed` count plus
the first 50 suppressed events (`commentId`/`viewerId`/`code`/`source`) — those
samples stand in for the individual lines during recovery analysis. Ambiguous
matches against *open* lots always bypass the guard and keep their full WARN.

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
- `transcript_partial` — the interim SpeechKit hypotheses that precede a final,
  with `seq` counting them within one utterance (reset on the final). Repeats of
  an unchanged text are dropped before logging, since SpeechKit re-sends a
  partial even when nothing changed. Until 2026-08-05 partials only ever reached
  the operator's screen, so any question about what STT saw *before* the final —
  including "should a lot open on an interim result?" — was unanswerable even in
  hindsight: six эфир bundles contained 19 393 events and not one partial;
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
only `reserved` / `reserved_appended` as accepted. Because `reservation_finalized`
is append-only (a reservation is re-finalized as `cancelled` when the operator
cancels it), the count keeps only the **latest** status per stable reservation
key (`lotSessionId` + `commentId` + `viewerId` + `positionId`) — so a cancelled
reservation drops out of "принято", and cancelling one of a buyer's two
positions leaves the other counted. For old bundles without final statuses, it
falls back to legacy `reservation_accepted` records.

## Install ID

`server/install-id.js` persists a per-installation UUID in `logs/install-id` to
deduplicate bug reports.

## Related pages

- [[runbooks-and-troubleshooting]]
- [[operator-feedback]]
- [[wishlist]]
- [[reservation-digests]]
- [[runtime-stores]]
