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

## Related pages

- [[live-commerce-flow]]
- [[reservation-flow]]
- [[web-dashboard]]
- [[wishlist]]
- [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]]
