# Voice price parsing

Voice price parsing extracts sale prices from operator speech and applies them
to the active lot before publication or reservation.

## Current knowledge

- Full phrases such as `две тысячи пятьсот пятьдесят` can resolve to `2550`.
- Compact digit phrases need better handling. During the 2026-05-24 test,
  `цена два пять пять ноль` was parsed as `2 ₽`, not `2550 ₽`.
- Operator feedback asks the system to publish price together with the lot card
  when code and price are spoken in one phrase.

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
