# Voice price parsing

Voice price parsing extracts sale prices from operator speech and applies them
to the active lot before publication or reservation.

## Current knowledge

- Full phrases such as `две тысячи пятьсот пятьдесят` resolve to `2550`.
- Compact digit phrases work in both word and digit form: `цена два пять пять
  ноль` and `цена 2 5 5 0` → `2550`. SpeechKit normalizes spoken digits into
  separate numeric tokens, so the detector joins bare digit-token runs (3–6
  tokens) before falling back to a single token (fixed 2026-06-11; the
  word-form fix alone had left the digit form returning `2 ₽`).
- Thousands-separated digit groups are joined: `1 500` → `1500`,
  `2 500 рублей` → `2500` (previously collapsed to the first token).
- `полторы тысячи` → `1500` and `N с половиной тысячи` → `N*1000+500`
  (previously silently wrong: `1000` and `2 ₽`). `parseMonetaryWords` now
  lives in `server/ru-numerals.js` and is shared by price and discount
  detectors (it was duplicated).
- Declined trigger forms are accepted: `по цене 990`, `стоимостью 1200`.
- Numbers followed by a non-money unit are rejected: `стоит посмотреть на
  5 минут` no longer sets the price to `5 ₽` (see `NON_MONEY_UNITS` in
  `server/price-detector.js`).
- Operator feedback asks the system to publish price together with the lot card
  when code and price are spoken in one phrase — this works when both land in
  one final (`handleConfirmedDetection` gets `voicePrice`); the EOU pause can
  still split them (see [[speechkit-integration]] backlog).

## Discounts

`server/discount-detector.js` (`detectDiscount`) handles both percent
(`detectPercent`) and absolute rubles (`detectAbsolute`). Confirmed forms the
operator actually uses (log review 2026-06-05, locked with regression tests in
`test/discount-detector.test.js`):

- «скидка N%» / «N% скидки» / «скидка N процентов» (digits and words) → percent.
- «минус N%» / «минус N процентов» / «минус N слов» → percent (the word «минус»
  within ±4 tokens supplies the discount context even without «скидка»).
- «скидка N рублей» / bare small amount → absolute.

Anti-false-trigger: vague phrases with no number — «максимальная скидка», «есть
скидка», «будет скидка» — yield `null` and **do not** change the price (the
system does not yet know the conditions). «без скидки» is also `null`. Colloquial
fractions («пополам/наполовину») are out of scope — the operator does not use
them.

## Runtime files

- `server/price-detector.js`
- `server/discount-detector.js`
- `server/ws-server.js`
- `web-ui/app.js`

## Related pages

- [[operator-feedback]]
- [[live-commerce-flow]]
- [[vk-comments]]
- [[../raw/log-review-2026-05-24-18-45|log-review-2026-05-24-18-45]]
