# Operator feedback

This page contains durable operator requests and observations from test
sessions. The original source note remains at root as `Пожелания оператора.md`;
this page is the maintained wiki version.

## Requests from 2026-05-24 testing

- ~~Support reservation quantity: buyer writes `бронь 00588 2 шт`, and the
  system reserves two units. Default quantity remains one.~~ Resolved
  2026-05-25: `server/reservation-parser.js` extracts `шт/x/*/пара`,
  clamps to `[1, 10]`, plumbed through ws-server reservation event and
  MoySklad customer-order positions. See
  [[reservation-flow#Accepted comment formats]].
- Make [[wishlist]] clearer for buyers by explaining the `список <код>` command.
- Avoid public comment noise for wishlist and service confirmations. Prefer VK
  direct messages when possible. See [[vk-comments]].
- Publish a VK lot card with price immediately when the operator says code and
  price in one phrase. See [[voice-price-parsing]].
- Improve short numeric price recognition. `цена два пять пять ноль` should
  produce `2550 ₽`, not `2 ₽`.
- Update visible stock immediately after a reservation adds a position to an
  order. See [[stock-synchronization]].

## Observations

- ~~Repeating an already reserved article can create a new lot and a new order
  position because the system protects against overselling with
  `availableStock`.~~ Resolved 2026-05-25: `mergeSameCodeRedetection` in
  `server/ws-server.js` keeps the same `lotSessionId` and reservations when
  the operator repeats the same code. See [[reservation-flow#Same-code
  re-detection]].
- If MoySklad stock is unknown, reservation can still pass.
- VK comments from the project's own group must be ignored by reservation
  handling so service comments are not processed as buyer actions.

## Operator-audit pass (2026-05-29)

A full operator-perspective audit produced 20 items split across Phase 1
(UI-only) and Phase 2 (backend-touching). 18 of the 20 landed; two
deferred for safety reasons.

**Phase 1 — UI changes (commit `f5c3bde`):**

- Inline non-blocking banner replaces `window.confirm` for product-code
  cache load at session start (remember-choice flag in localStorage).
- Wishlist row delete is now a two-step inline confirm strip; auto-revert
  after 4 seconds. No more blocking `window.confirm`.
- VK live URL input is visible by default. The `+ VK` toggle is hidden.
- Connection-drop banner with `Перезапустить` button on unexpected WS
  close.
- Microphone selection persists in localStorage.
- Friendlier Russian event-log messages on stream lifecycle changes.
- Space toggles start/stop (outside form fields); Esc closes the
  topmost open modal.
- Low-stock cues: `осталась последняя`, `осталось N`, `нет в наличии`
  with amber → red coloring.
- Lot-age pill next to the active-lot title, updated every 30 s; amber
  after 10 minutes.
- Reservation digest modal: `Сегодня` and `Вчера` quick buttons (the
  latter closes the post-midnight broadcast gap).
- sendLogs modal: explicit "архив не содержит .env и токены доступа".
- Post-stop banner with lot count, reservation count, and revenue;
  one-click into the digest modal.

**Phase 2 — Backend changes (same commit):**

- WS upgrade rejects a second connection with HTTP 409 (override with
  `?force=1`). Prevents double-publish to VK from a stray second tab.
- `/login` HTML form for API_TOKEN replaces the bare-text 401.
  Unauthenticated non-`/api/*` requests now 302 to `/login`.
- `closeLot` WS message + `× закрыть лот` button — operator-driven
  lot close without ending the session.
- `setLotPrice` WS message + click-to-edit on the lot price field —
  immediate workaround for the open "цена два пять пять ноль = 2 ₽"
  voice-detector bug. Overwrites both `salePrice` and `voicePrice`,
  marks `priceSource: "manual"`, republishes the VK card.
- Client-side per-buyer running total ("итого N брони, X ₽") in the
  reservation list, based on `state.eventsByLot` snapshots.
- End-of-stream recap derived from the same snapshots — no backend
  state-shape changes.

**Deferred (separate PRs, need integration test scaffolding):**

- Manual code entry mid-stream (#14) — interacts with `mergeSameCode
  Redetection`, trigger window, and stock guard. Risk of regression in
  the live-commerce voice pipeline without WS-session integration
  tests, which don't exist yet.
- Cancel reservation from the UI (#16) — reverses MoySklad
  customer-order positions. Touches real money flow and needs explicit
  idempotency design for partial-fail in МойСклад.

**Still open from earlier feedback (2026-05-24):**

- Public-comment noise: wishlist confirmation and other service
  responses still publish as VK comments instead of DMs in some
  branches.
- Short numeric price recognition (`цена два пять пять ноль → 2 ₽`)
  — the voice-detector bug remains; the new manual-price override is a
  workaround, not a fix.
- Public wishlist hint: no auto-post of the `СПИСОК <код>` instruction
  during a broadcast.

## Operator wishes 2026-05-30 (Roman — multi-lot + waiting list)

Source: VK DM screenshots from Роман Васильев. Six requests, with the
operator's clarifying answers captured in-session.

- **W1 — lots stay open through the whole broadcast.** Today the model is
  single-active-lot: naming a new code closes the previous lot via
  `publishLotClosed(..., "stale_detection")` (`server/ws-server.js`
  ~1549/1583) and dumps pending reservations to `orphan_waitlist`. The
  operator wants every named lot to remain bookable by its code until the
  broadcast ends. This is a model change (single `activeLot` → registry of
  open lots), touching reservation routing (`preferredCode`), per-lot stock
  / `committedReservationCount`, VK cards, and close paths. Overlaps
  deferred #14 and needs WS-session integration tests.
- **W2 — lots close only at end of broadcast.** Keep `stream_stop` /
  `stream_end` mass close; remove the mid-air `stale_detection` auto-close.
- **W3 — voice cancel.** Operator says e.g. "Галина Прокофьева отмена
  лота #033322". Clarified: this cancels **that buyer's reservation**
  (not the whole lot) — reuse the existing `cancelReservation` path
  (`server/ws-server.js` ~2044), matching the event by viewer name + code.
  Wants voice trigger **plus** a UI button (the `× закрыть лот` /
  `cancelReservation` buttons already exist).
  - **Persistent name cache (operator-requested).** Resolving the spoken
    name needs a `viewerId → name` cache that survives stop/start of a
    broadcast and process restart — the in-memory `customerOrdersByViewerId`
    and lot state are wiped on socket close (`server/ws-server.js` ~623),
    so after a restart they cannot resolve names. New
    `server/name-cache-store.js`, append-only `logs/viewer-names.jsonl`,
    modelled on `server/wishlist-store.js` (`load()` on start folds events
    to last-name-per-viewerId). Records every VK name resolved at the
    profile-resolution point (`server/ws-server.js` ~894), not only
    reservers, so it accumulates across broadcasts and recognises repeat
    buyers immediately. Store a normalised form (lowercase, ё→е, tokens)
    for matching; matching logic in a small `server/name-matcher.js` like
    `server/article-extractor.js`, tolerant of declensions ("Галину
    Прокофьеву") and word order. Cancel flow: speech → normalise → match
    cache → resolve viewerId → find reservation by code → **highlight the
    row** → operator confirms with the button (no silent voice-triggered
    money mutation). PII: keep `logs/viewer-names.jsonl` out of the
    sendLogs bundle.
- **W4 — bare code reserves.** Already satisfied; see [[reservation-flow]].
- **W5 — overflow goes to the waiting list.** Partly done: the stock
  guard already calls `addWishlistFromComment(lot, event,
  "out_of_stock_reservation")` (`server/ws-server.js` ~589) with status
  `out_of_stock`, so over-cap `бронь` lands in [[wishlist]] instead of
  closing the lot.
- **W6 — waiting-list columns + manual mode.** Wanted columns: Товар,
  Кол-во, Поставщик, Человек заказавший — mostly present in wishlist
  already. "В ручном режиме пока": do **not** auto-message overflow
  buyers — verify `notifyReservationStatus` does not post a public VK
  reply for `out_of_stock`.

Operator's answers to open design questions:

1. Voice "отмена лота #код" = cancel that buyer's reservation (option Б).
2. Do not run a poller per lot. Hold open lots in an in-memory
   cache/registry, keep a **single** comment poller (comments arrive on
   the live video/post, not per-lot), and route each comment to the
   matching open lot by code. Extra VK cost is the one-time lot-card
   publish, not polling.
3. A lot stays open until end of broadcast even at stock 0; further
   `бронь` over the cap go to the waiting list.

## Related pages

- [[live-commerce-flow]]
- [[reservation-flow]]
- [[web-dashboard]]
- [[wishlist]]
- [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]]
