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

## Article codes (артикул)

`server/article-extractor.js` builds code candidates from the words after a
trigger, then `applyKnownCodeHints` validates them against the МойСклад code
cache (~2300 codes, refreshed hourly). **The catalog only validates candidates —
it does not guide the parse.** A code the parser never assembled cannot be
rescued by the catalog, no matter that it is sitting right there. That is what
made the whole `00XXX` range unspeakable until 2026-07-26.

- **Ведущие нули + сотенный блок.** The operator says `00212` as «ноль ноль
  двести двенадцать». `extendWithMixedDigits` refuses cardinals ≥ 100
  (`EXTENSION_CARDINAL_LIMIT`) so prices and sizes don't glue onto the code, so
  the parse stopped at `00` and the hundreds block was dropped → `00` is not a
  catalog code → `voice_code_rejected_unknown`. Эфир 2026-07-26: 17 rejections
  and 8 codes typed by hand (16% of lots, against 0–4% the two days before —
  those эфиры simply had no `00XXX` items, the parser was equally broken since
  June). Fixed by `buildHundredsTailCandidate`: emit a **second** candidate with
  the block appended and let the catalog choose. Only with a loaded catalog;
  the tail block is read with `parseSubThousand` (never swallows «тысяча»), and
  the extra candidate is accepted **only** on an exact/zero-pad match
  (`exactCatalogMatchOnly`) — the loose prefix resolver must not touch it.
- **Zero-normalization is directional.** `resolveKnownCode` matches codes by
  their significant digits, which fixes the common `3172` → `03172`
  (missing pad). The reverse — candidate carries *more* zeros than the catalog
  code — is almost always a mid-sentence stutter. 2026-07-26 17:06:53 the
  fragment `002` (from «артикул ноль ноль два двести шестьдесят шесть»)
  normalized onto the real but unrelated product `02` «Заколка Янтарная»,
  opened a lot and **published its card to VK** instead of `00266`. Now that
  direction requires ≥ 3 significant digits
  (`MIN_SIGNIFICANT_DIGITS_FOR_ZERO_TRIM`, applied in both
  `resolveKnownCode` and `resolveKnownCodePrefix`). Cost, accepted knowingly:
  a catalog code of 1–2 significant digits can no longer be reached by voicing
  extra zeros — say «артикул два» or type it.
- **Rejection beats a wrong lot.** When candidates don't validate, nothing
  opens and the operator types the code — annoying but recoverable. A wrong lot
  is published to viewers and can take a бронь on the wrong product.
- Regression tests: `test/article-extractor.test.js` (real transcripts from the
  26.07 bundle) and `test/product-code-resolver.test.js`.

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
