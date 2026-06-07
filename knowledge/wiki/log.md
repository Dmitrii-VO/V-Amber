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

## [2026-05-29] maintenance | Operator audit pass

Recorded the operator-audit pass that landed UI and backend improvements:
inline product-code cache banner, non-blocking wishlist delete confirm,
visible VK live URL field, connection-drop restart banner, persisted microphone
selection, keyboard shortcuts, low-stock and lot-age indicators, digest quick
buttons and post-stop summary, API-token `/login`, single-WS guard, manual lot
close, manual price override, and per-buyer running totals.

The durable details live in [[operator-feedback]], [[web-dashboard]],
[[http-api]], [[runbooks-and-troubleshooting]], and [[testing-guide]].
Deferred backend-risk items were split into [[deferred-operator-features]]:
#14 manual code entry and #16 cancel reservation.

## [2026-05-30] feature | Manual article code entry (#14)

Landed operator manual code entry for active streams. The dashboard shows the
`код вручную` field while streaming; it sends the `manualCode` WS message, and
the server rejects codes not found in the MoySklad catalog. Integration tests
cover the active-lot scenarios, including floor=1 reservation behaviour and
same-code merge stability.

Updated [[deferred-operator-features]], [[http-api]], [[web-dashboard]], and
[[runbooks-and-troubleshooting]] for #14.

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

## [2026-05-30] feature | Waiting-list manual mode (W5/W6)

Landed the first phase of Roman's 2026-05-30 waiting-list requests. When stock
is exhausted, valid reservation overflow continues to create a wishlist entry
through `addWishlistFromComment(..., "out_of_stock_reservation")`, but
`out_of_stock` no longer publishes a public VK reply. This keeps the list
available to the operator while avoiding noisy buyer-facing comments during
manual mode.

The wishlist UI renamed the old `Зрители` column to `Заказавший` and now shows
the buyer name (`viewerName`, with `+N` for repeated seen-events). Updated
[[operator-feedback]], [[wishlist]], [[web-dashboard]], and [[vk-comments]].

## [2026-05-30] maintenance | Harden macOS updater

Investigated an operator macOS update failure from `0.1.26` to `0.1.33`.
The old updater downloaded the GitHub release but failed during `unzip` on the
Cyrillic file `Добро пожаловать.md`, showing a misleading `disk full?` message
and a mangled `????.md` filename.

Updated `update.command` to prefer macOS `ditto` for ZIP extraction, then
fallback to `bsdtar` and `unzip`, and to preserve `.git` during rsync-based
replacement. Recorded the one-time launcher permission repair:

```bash
chmod +x *.command
xattr -d com.apple.quarantine *.command 2>/dev/null || true
```

The operator reran the updater successfully and reached version `0.1.33`.
Updated [[macos-launchers]] and [[release-process]].

## [2026-05-31] analysis | Review 2026-05-30 diagnostic bundle

Reviewed `logs/v-amber-logs-2026-05-30T21-02-01-424Z.zip`: five sessions,
79 lots, 42 accepted reservations, 325 MoySklad calls, and one fresh `0.1.33`
session with 17 lots / 11 reservations / 0 MoySklad errors.

Recorded the main problems and operator wishes in
[[../raw/log-review-2026-05-30-21-02|log-review-2026-05-30-21-02]] and
summarized them in [[operator-feedback]]. The highest-signal items are VK
publish failures at stream close, `photo is undefined` on a lot card,
safe-mode visibility, stock-unknown reservations, variant-code confusion,
manual code entry as a primary workflow, faster cancellation search/voice
assist, official group identity for buyer replies, quiet DM/hidden service
notifications, quantity phrases, and continued price/discount parser work.

## [2026-05-31] ux | Type supplier names in wishlist

Changed the active wishlist `Без поставщика` row control from a native supplier
dropdown to a text input with browser suggestions from cached MoySklad
suppliers. Operators can type part of the supplier name, select the matching
suggestion, and the UI still patches the entry with the resolved `supplierId`
and `supplierName`.

Updated [[web-dashboard]] and [[wishlist]].

## [2026-05-31] maintenance | Close operator-wishes ctx session

Closed the active session plan for Roman's 2026-05-30 operator wishes. The
implementation phases are recorded as complete in the handoff, with manual
browser smoke testing for two open lots and a fresh full `npm test` left as
explicit follow-ups before release or commit.

## [2026-05-31] reliability | Fix VK close/photo and safe-mode visibility

Addressed the highest-priority runtime issues from the 2026-05-30 diagnostic
bundle review. VK lot-card publishing now uploads only complete photo objects
and omits empty attachments from `video.createComment`, preventing the
`photo is undefined` failure for products without usable images.

Stream-end lot closing now treats fatal/video-unavailable VK errors, such as
`VK API 15: video not found`, as an ended-video condition: it logs one warning
and skips close-comment publishing for the remaining open lots instead of
emitting repeated publish failures. The operator dashboard also shows a
pre-stream safe-mode banner when external writes and VK publishing are blocked.

Added `test/vk.test.js` and a WebSocket harness case for stream-stop close
publishing. Full `npm test` passes with 190 tests.

## [2026-05-31] policy | Unknown-stock and unknown-code gates

Chose the policy for stock that MoySklad refuses to number when a lot is
opened: **first slot + explicit warning**. The flow stays at floor=1 (one
buyer is accepted, matching operator intent of "I'm holding it in hand")
but the lot now carries `product.stockUnknown=true`, the operator gets
a `warning` toast about resale risk, and the UI renders an amber pill
"остаток неизвестен · риск перепродажи". Subsequent reservations on the
same lot hit `committedReservationCount > 0` and bounce to wishlist as
usual. See [[reservation-flow]].

Plugged a second silent-failure path on the voice/LLM gate. Manual entry
already rejected codes that the MoySklad catalog cache did not contain,
but the voice-confirmed path opened a lot with a null product card. The
gate now runs in `handleConfirmedDetection` for any source: if the
catalog is loaded and the chosen code is not in it, the lot is not
opened, the operator sees "Код N не найден в каталоге МойСклад", and the
event is logged as `voice_code_rejected_unknown`.

## [2026-05-31] maintenance | Consolidate Obsidian rules into one canonical page

The rules for working with the vault were split across three places —
`AGENTS.md` (Obsidian workflow section), [[project-conventions]] (Obsidian
conventions section), and [[obsidian-knowledge-base]] — and partially
duplicated. The pages also did not document things that agents actually
need to do their job:

- The exact log-entry heading shape (`## [YYYY-MM-DD] <type> | <title>`) and
  the catalog of `<type>` values.
- When to create a new page vs append to an existing one.
- When to touch `index.md`.
- Wikilink hygiene (raw-note link form, broken-link tolerance, no manual
  backlinks).
- Raw-note contract.
- Page-staleness and deletion protocol.
- The `documentation-drift.md` decision tree.

Moved all of that into [[obsidian-knowledge-base]] as the single source of
truth. `AGENTS.md` and [[project-conventions]] now keep only a short
pointer plus the no-secrets rule. No content was lost.

## [2026-05-31] parser | Stage 6 — tolerant codes and stronger price/discount

Buyer-comment routing now zero-pads short buyer codes against the open
lot. «бронь 0588» reaches a lot opened under code «00588» as long as no
other open lot is an exact match for «0588». Padding only adds leading
zeros, so codes that lose a non-zero leading digit (e.g. «10588» →
«0588») will not produce a false positive.

Price detector accepts «тысячу» (accusative singular), the common
operator pronunciation. Discount detector splits glued «30%» tokens
into «30» and «%», so «скидка 30%» and «20% скидки» now resolve to
percent discounts. New `test/discount-detector.test.js` covers the
percent-order, percent-glued, and absolute paths.

Live quantity phrases («забронируй сразу две штуки») stay deferred:
they would create reservations off speech alone, which contradicts the
voice-confirms-not-acts rule from stage 1. Needs operator decision on
which live action they should trigger.

## [2026-05-31] identity | VK service replies go through community token

Stage 5: routed all live-video `video.createComment` writes and the
matching `photos.getWallUploadServer` / `photos.saveWallPhoto` uploads
through a derived `commentToken = VK_GROUP_TOKEN || VK_ACCESS_TOKEN
|| VK_USER_TOKEN`. Operator confirmed `VK_ACCESS_TOKEN` is a community
access token, so the fallback chain lets the existing .env produce
group-identity comments without renaming the variable. Reservation
reply text now embeds the lot code, e.g. «Аня, бронь подтверждена (код
03204).», so buyers can tell which article the service reply confirms
when multiple lots are open. See [[vk-comments]].

Variant/modification ambiguity still open. `moysklad.getProductCardByCode`
queries only `entity/product?filter=code=...`. A code that lives on a
variant (modification) currently returns null and trips the unknown-code
gate above. Fixing it cleanly requires (1) a fallback to
`entity/variant?filter=code=...&expand=product`, (2) a separate stock
query against the variant's assortment href, and (3) a snapshot builder
that joins the variant's characteristic name onto the parent product
name. Left for a focused follow-up with real MoySklad fixtures.

## [2026-06-01] analysis | Analytics tracking plan

Applied the analytics-tracking workflow to the current operator dashboard.
No active analytics SDK, GTM container, `gtag`, `dataLayer`, PostHog,
Mixpanel, Amplitude, or Segment implementation was found in source files.

Added [[analytics-tracking-plan]] as the measurement contract for future
implementation. The plan prioritizes internal operator workflow events,
reservation conversions, wishlist purchase-order completion, digest sends,
safe-mode state, and redacted reliability analytics over public marketing
attribution.

Follow-up review added a required non-PII common event envelope so future
JSONL analytics can be deduplicated and joined to local diagnostic bundles.

## [2026-06-01] reliability | Complete broadcast logging trail

Hardened the logging path so diagnostic bundles can reconstruct an эфир from
session JSONL. Session filenames now include seconds, milliseconds, and a
counter to avoid rapid restart overwrites; `logger.flush()` runs before bundle
collection; `state_snapshot` records all open lots; and reservation JSONL now
separates early `reservation_detected` from final `reservation_finalized`
outcomes.

The bundle `INDEX.md` now counts accepted reservations from finalized
`reserved` / `reserved_appended` statuses instead of early comment detection,
with a legacy fallback for older `reservation_accepted` records. Updated
[[logging-and-diagnostics]] and [[testing-guide]].

## [2026-06-04] fix | VK comments live again — token routing reverted, self-ingestion closed

Log review of bundles `…2026-06-03T19-10` and `…19-44` (the эфир stopped
publishing comments and ingesting reservations).

**Root cause — supersedes the [2026-05-31] Stage 5 decision above.** That stage
routed `video.*` writes through a community-first `commentToken`. VK does not
allow video methods under a community token: once `VK_GROUP_TOKEN` was set (for
DMs) every `video.getComments` / `video.createComment` / `video.get` failed with
`error_code 27` ("Group authorization failed: method is unavailable with group
auth"). Comment polling and lot-card publishing died from 2026-06-02 on. Posting
service comments "from the community page" is simply not attainable for live
video — the user-token identity (account "Amber Standard") is the only option.
Fix: derive `videoToken = VK_USER_TOKEN || VK_GROUP_TOKEN || VK_ACCESS_TOKEN`
and use it for all `video.*` calls; the group token now serves only `messages.*`
(community DMs). Restores the pre-Stage-5 behaviour that last worked 2026-05-30.

**Self-comment re-ingestion (data-integrity bug).** The poller processed
comments authored by the bot's own VK account (id 816076245), so its reply
«… бронь подтверждена (код …)» was re-read as a fresh reservation from the bot
itself — bogus `out_of_stock`, phantom wishlist entries, and (at stock ≥2) would
have created a phantom MoySklad order on the bot account. Fix: resolve the bot's
own id via `vk.getSelfUserId()` (`users.get`, or `VK_SELF_USER_ID` override) and
skip comments where `from_id === selfUserId`. New `test/ws-server.self-comment.test.js`.

**Chat hygiene.** Dropped the internal `lotSessionId:` line from every published
comment (nothing parses it back); the lot card omits the price line when price
is 0 (operator names it by voice → `publishPriceUpdate` posts it), so no more
«Цена: 0 ₽» card.

**Operator UX.** Added a persistent voice cancel-command format hint to the
«Брони» panel. The parser stays strict (verb + «лот»/«бронь» + code, name
required) — deliberately not loosened on the money path. Shipped as v0.1.48/49.
Updated [[vk-comments]] and [[vk-integration]].

## [2026-06-08] fix | MoySklad reservation discounts stay in discount field

Fixed customer-order position payloads so discounted reservations send the
original item price in `price` and the calculated percentage in MoySklad's
`discount` field. MoySklad now owns the final `sum` calculation instead of the
integration pre-subtracting the discount from the price. Updated
[[moysklad-integration]].
