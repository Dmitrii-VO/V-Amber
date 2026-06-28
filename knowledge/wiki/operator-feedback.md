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
- ~~VK comments from the project's own group must be ignored by reservation
  handling so service comments are not processed as buyer actions.~~ Resolved
  2026-06-04: the poller skips comments where `from_id === vk.getSelfUserId()`
  (`users.get` / `VK_SELF_USER_ID`). Before this, the bot re-ingested its own
  «бронь подтверждена (код …)» reply as a self-reservation. See [[vk-comments]].

## Log review 2026-06-05 (resolved 2026-06-06)

Source: `knowledge/raw/log-review-2026-06-05-plan.md`. Orders/wishlist on 5 June
were correct (0 MoySklad errors); all issues were VK-side or recognition. Five
fixes landed:

- **Lot card no longer dies on a broken photo.** `publishLotCard`
  (`server/vk.js`) uploads the photo separately; if the upload fails or VK
  rejects the attachment (error 100 «photo is undefined»), the card is
  republished text-only with the placeholder line. Broken-photo articles surface
  via `lot_card_photo_*` warn logs. See [[vk-comments]].
- **Adaptive comment poll + publish priority.** The poll loop
  (`server/ws-server.js`) runs ~1.5 s while comments flow and ramps to 8 s when
  quiet (was a fixed 2 s). The shared VK queue (`server/vk.js`) now has two
  lanes: publishing (cards/price/replies/close) preempts `video.getComments`, so
  a polling burst no longer delays a buyer's reservation reply.
- **Order merge independent of day — superseded 2026-06-08.** The 2026-06-05
  decision appended a buyer's reservations to their last non-closed order
  regardless of broadcast date. The 2026-06-08 audit showed this polluted old
  and paid orders, so the live reservation path now reuses only same-day
  `#Эфир <date>` orders and blocks append to `Оплачен` /
  `Частично оплачен`. See [[reservation-flow]].
- **Ambiguous/unmatched reservations escalate to the operator.** When a comment
  has a reservation keyword + code but maps to zero or to more than one open lot,
  the system does NOT auto-reserve and does NOT post a public VK comment — it
  pushes a `reservationAttention` row to the operator console (amber banner).
  Leading-zero tolerance now works in both directions (too few or too many
  leading zeros: `0588`→`00588`, `000296`→`00296`) via stripping leading zeros;
  significant digits must match exactly, and the strict single-match rule still
  routes any ambiguity to the operator.
- **Discounts.** «скидка N%» and «минус N%» (digits and words) apply a percent;
  vague «максимальная/есть скидка» stays un-applied. Locked with regression
  tests in `test/discount-detector.test.js`. See [[voice-price-parsing]].

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
- ~~Short numeric price recognition (`цена два пять пять ноль → 2 ₽`)~~
  Closed 2026-06-11: the word form was fixed earlier; the digit-token form
  (`цена 2 5 5 0`, what SpeechKit actually emits) plus `1 500`-style groups,
  `полторы тысячи`, and declined triggers are covered now. See
  [[voice-price-parsing]] and `test/price-detector.test.js`.
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

## Log review 2026-05-30 21:02 bundle

Source: [[../raw/log-review-2026-05-30-21-02|log-review-2026-05-30-21-02]]
from `logs/v-amber-logs-2026-05-30T21-02-01-424Z.zip`.

High-priority problems:

- ~~Fresh `0.1.33` session had no MoySklad errors, but VK failed at stream
  shutdown: comment polling stopped with `VK API 15: video not found`, then
  `lot_closed` publishes failed for every open lot. Closing an ended video
  should degrade quietly.~~ Fixed 2026-05-31: stream-end close now stops
  after the first fatal/video-unavailable VK close failure and skips the
  remaining close-comment publishes.
- ~~Product `00136` hit `VK API 100: photo is undefined`; lot-card publish must
  omit the photo parameter when no photo is available.~~ Fixed 2026-05-31:
  VK comment params omit empty attachments, and incomplete photo objects are
  not uploaded.
- ~~Safe mode blocked the first fresh-session lot-card publish before the
  operator disabled it. The dashboard should make pre-stream safe mode
  obvious.~~ Fixed 2026-05-31: the dashboard shows a pre-stream safe-mode
  banner when external writes/VK publishing are blocked.
- `00269` and `00192` were reserved with unknown stock; stock-unknown remains
  an oversell risk.
- Variant/modification product codes confused the operator because the visible
  code did not resolve the exact sellable item he expected.
- Old `0.1.26` sessions still show MoySklad timeout failures, one
  `reservation_order_failed`, and an orphan waitlist. `0.1.33` improved this
  in the fresh session, but timeout handling remains important.

New or reinforced operator wishes:

- Manual code entry is a primary workflow. Roman explicitly preferred it
  because typed codes appear immediately while voice waits for transcription.
- Voice transcription latency can cost sales during live narration; a helper
  operator can type codes/cancellations while the host keeps speaking.
- Cancellation needs search/jump and voice assist. The existing cancel button
  works, but scrolling through many lots during a live stream is not practical.
- Buyer-facing replies should come from the official Amberry group identity,
  not the older Amber Standard/personal-looking sender.
- Buyers should see which lot was reserved; buyers who miss stock should be
  notified quietly, preferably by DM/hidden path instead of public comment
  noise.
- Quantity phrases like "две штуки" and "забронируй сразу две штуки" should
  be covered in the live workflow, not only in buyer comment parsing.
- Simplify buyer commands further. A viewer reacted "сложно" to the
  `бронь + код` explanation; tolerant forms such as short codes with missing
  leading zeroes remain useful.
- Price/discount parsing still needs hardening around `стоимость`, final
  digits, and percent-discount phrases.

## Log review 2026-05-30T21-02 bundle (TODO)

Source: `logs/v-amber-logs-2026-05-30T21-02-01-424Z.zip`. Walkthrough on
2026-06-01 sorted items into deferred / verified-stale / fixed.

**Still open — deferred (need separate design):**

- **#1 Variant/modification codes resolve to the wrong product.** `00269`
  opened «Браслет из натурального янтаря и дерева» instead of the expected
  item — article code lives on a parent modification group. Operator
  [23:39–23:43 МСК]: *«модификации товара почему-то у меня высвечивается
  кодом другим… какой-то косяк»*. Owner decision 2026-06-01: оставить, пока
  непонятно как решать.
- **#2 `availableStock: null` keeps allowing reservations.** `00269` /
  `00192` were booked with unknown stock — silent oversell. Owner decision
  2026-06-01: тоже оставить.
- **#5 Search/jump in the reservation list (verified missing).** Voice
  cancel lands (digit-word parser fixed 2026-06-01), но фильтра по коду /
  имени у `#reservationList` нет — только `voiceCancelMatch`-подсветка
  ([web-ui/app.js:582](web-ui/app.js:582)). Нужен текстовый фильтр сверху
  панели «Брони» (Phase 2 UI).
- **#10 «две штуки» in operator narration (verified missing).** Голосовой
  путь оператора не создаёт броню; только покупатель по комменту. Feature
  с открытым UX-вопросом (к какому viewerId привязывать?) — оставлен.
- **#11 Wishlist hint not auto-posted (verified missing).** Подсказка
  «СПИСОК <код>» есть только в recovery-логе ([server/index.js:68](server/index.js:68)),
  в эфире в VK-комментарии не публикуется. Нужен дизайн «когда / как часто».

**Resolved in this pass (2026-06-01, see uncommitted diff):**

- ~~**#6 Diagnostic for «бронь перестала работать».**~~ Добавлен `warn
  vk reservation_no_open_lot` в [ws-server.js:1145](server/ws-server.js:1145)
  при `findCommentTarget=null`, но `parseReservationComment` распознал
  keyword+код — раньше пропадало молча.
- ~~**#7 Short trailing digit in voice price.**~~ В [price-detector.js:123](server/price-detector.js:123)
  окно `parseMonetaryWords` поднято с 4 до 6 слов. Транскрипт «стоимость
  две тысячи двести девяносто пять» → теперь 2295, а не 2290. Регрессионный
  тест в [test/price-detector.test.js](test/price-detector.test.js).
- ~~**#12 Buyer-comment word-form quantity.**~~ В [reservation-parser.js](server/reservation-parser.js)
  добавлены WORD_QUANTITIES (две..десять) × шт/пары/штук. «бронь 03204 две
  штуки» → quantity=2; «три пары» → 6; «десять штук» → 10. Хвост «две» без
  единицы — игнорируется, чтобы свободная речь не подменяла quantity.

**Verified already working (operator-feedback wiki was stale):**

- **#8 «Цена два пять пять ноль → 2 ₽».** В bundle нет `voicePrice`<10;
  тест `detectPrice extracts spoken digits sequence` фиксирует 2550. Закрыто
  не позднее этого ревью; запись удалена из TODO.
- **#9 Lot card with price when code+price said in one phrase.** Поток
  `handleConfirmedDetection({ voicePrice })` уже выставляет
  `productCard.voicePrice` перед `publishLotCard` ([ws-server.js:1791](server/ws-server.js:1791)),
  и лот 03196 в логе открылся с `voicePrice:2290` именно так. Лот 03219
  получил `null` из-за #7 (хвостовая пятёрка терялась), теперь покрыт
  регрессионным тестом.

**Из старого списка:**

- **#3 Buyer notification of which lot was reserved** — owner подтвердил:
  уже исправлено в другом месте; снято с TODO.
- **#4 «Амбер Стандарт» vs «Амберри»** — это не код, а `.env`
  (`VK_GROUP_TOKEN` указывает на не ту группу). [server/vk.js:167-176](server/vk.js:167)
  уже корректно использует group token. Зафиксировать в runbook, не в коде.

## Operator wishes 2026-06-23 (Roman — discounts + cross-project boundary)

Source: VK chat between Dmitry (developer) and Roman (operator), 2026-06-23.
The operator described a buyer self-service cabinet (view order, remove
positions, request a payment link, coupons, free-shipping progress, and a
"strip the discount" penalty for removing too much from an unpaid order).

- **Boundary clarified — most of this is NOT V-Amber.** The buyer cabinet,
  self-edit, payment link, and discount-strip penalty belong to the separate
  **AuctionBot Amberry** project, which reads the `#Эфир <date>` customer orders
  directly from the **shared MoySklad** after the broadcast ends (operator
  confirmed "вариант А" — no explicit handoff from V-Amber). Those wishes and
  their open questions are recorded in the AuctionBot vault:
  `Amberry39/knowledge/wiki/operator-wishes-2026-06-23-buyer-vk-cabinet.md`.
- **V-Amber's only part — rules-based discounts (OPEN, to be designed).** Today
  the operator dictates the discount by voice each lot ("скидка 50%"), which is
  tedious ("всегда говорить — залупа") and sometimes mis-recognised. He wants a
  rules-driven discount instead, so the discount is already correct in MoySklad
  when the order is created. Candidate shapes raised but **not decided**:
  - a single default broadcast discount applied to every lot, with voice as an
    override; and/or
  - per-article rules ("на товар X скидка Y").
  - **Decided 2026-06-23 — priority:** a discount voiced during the broadcast
    **always wins** over any rule (broadcast default or per-article). Rules only
    fill in where the operator did not voice a discount. Voice discount input
    therefore **stays**.
  - Open: where rules are authored/stored (panel UI, config, or a MoySklad
    attribute), and the rest of the rule shape (default vs per-article).
  - **Status 2026-06-23: deferred — operator wants to think the discount system
    through first ("скидочную систему нужно продумать").** No implementation
    until the design is settled. Builds on `server/discount-detector.js` and the
    MoySklad position `discount` percentage contract (see
    [[voice-price-parsing#Discounts]], [[moysklad-integration#Reservation
    orders]]).

## Related pages

- [[live-commerce-flow]]
- [[reservation-flow]]
- [[web-dashboard]]
- [[wishlist]]
- [[voice-price-parsing]]
- [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]]
