# Project knowledge log

Append notable ingests, project questions, wiki maintenance passes, and durable
decisions here. Use a stable heading format so agents can scan recent changes.

## [2026-05-24] maintenance | Move V-Amber vault to Amberry39-style structure

Reworked the initial V-Amber Obsidian notes into the same structure used by
`D:\myprojects\AuctionBot Amberry\Amberry39`:

- `knowledge/raw/` for source snapshots and redacted evidence;
- `knowledge/wiki/` for maintained project knowledge;
- `knowledge/wiki/index.md` as the agent entry point;
- `knowledge/wiki/log.md` as the maintenance record;
- `templates/` for decision, incident, runbook, and source-ingest notes.

Added wiki pages for project overview, repo map, runtime architecture,
configuration, commands, tests, live-commerce flow, reservation flow, wishlist,
operator feedback, preorders, integrations, diagnostics, troubleshooting,
documentation drift, and the Amberry39-style plugin workflow guide.
Migrated the earlier `Sources/` and `Wiki/` operator-test notes into
`knowledge/raw/log-review-2026-05-24-18-45.md` plus canonical pages for voice
price parsing, stock synchronization, and VK comments.

Source note:
[[../raw/project-wiki-ingest-2026-05-24|project-wiki-ingest-2026-05-24]].

## [2026-05-24] ingest | Initial Obsidian wiki population

Created the first V-Amber wiki pass from `AGENTS.md`, `README.md`, `TODO.md`,
`package.json`, repository file lists, CodeGraph context, and the existing
operator feedback note.

## [2026-05-25] maintenance | Trim agent files into operating guides

Moved durable reference material out of `AGENTS.md` and `CLAUDE.md` into the
Obsidian wiki. Added [[http-api]], [[release-process]], and
[[macos-launchers]]. `AGENTS.md` now keeps source-of-truth order, verified
commands, key guardrails, and the Obsidian workflow. `CLAUDE.md` now contains
Claude-specific pointers only.

## [2026-05-25] cleanup | Remove legacy Obsidian draft folders

Deleted the old root-level `Sources/` and `Wiki/` Markdown notes after their
content was migrated into the Amberry39-style structure:

- source evidence now lives in
  [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]];
- maintained pages now live under `knowledge/wiki/`, including
  [[operator-feedback]], [[reservation-flow]], [[wishlist]],
  [[voice-price-parsing]], [[stock-synchronization]], and [[vk-comments]].

## [2026-05-25] maintenance | Code pass over runtime APIs and stores

Re-scanned CodeGraph, `server/http-server.js`, `server/index.js`, runtime
stores, service scripts, and `web-ui/app.js`. Updated wiki with current HTTP
surface, dashboard workflows, runtime persistence stores, reservation digests,
and service scripts. Added [[runtime-stores]], [[web-dashboard]],
[[service-scripts]], and [[reservation-digests]].

## [2026-05-25] decision | Scope live order merging to broadcast day

Recorded the rule that live MoySklad customer-order merging is limited to one
calendar broadcast day per buyer. The first reservation for a buyer creates an
order with a daily `#Эфир YYYY-MM-DD` marker; later reservations from the same
day may append only to an order with that marker. Older open or unpaid orders
without the marker stay separate.

## [2026-05-30] feature | Cancel reservation from the dashboard (#16)

Landed the last deferred operator-audit item. WS `cancelReservation`,
MoySklad `removePositionFromOrder` (exact-id `DELETE`, safe-mode wrapped,
404 = idempotent), per-row `× отменить` button, and
`test/ws-server.cancel-reservation.test.js`. Updated
[[deferred-operator-features]] (moved #16 to landed with the failure-mode
design record), [[reservation-flow]] ("Cancelling a reservation"),
[[http-api]], [[web-dashboard]], [[runbooks-and-troubleshooting]], and the
wiki [[index]]. No deferred operator-audit items remain.

## [2026-05-30] feature | Start Phase 3 multi-lot runtime

Changed the runtime from a single active lot to a current `activeLot` plus an
`openLotsBySessionId` registry. Opening a different code keeps previous lots
open, one VK comment poller routes reservations by product code across open
lots, `stale_detection` no longer auto-closes late detections, and
`stream_stop`/`stream_end`/errors/socket close bulk-close all open lots.
`logs/active-state.json` now persists `openLots` for crash-recovery orphan
scans. Updated [[reservation-flow]] and `PLAN.md`; full `npm test` passes.

Follow-up UI pass: `web-ui` now renders `#openLotsList`, marks the current
active lot, lets the operator close a specific open lot by `lotSessionId`/code,
and renders reservations from all open lots with lot-aware cancel actions.
Updated [[web-dashboard]]. Full `npm test` passes.

Final Phase 3 guard: added an integration test for overflow on an inactive
open lot. With current `activeLot` on a different code, a previous open lot
with stock 1 accepts the first buyer and sends the second buyer to
`out_of_stock`/wishlist. Full `npm test` passes with 185 tests.
