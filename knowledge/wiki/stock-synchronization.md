# Stock synchronization

Stock synchronization keeps visible available stock aligned with MoySklad after
reservations and lot changes.

## Current knowledge

- Operator feedback from 2026-05-24 says visible stock did not change after a
  reservation.
- Unknown stock, represented as `availableStock=null`, can weaken duplicate and
  oversell protection.
- The UI and active reservation state need refresh after MoySklad order
  position creation.
- **Confirmed instance, 2026-07-05 эфир**: cross-checking `find-overbooked.js`
  against the session log, all 4 products it found overbooked by exactly `-1`
  (03304, 00969, 03300, 01277) had `lot_opened.availableStock: null` — the
  stock gate had nothing to check against, so the single reservation on each
  went through and tipped an already-zero/near-zero item negative. Every other
  lot opened that эфир had a real `availableStock` number and none of those
  overbooked. Read: `null` at `lot_opened` is the leading indicator to watch
  for mid-broadcast, not a rare edge case — it reliably correlates with a
  post-hoc overbook. See [[log-verification-checklist]] step 7.
- **Attention handoff, 2026-08-17**: a successful reservation made from an
  attention row before its lot opens is transferred to the first subsequent lot
  for the same product. The buyer is pre-accepted, so a repeated comment cannot
  append the product again. The lot also disables its `0/null → 1` stock floor
  after this handoff because the earlier reservation already consumed the
  operator-in-hand unit. A positive MoySklad balance is not reduced twice.

- **Источник остатка сменился, 2026-08-29**: `report/stock/all` по части товаров
  молча возвращает пустой ответ — в эфире 29.08 так вышло по `03878`, `03888`,
  `00258`, `03927`, и каждый раз это давало `availableStock: null` (тот самый
  ведущий индикатор из записи 2026-07-05). `report/stock/bystore` по тем же
  товарам отвечал корректно, поэтому остаток теперь считается по нему, а
  `report/stock/all` остался только ради цены, картинки и папки. Отличать
  «товара нет нигде» (ноль) от «запрос не удался» (`null`) обязательно:
  первое не должно снимать бронь у оператора, который держит товар в руках.
- **Склады исключаются по префиксу имени, не по равенству**: боевой склад
  называется `Брак(на ремонт)`, а в `MOYSKLAD_EXCLUDED_STORE_NAMES` стоит
  `Брак` — строгое сравнение не срабатывало, и брак считался продаваемым
  остатком (23 SKU, 16 из них не лежат больше нигде). Остаток по исключённым
  складам отдаётся отдельным полем `excludedStoreStock`.

## Runtime files

- `server/ws-server.js`
- `server/moysklad.js`
- `web-ui/app.js`

## Related pages

- [[operator-feedback]]
- [[reservation-flow]]
- [[moysklad-integration]]
- [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]]
