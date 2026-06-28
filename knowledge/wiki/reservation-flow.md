# Reservation flow

Reservation flow handles buyer comments such as `бронь` during an active VK
lot.

## Accepted comment formats

`server/reservation-parser.js` owns the parser. The product code is always
required. Accepted forms:

- bare code only: `03204` (digits + punctuation, no letters)
- short prefixes: `бр`, `брн`, `брнь` (e.g. `бр 03204`)
- full keywords: `бронь`, `бронируй(те)`, `забронируй`, `беру`, `возьму`,
  `куплю`, `хочу`, `держи(те)`, `удержи(те)`, `заберу`, `отложи(те)`,
  `моё/мое/мой/моя`, `плюс`
- `+`, `++`, `+++` right before the digits
- quantity markers (default `1`, hard-cap `10`): `N шт` / `Nшт` /
  `N штук(и)`, `xN` / `х N` (Cyrillic `х` too), `*N`, `пара` → 2.
  Example: `беру 2 шт 03204` → `quantity=2`. Out of range → clamped.

Keyword can be anywhere in the comment. When several digit runs are present
the parser prefers the code of the **currently active lot** if it appears
among them — this guards against picking up phone numbers or prices
(`бронь 12, мой 89991234567` → code `12`, not `899912`; `возьму 12 за 2500`
→ code `12`, not `2500`). When the active code is not among the groups,
the longest digit run wins. The caller in `server/ws-server.js` passes
`preferredCode: expectedReservationCode` from `currentLot.code`.

`список <код>` always routes to [[wishlist]] and never to a reservation.
A comment with letters but no keyword (e.g. `стоит 03204 рублей?`) is
ignored — only digits-only or keyword-bearing comments reserve. Tests live
in `test/reservation-parser.test.js` — extend them when adding a new
variant.

## Code matching and operator escalation

`findCommentTarget` (`server/ws-server.js`) maps a buyer comment to exactly one
open lot:

1. **Exact pass** over all open lots — an exact code match always wins.
2. **Zero-tolerant pass** via `codesEquivalent`: codes are compared after
   stripping **leading** zeros, so both too-few and too-many leading zeros match
   (`0588`↔`00588`, `000296`↔`00296`). Significant digits must match exactly —
   internal-zero edits (`012005` vs `01205`) and digit typos do **not** match.
   A reservation is made **only when exactly one** open lot matches.

When a comment has a reservation keyword + code but maps to **zero or more than
one** open lot, the system does **not** auto-reserve and does **not** post a
public VK comment. Instead it escalates to the operator console: a
`reservationAttention` WS message (`reason: "no_open_lot" | "ambiguous"`, with
`viewerName`, `code`, `originalCode`, `candidateCodes`, `text`) renders an amber
"Брони требуют внимания" banner (`web-ui/app.js`, dismissible rows). If the raw
comment code uniquely resolves through the product-code cache, `code` is the
catalog code and `originalCode` keeps the buyer's raw form (`246` → `00246`).
Ambiguous matches keep candidate codes for manual review. The forensic
`reservation_no_open_lot` warn log is still emitted for the diagnostic bundle.
This is the channel for typo/ambiguous bookings the operator must clarify
(«повтори бронь, Ирина»). Tests: `test/ws-server.manual-code.test.js`.

The VK poller keeps a 30-second grace window after the final open lot closes.
Reservation-like comments in that window still become `reservationAttention`
rows with an empty `openLotCodes` list. They are not auto-reserved because there
is no current lot to attach stock, price, and MoySklad writes to.

## Active lot state

`server/ws-server.js` owns the active lot, the open-lot registry, accepted
users, primary reservation, waitlist event status, customer-order session
version, and safe mode broadcasts. Before changing this flow, trace those
values together.

The Phase 3 multi-lot path keeps `activeLot` as the current operator-facing lot
for price, discount, and legacy UI actions, and adds `openLotsBySessionId` for
all lots that remain open during the broadcast. One VK comment poller runs per
WebSocket session and routes each reservation or wishlist comment to an open
lot by product code. Naming a different code no longer closes the previous lot;
bulk close happens on stream stop, stream error, stream end, or socket close.
`logs/active-state.json` stores `openLots` so crash recovery can scan orphan
reservation events across all open lots.

## Stock protection

The flow checks the active lot's `product.availableStock` against already
creating and confirmed reservation events before writing to MoySklad. Later
`бронь` comments do not oversell the current lot when stock is known.

If stock is unknown when the first reservation arrives,
`ensureStockKnownBeforeFirstReservation` makes a one-shot
`moysklad.getProductCardByCode` call to backfill `availableStock`
before the guard runs. If MoySklad still returns no number, the policy
is **"first slot + explicit warning"** (chosen 2026-05-31): floor=1
allows exactly one reservation, the lot is marked
`product.stockUnknown = true` in the state payload, the operator gets
a `warning` toast "Остаток для лота … неизвестен — разрешён только
1 slot, риск перепродажи", and the case is logged as
`stock_unknown_first_reservation` for grep. The UI renders an amber
pill "остаток неизвестен · риск перепродажи" on the active lot card.
Subsequent reservations on the same lot hit
`committedReservationCount > 0` and are rejected as `out_of_stock`,
unless a follow-up moment lands a real stock number that lifts the
flag. See [[stock-synchronization]] and [[operator-feedback]].

The unknown-stock gate is serialized per lot before `primaryReservation` and
`committedReservationCount` are updated. If two first reservations arrive in the
same poll batch while stock is still unknown, only the first can consume the
single fallback slot; the second is rejected as `out_of_stock` and can move to
wishlist.

The guard now also respects per-event `quantity`: the request is rejected
when `remainingStock < event.quantity`, and `committedReservationCount`
is bumped by `quantity` (not by 1) on accept and rolled back by
`quantity` on safe-mode mid-flight blocks.

**Operator override — the stock guard is buyer-`бронь` only.** The operator
voice-append path (`appendReservationQuantity`, see "Voice quantity (+N шт)"
below) **intentionally bypasses** this guard: it bumps
`committedReservationCount` by the added quantity without checking
`remainingStock`. This is the deliberate **"operator-always-right"** policy
— a manual, button-confirmed action where the operator physically holds the
goods and decides; the oversell risk on that path is knowingly the operator's.
The counter is still bumped so subsequent **automatic** buyer reservations see
the real occupancy.

## MoySklad write path

For a valid reservation, the backend ensures or finds a counterparty and then
creates or appends a customer order in MoySklad. Safe mode wraps external write
methods so dry runs still log detected events without creating real external
state.

### Customer-order merging across campaign days

Эфиры идут несколько дней подряд = одна кампания. A buyer's reservations merge
into **one** MoySklad customer order **across all campaign days**: later
reservations (even on a different day) reuse the buyer's latest **open**
`#Эфир` order instead of creating a new one per day. Each day still stamps its
own `#Эфир <date>` marker into the order description, so one campaign order
accumulates lines like `#Эфир 2026-06-27`, `#Эфир 2026-06-28` — the marker is a
per-day audit tag, **not** the merge key.

- **Append allowed:** the buyer's latest order that carries **any** `#Эфир`
  marker and whose status is not append-blocked.
- **Append blocked:** `Оплачен`, `Частично оплачен`, `Запакован`,
  `Отправлен`, `Доставлен`, `Отменён`.
- **New order:** the buyer has no open `#Эфир` order **within the campaign
  window**, the previous one was closed/packed/paid by the operator, or the buyer
  has no `#Эфир` order at all.

The campaign has **two** boundaries:

1. **Status** — while the order is open it accumulates; closing it
   (pack/ship/pay) ends the campaign for that buyer.
2. **Recency window** (`campaignMaxGapDays`, default **3**) — merge only when the
   order's most recent `#Эфир <date>` marker is within that many days of the new
   reservation. A week-old open order is treated as a *different* campaign, so a
   new order is started even if the old one was never closed. Each append stamps
   the current day's marker, so the window slides with activity (эфиры on
   consecutive days, even with a 1-2 day gap, stay one order; a 7-day gap does
   not).

Matching on `#Эфир ` (not on a bare open order) ensures campaign merge never
hijacks an unrelated manual/non-эфир open order.

**Config / rollback.**
- `config.moysklad.crossDayOrderMerge` (env `MOYSKLAD_CROSS_DAY_ORDER_MERGE`,
  default **on**). `=0` restores the legacy **per-date** behaviour (reuse only an
  order whose marker matches *today's* date; new order every new day).
- `config.moysklad.campaignMaxGapDays` (env `MOYSKLAD_CAMPAIGN_MAX_GAP_DAYS`,
  default **3**) — the recency window above.

After-the-fact reconciliation of orders that split across days is
`scripts/merge-broadcast-orders.mjs` (see [[service-scripts]]).

Implementation:

- `moysklad.findLatestBroadcastCustomerOrder` filters by `agent`, excludes
  append-blocking states with repeated `state!=<href>` filters, orders by latest
  moment, and then (campaign mode) keeps the latest row whose description
  contains an `#Эфир ` marker **whose newest date is within `campaignMaxGapDays`
  of the reservation**; in legacy mode it keeps only rows matching the current
  `#Эфир <date>` marker.
- `appendPositionToCustomerOrder` → `ensureOrderHasBroadcastDescription` stamps
  the current day's `#Эфир <date>` marker on each append, so every campaign day
  is recorded on the surviving order.
- `ws-server.js` keys the in-memory order cache by `viewerId+broadcastDate`; the
  cache is a per-day/per-session fast path, while the MoySklad lookup above is
  the cross-day/cross-session source of truth (a day rollover just falls through
  to one extra lookup, which finds and reuses the open order).
- `moysklad.isCustomerOrderAppendable` checks append-blocking states. This is
  separate from digest "open" logic, so paid orders can still appear in day
  summaries while staying blocked for new reservation writes.

**Stale-cache guard.** The in-memory `customerOrdersByViewerId` is scoped by
viewer and broadcast date. Before appending to a cached order, `ws-server.js`
re-checks it against
MoySklad via `moysklad.isCustomerOrderAppendable(orderId)` — a direct read of
that order's current state. If the operator closed it mid-stream (or the check
fails), the cache entry is dropped and the reservation re-resolves through the
lookup, creating a new order instead of appending to a closed one. Logged as
`cached_order_closed_discarded` / `cached_order_recheck_failed`.

There is **no** `Отгружен` status in this MoySklad account; the 10 live states
are `Новый · Собран · Выставлен счет · Оплачен · Копит · Запакован · Отправлен ·
Доставлен · Отменен · Заказ проведен`.

## Same-code re-detection

Operators routinely repeat the same article code on air (voice mis-parse,
quoting the price right after, adding a description). These repeats used to
close the active lot, dump every pending reservation into `orphan_waitlist`,
and republish a fresh card — losing any `бронь` written between the two
voice events.

`handleConfirmedDetection` now short-circuits when the detected code equals
`activeLot.code` and the lot is not poisoned. It calls
`mergeSameCodeRedetection` instead: keeps the same `lotSessionId`, all
reservations, the existing VK card, and the comment-polling loop; lazily
fills `product` if the original card lookup failed; updates `voicePrice`
and publishes a price-update if it changed. Logged as
`article_redetection_same_code` — does NOT emit `lot_opened`, so INDEX.md
counts the lot once. Operators who legitimately want a fresh lot have to
say a different code first; this is the rare case.

`mergeSameCodeRedetection` gates around its `await` points: before
mutating `lot.product` and again before calling `vk.publishPriceUpdate`,
it re-checks `activeLot !== lot || !isDetectionStillActive(gate)`. If the
operator named a different code while the MoySklad lookup was in flight,
the merge is dropped — otherwise a stale price-update would leak into VK
under the new lot's card.

The price-update VK call is also **skipped entirely** when the lot has
already accepted reservations (`lot.reservations.events.length > 0`).
A VK error 801 (`comments_closed`) from `publishPriceUpdate` would
otherwise poison the lot via `handleVkPublishError`/`markLotPoisoned`
and destroy the sticky-lot guarantee for the buyers who already
booked. The internal `voicePrice` is still updated; only the public
card update is dropped. Logged as
`redetection_price_update_skipped_due_to_reservations`.

## Cancelling a reservation

The operator can cancel a confirmed reservation from the dashboard
(`× отменить` on the reservation row → `cancelReservation { viewerId,
commentId }` WS message). The backend removes the buyer's MoySklad
position with an **exact-id** `DELETE` on the position
(`moysklad.removePositionFromOrder`), so a retry can never delete a
sibling position of the same product. The position id is captured at
reservation time — `createCustomerOrderReservation` /
`appendPositionToCustomerOrder` return `positionId`, stored on the event
as `customerOrder.positionId`.

On a confirmed delete the handler decrements `committedReservationCount`
by `event.quantity`, removes the viewer from `acceptedUserIds` (so the
same buyer can reserve again), drops that viewer's cached customer-order
entries, and sets `event.status = "cancelled"`. The freed slot is available to
the next buyer immediately. Safe mode blocks the delete: the handler
re-checks `isSafeMode()` and replies with a warning without touching
state, and `removePositionFromOrder` is also in the `wrapWithSafeMode`
list. The cancel is silent to buyers (no public VK reply) to avoid the
error-801 → `markLotPoisoned` risk. Empty orders are left in MoySklad —
the code never deletes whole customer orders. See
[[deferred-operator-features]] #16.

### Voice cancel (W3, Phase 2)

The operator can also trigger a cancel by voice: «<Имя Фамилия> отмена
лота #<код>» (variants: снять/убрать бронь, отмена брони, code with or
without `#`; the code can be a digit run like `01059` **or** spoken as
digit-words «ноль один ноль пять девять» — the latter is how operators
actually dictate codes in livestream). The voice path **never** performs the MoySklad delete
itself — it only **finds and highlights** the matching reservation row so
the operator confirms with the same `× отменить` button. This keeps a
speech-recognition error from auto-deleting a position (real money).

Pieces:

- `server/cancel-command-parser.js` — pure parser of the spoken phrase →
  `{ matched, name, code }`.
- `server/name-matcher.js` — pure name matcher tolerant of declensions
  («Галину Прокофьеву») and word order; `matchNameAgainst` returns scored
  matches and never auto-picks on ambiguity.
- `server/name-cache-store.js` — persistent `viewerId → name` cache,
  append-only `logs/viewer-names.jsonl`, `load()` folds to
  last-name-per-viewer. Records **every** commenter with a resolved VK
  name (not just reservers), so it survives stop/start of a broadcast and
  process restart — the in-memory lot state and `customerOrdersByViewerId`
  are wiped on socket close. Excluded from the sendLogs bundle (the bundle
  is an allowlist in `server/log-bundle.js`; this file is not on it).
- `ws-server.js`: name recorded at the VK profile-resolution point;
  `handleVoiceCancelCommand` runs in `onFinal` **before** article
  detection (returns early so «отмена лота 033322» does not open lot
  033322), matches against the active lot's confirmed reservations, and
  sends a `voiceCancelMatch` WS message. Ambiguous match (equal top
  scores) → a warning, no highlight.
- UI: `voiceCancelMatch` → `highlightReservationForCancel` adds
  `res-item--cancel-target` and scrolls to the row. Operator confirms.

### Voice quantity (+N шт)

Оператор может голосом добавить позиции к уже подтверждённой брони:
«<Имя Фамилия> добавь N штук <код>» (синонимы глагола: запиши, поставь,
поменяй, измени, плюс; единицы: шт/штук/штуки/пара/пары; код — цифрой
или словами). По тому же контракту, что и отмена: сервер **не создаёт**
позицию в МойСкладе из речи, только подсвечивает строку и предлагает
кнопку «+N шт». Оператор подтверждает кликом, после чего
`appendReservationQuantity` зеркалит `cancelReservation` (адресная привязка
по `lotSessionId+viewerId+commentId`, safe-mode блокирует).

Pieces:

- `server/quantity-command-parser.js` — парсер фразы → `{ matched, name,
  quantity, code }`.
- `ws-server.js` `handleVoiceQuantityCommand` — находит лот по коду, ищет
  бронь по имени через `matchNameAgainst`, шлёт `voiceQuantityMatch` с
  предлагаемым количеством. Ambiguous match → warning, без подсветки.
- UI `highlightReservationForQuantity` кладёт предложение в
  `state.pendingQuantity` (Map, ключ `${viewerId}:${commentId}`) и
  перерисовывает список. Подсветку `res-item--quantity-target` и кнопку
  `+ N шт` навешивает `renderReservationsForLots` из этого state на каждый
  рендер — поэтому кнопка **переживает любой `emitState`** (раньше её стирал
  `clearChildren` при ре-рендере, и кнопка пропадала до клика). Клик кнопки
  шлёт `appendReservationQuantity` → сервер вызывает
  `moysklad.appendPositionToCustomerOrder` и пишет `reserved_appended`
  событие, которое потом можно отменить отдельно по его `positionId`.
- **actionId (server nonce) + lifecycle.** В `voiceQuantityMatch` сервер
  кладёт однократный UUID и хранит привязанные `lotSessionId/viewerId/
  commentId/quantity` в `pendingQuantityActions` (TTL 60 с). При
  `appendReservationQuantity` клиент возвращает только этот `actionId` —
  сервер берёт значения из своей map, клиентские lotSessionId/viewerId/etc.
  игнорируются. Иначе любой WS-клиент мог бы голым сообщением создать
  позицию любой брони (HIGH из opencode review 2026-06-01). Токен читается
  через `peekPendingQuantityAction` и удаляется **только после успешного**
  append — при ошибке МойСклада он остаётся живым, чтобы оператор повторил
  кликом. Защита от двойного клика — флаг `event.appendInFlight`.
- **`voiceQuantityResult { actionId, ok }`.** Сервер шлёт ack на каждый
  `appendReservationQuantity`: `ok:true` — позиция создана, UI убирает
  предложение из `state.pendingQuantity`; `ok:false` — не применилось, UI
  перерисовывает (кнопка снова кликабельна по живому токену).
- **Кламп количества.** Парсер режет количество до `1..10`
  (`QUANTITY_HARD_CAP`) и возвращает `requested` (что озвучили до клампа).
  Сервер ставит `capped = requested > quantity` в `voiceQuantityMatch`; UI
  показывает «запрошено N, максимум 10» в логе, тултипе и confirm-диалоге,
  чтобы добавленное количество не расходилось молча с произнесённым.

## Waitlist and recovery

While one reservation is being processed, later comments can wait. Startup
recovery writes orphan reservation evidence to session logs and does not
auto-migrate those users into [[wishlist]] without explicit confirmation.

## Related pages

- [[moysklad-integration]]
- [[vk-integration]]
- [[vk-comments]]
- [[logging-and-diagnostics]]
- [[preorders]]
