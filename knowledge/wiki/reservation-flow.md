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

Customer-order merging is scoped to the broadcast day. The first reservation
from a buyer on a calendar day creates a new MoySklad customer order with a
daily marker such as `#Эфир 2026-05-24`. Later reservations from the same buyer
on the same day append only to an order with the same marker. Older open orders
without that marker, including unpaid `Новый` orders, must stay separate.

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
same buyer can reserve again), drops the `customerOrdersByViewerId` day
entry, and sets `event.status = "cancelled"`. The freed slot is available
to the next buyer immediately. Safe mode blocks the delete: the handler
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
