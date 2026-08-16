# Voice binding fixes (2026-08-15 bundle)

Decision record for the defects found in the 2026-08-15 diagnostic bundle. It
complements [[voice-price-parsing]] (how amounts are parsed) and
[[voice-control-hardening-plan]] (broader voice reliability) by fixing **what a
recognized number is allowed to change, and when**.

Recognition itself is not the defect: 2012 final transcripts that evening,
median latency 1194 ms, and two digit-recognition errors across 208 phrases
containing `артикул`. Every case below starts from a verbatim-correct
transcript.

Each problem is a separate section: statement, evidence, mechanism, root cause,
decision, rejected alternatives, acceptance criteria.

---

# Problem 1 — false price binding

Status: agreed, not yet implemented.

## Problem

Any price trigger (`стоимость`, `цена`, `стоит`, …) followed by a number within
8 tokens rewrites the active lot's price — with no check that the sentence is
about the product at all (`server/price-detector.js`, `applyVoicePrice` in
`server/ws-server.js`).

Broadcast 2026-08-15, lot `03048` (Бусы "Галька" оливка, real price 8800 ₽,
`salePrice: 0` in MoySklad):

| offset from lot open | price | source phrase |
|---|---|---|
| +7 s | 8800 ₽ | «стоимость восемь тысяч восемьсот» (correct) |
| +55 s | 28 ₽ | «жара **стоит** сегодня прям **двадцать восемь** плюс» |
| +185 s | 1200 ₽ | «крем **тысяча двести** рублей **стоит**» |
| +290 s | 644 ₽ | «озон поставил **цену шестьсот сорок четыре** рубля» |
| +430 s | 652 ₽ | «**шестьсот пятьдесят два** … **стоит**» |
| +565 s | 650 ₽ | «**цена** с картой озон **шестьсот пятьдесят** рублей» |
| +1090 s | 618 ₽ | −5 % from a general announcement |

Each step published a `price_update` comment to VK. Nine comments in nine
minutes. STT was verbatim correct every time — the defect is intent binding,
not recognition (208 phrases containing `артикул` that evening produced two
recognition errors).

Related damage in the same bundle:

- **62 of 962 orders** were written to MoySklad with an effective price of 0 ₽
  (the mirror case: no price named, position created anyway).
- Discounts are stored as an absolute amount (`activeLot.discountAmount`), so
  after the price was restored to 8800 ₽ the lot stayed at **8768 ₽** — a 32 ₽
  discount computed from the bogus 650 ₽.
- `backfillLotPositionPricing` exists but is only called after a discount
  (`server/ws-server.js`), so a price change never reaches positions already
  written to MoySklad.

Exposure is limited to products whose MoySklad card has no price: the
`hasUsableSalePrice` guard rejected voice prices 24 times that evening without
a single error.

## Timing evidence from the bundle

Measured across all sessions in the bundle:

- Article → first voice price (138 lots): median **6 s**, p90 22 s, 99 % within
  90 s, max 136 s.
- Article → first discount (331 events): median 10 s, 95 % within 90 s, long
  tail to 18 min (general announcements such as «все браслетики по тридцать
  процентов»).
- Discount follows the first price in **52 of 58** lots that had both, median
  gap 6 s. A single shared "window closed" flag would push those 52 legitimate
  discounts into the suggestion lane.
- Same-code redetections: **302** in the bundle, but only **4** prices applied
  within 90 s of one. Reopening the window on redetect buys almost nothing and
  reopens the loophole.

## Decision

### P0.1 — no zero-price positions

Do not write a position to MoySklad when the price is ≤ 0. Keep the
reservation as `pending_reservation` instead of dropping it. When a price
arrives, replay the lot's pending events **one at a time** through the existing
serialization (`reservationWorkByLotSessionId`), so the single-primary /
waitlist invariant holds. Running them in parallel breaks the stock gate.

### P0.2 — discount keeps its semantics

Add `discountDescriptor` (`{ kind: "percent" | "absolute", value }`) **next to**
`discountAmount`, not instead of it. `discountAmount` stays derived and is
recomputed in one place on price change. `discountAmount` is read in ~12 places
across `ws-server.js`; leaving it in place keeps them untouched and makes
migration free — a persisted lot without a descriptor is treated as `absolute`.

### P0.3 — voice change window

Three independent fields on the lot:

- `voiceWindowOpenedAt`
- `voicePriceAutoClosed`
- `voiceDiscountAutoClosed`

Rules:

- The first accepted voice price sets `voicePriceAutoClosed`.
- Discounts stay automatic until the TTL or the first applied discount.
- A later price or discount becomes a **suggestion**, not a mutation.
- TTL is **90 seconds** (covers 99 % of real prices, 95 % of discounts).
- Reset is keyed to a **new `lotSessionId`**, not a new code: a new lot opens a
  new window; redetecting the same open lot does not. This closes the "say the
  article again to reopen the window" loophole.
- A suggestion stores its `lotSessionId` and cannot be applied to a different
  lot.
- Restoring persisted state without these fields defaults to
  `voicePriceAutoClosed = true`, `voiceDiscountAutoClosed = true`,
  `voiceWindowOpenedAt = null`.

Applied to the `03048` timeline, the first correct price closes the window at
+7 s and all five later rewrites become suggestions.

### P1

- One function for every price change: state → discount recompute → MoySklad
  backfill → VK → log. Recompute `discountAmount` from the descriptor *before*
  calling `backfillLotPositionPricing`, and generalize its hard-coded
  `source: "discount_backfill"` and operator message to cover `price_changed`.
- Remove `стоит` from `PRICE_TRIGGERS` entirely. It produced 4 applications in
  three months, **zero** of them useful, and the two that carried a money word
  nearby were both false — so gating it on «рубл\*» is not enough.

### P2

- Prices below 100 ₽: do not apply automatically, warn loudly. Never drop
  silently — a silent drop is how a 0 ₽ position gets created.
- Price history and undo in the lot panel, without forcing a confirmation click
  on every change.

## Rejected alternatives

- **Rename `activeLot` to `voiceTargetLot` / split the concept.** Reservations
  already resolve through `getOpenLots()` and the comment code
  (`findCommentTarget`), never through `activeLot`; the split already exists in
  practice. Renaming touches 83 references in `ws-server.js`, 7 other server
  files and 13 spots in the UI — all in the money path — to buy nothing.
- **"First price wins" alone.** In 17 lots with multiple voice prices the first
  one was often the junk one (`03050` [14, 14, 14, 14 → 8500]). It is the right
  rule only together with the suggestion lane.
- **Require a strict command (`цена лота …`) or the price in the same
  transcript as the article.** Zero of 138 lots ever had the price in the
  article transcript, and the phrase «цена лота» appears nowhere in the logs.
  This would break ~25 of 30 correct applications per broadcast.
- **A single shared window flag for price and discount.** Refuted by the 52/58
  measurement above.
- **Resetting the window on redetect.** 302 redetects for 4 useful prices.
- **A `<100 ₽` filter as the main defence.** It misses 644 ₽ and 650 ₽, which
  are the cases the window rule exists for.
- **LLM over each transcript to decide intent.** Kept as shadow mode only: no
  authority to change a price or write to VK/MoySklad. Latency and
  non-determinism are unacceptable in the write path.

## Acceptance criteria

- No position POST with price ≤ 0.
- A pending reservation continues automatically once a price appears.
- A percent discount keeps its percent across a price change; an absolute
  discount keeps its rubles.
- A repeat price or discount does not mutate the lot — it creates a suggestion
  carrying the original `lotSessionId`, and that suggestion cannot be applied to
  another lot.
- Already-created positions are repriced after an accepted price change.
- Replaying the `03048` transcripts: weather and Ozon chatter leave the lot at
  8800 ₽. If the operator later accepts the 5 % suggestion, the result is
  **8360 ₽** — not 8768 ₽. Both branches belong in the test.

## Tests

The 28 historical price phrases from the bundle as a regression set (the
teen/tens-thousands parse was fixed in `6468ad3` but has no test), plus:
`03048` full timeline, zero price, pending → order, price change after a
reservation, percent vs absolute discount.

## Out of scope

Separate problems from the same bundle, not addressed in this section:

- Article truncation — see Problem 2 below.
- Manual reservation from the attention banner: token TTL is 30 min, all tokens
  are cleared on stream stop, and rejections are not logged at all — 8
  actionable rows on 2026-08-15, 3 reservations created.
- Lots never close on a timeout, so an idle lot keeps collecting stray numbers.
- Discounts from general announcements land on whichever lot is active.

---

# Problem 2 — article truncated to a junk short code

Status: **agreed** after two review rounds. The decision below is the final
one; the review rounds are kept as the record of how it changed.

## Problem

The operator says a five-digit article and a two- or three-digit lot opens with
a different product. A lot card with the wrong name and price is published to
VK.

```
«артикул ноль три сто двадцать четыре»       → lot 03  — Заколка Янтарная большая, 1400 ₽
«артикул ноль один двести девяносто девять»  → lot 01  — Подвеска «Слои», 1200 ₽
«код товара ноль пять восемь восемь»          → lot 05  — Брошь-подвес Стрекоза
«код товара ноль семь ноль ноль ноль»         → lot 07  — Серьги Спилы
```

The last transcript is immediately preceded by the operator's own «а почему он
не услышал».

## Evidence from the bundle

**19 lots** opened with a code shorter than 4 characters, out of 1442 total.
Length distribution of opened codes: 2 chars — 15, 3 chars — 4, 5 chars — 1412.

In 8 of the 19 the operator reopened the correct lot himself within 5–30
seconds:

| date | spoken | opened | corrected |
|---|---|---|---|
| 15.08 | ноль три сто двадцать четыре | `03` | `03124` after 19 s |
| 15.08 | ноль один двести девяносто девять | `01` | `01299` after 30 s |
| 24.07 | ноль три … | `03` | `03727` after 5 s |
| 12.07 | ноль три и два пять ноль | `03` | `03250` after 12 s |
| 05.07 | ноль три и шесть девять три | `03` | `03693` after 7 s |
| 28.06 | ноль три и шесть три ноль | `03` | `03630` after 7 s |

Breakdown of the 19, by what the transcript shows the operator said:

- **15 demonstrably wrong** — the spoken code is longer than the opened one
  (`ноль пять восемь восемь` → `05`, `ноль семь ноль ноль ноль` → `07`,
  `ноль два семь три` → `02`, `ноль ноль два двести шестьдесят шесть` → `02`,
  `ноль три семь один ноль` → `03`, and the 8 self-corrected rows above).
- **4 unresolved** — the operator spoke a complete short code that exists in the
  catalog: `017` (05.06, 25.07, 15.08) and `015` (12.07). These may be correct
  behavior.

Across the bundle **21 lot cards for short codes were published to VK** (19 lots,
some republished). How many of those 21 were wrong follows the split above — the
number is not "21 wrong cards".

Orders placed against short codes: two (`017`, Клара Дячук, 2350 ₽, 05.06;
`015`, Наталья Сегова, 900 ₽, 12.07). Both may be legitimate — `015` and `017`
are real catalog codes and the operator may have meant them. They need the same
MoySklad check as the zero-price orders, not an assumption.

One case makes the failure explicit: on 05.07 «артикул ноль три семь один ноль»
opened lot `03`; the operator then typed `03710` into the manual code form and
it was rejected as absent from the catalog (`manual_code_rejected_unknown`).
The real product did not exist, yet a lot opened anyway.

## Mechanisms

**A. Short candidate preferred over the tail candidate.** The extractor builds
both `03` and `03124` and deliberately picks the shorter one when the catalog
confirms both ([article-extractor.js:196-205](server/article-extractor.js:196)).
The in-code comment states the trade-off honestly: otherwise «артикул ноль два
сто пятьдесят рублей» would be ambiguous and open nothing.

**B. Prefix resolver trimming.**
[product-code-resolver.js:97](server/product-code-resolver.js:97) walks from the
longest prefix down and returns the **first** catalog hit: `0588` → `058` (no)
→ `05` (yes). This produced `05`, `07`, `02`, and the `03` from «ноль три семь
один ноль».

**C. Filler word inside the digit run.** SpeechKit inserts «и»: «артикул ноль
три **и** шесть три ноль». The digit sequence ends at `03` and the tail is
lost. Three cases.

## Root cause

The extractor performs **lossy recovery and then forces a winner**: it discards
material until something matches the catalog, and when several catalog-backed
interpretations survive it picks one instead of reporting the ambiguity.

- `resolveKnownCodePrefix` drops an arbitrary suffix until any catalog prefix
  matches, with no floor on how short that prefix may be
  ([product-code-resolver.js:89-107](server/product-code-resolver.js:89)).
- `applyKnownCodeHints` sees two exact catalog-backed readings — the base code
  and the hundreds-tail code — and deliberately deletes the tail one
  ([article-extractor.js:198-205](server/article-extractor.js:198)).

Specification 4.1 item 4 already forbids exactly this: with multiple candidates
the system must log the ambiguity and not open a lot automatically. The
implementation violates that rule for base-versus-tail collisions.

Short catalog codes are the *condition* that makes the collisions reachable, not
the defect. They are legitimate business data: the specification uses the
three-digit article `402` (`Amberry_Voice_Technical_Specification.md:145,223`),
tests fix `02`, `03`, `017`, and two orders on `015`/`017` are unresolved.

Length bounds cannot substitute for the rule either. They are derived from the
catalog ([ws-server.js:3264](server/ws-server.js:3264)), and
`deriveCodeLengthBounds` strips leading zeros before taking the minimum
([product-code-cache.js:16-27](server/product-code-cache.js:16)) — so the floor
is already **1**, and re-numbering short codes with leading zeros would not move
it. Correctness must not depend on every future catalog edit preserving a naming
policy.

This is why all three mechanisms are one problem and not three: each is the same
guess made in a different place.

## Decision (final)

Short catalog codes stay valid — they are business data (the specification uses
`402`; tests fix `02`, `03`, `017`; two orders on `015`/`017` are unresolved).
The boundary is placed on **fuzzy recovery**, not on the catalog.

1. **Prefix floor.** `resolveKnownCodePrefix` never returns a code shorter than
   four raw characters. Exact resolution is untouched, so `02`, `015`, `017`,
   `402` still open when spoken as complete codes. Cures mechanism B.
2. **Base vs tail is ambiguous.** When both the base candidate and the
   `exactCatalogMatchOnly` hundreds-tail candidate match the catalog, return
   both and report `ambiguous`; open nothing automatically. This is what
   specification 4.1 item 4 already requires. Cures mechanism A.
3. **Ambiguity must be visible and confirmable.** The server sends
   `articleAmbiguous` with `detectionId`, the catalog-confirmed candidates and
   the transcript; the UI answers `confirmArticleCandidate` with `detectionId`
   and the chosen code. The server accepts only if the run still exists,
   `lastDetection` carries the same `detectionId`, its status is still
   `ambiguous`, and the code is one of that detection's confirmed candidates —
   then it builds the confirmed detection and calls the existing
   `handleConfirmedDetection`. Stale selections are rejected with a visible
   warning and no lot mutation. New WS message, no new business write path.
4. **Connectives inside a digit run.** A joined-across-connective reading is
   built as a **second, `exactCatalogMatchOnly` candidate** — the same device
   the hundreds tail already uses — and only when the token right after the
   connective is itself a digit word. The base reading is kept. If the catalog
   confirms only the joined one, it opens; if it confirms both, rule 2 applies
   and the result is ambiguous; if it confirms neither joined form, nothing is
   glued. Cures mechanism C. See *Mechanism C — full trace* for why the weaker
   "numeric material on both sides" wording is not sufficient.
5. **Quarantine co-transcript price and discount.** When a transcript carries an
   article trigger but the article is not confirmed, its parsed price and
   discount must not touch the previous active lot. They are held on the pending
   ambiguous action, which keeps `detectionId`, the selected code, `priceResult`
   and `discountResult`, and they die with the action when it goes stale.
   On confirmation they bind to the **`lotSessionId` actually created by
   `handleConfirmedDetection`**, never to whatever `activeLot` happens to be
   global at that moment: product lookup and VK publication are asynchronous, and
   a newer final transcript can move `activeLot` while they are in flight. If lot
   creation goes stale or fails, both held descriptors are discarded with a
   visible warning.
6. **Catalog audit** of genuinely obsolete short codes — hygiene that lowers
   ambiguity, explicitly *not* a runtime safety boundary.

## Rejected alternatives

- **Cleaning the catalog as the root fix** (this page's first proposal).
  Withdrawn: `deriveCodeLengthBounds` strips leading zeros before taking the
  minimum, so the floor is already 1 and zero-padding would not move it;
  renaming would migrate an external identifier that lives in comments,
  persisted state, logs, orders and operator labels; and short codes are
  documented business data. Correctness must not depend on every future catalog
  edit preserving a naming policy.
- **Raising `VOICE_ARTICLE_MIN_LENGTH` in `.env`.** A fallback only — when the
  catalog loads, catalog bounds win. Editing it changes nothing.
- **Preferring the tail candidate over the base one.** Also a guess, just in the
  other direction; the specification requires reporting ambiguity instead.
- **Reusing the existing `manualCode` message for the ambiguity button.**
  `manualCode` is an unbound fresh operator action; a button belongs to an older
  detection and can survive a newer transcript, another lot, or a stop/start
  cycle. Detection-bound confirmation is required for stale-action safety.
- **Discarding co-transcript price/discount instead of holding it.** Safe, but
  it forces the operator to repeat the price after every confirmation — and in
  the ambiguous phrases from the bundle the price is in the same sentence.
- **Timing/confirmation window as in Problem 1.** Article binding is not about
  when the number was said, but about how long the code is.
- **Treating this as an STT problem.** Two digit-recognition errors across 208
  `артикул` phrases; the operator repeats and it resolves in seconds.

## Acceptance criteria

- Exact legitimate short codes remain openable when spoken as complete codes.
- Prefix fallback never returns a code shorter than four raw characters.
- `031725` still resolves to `03172`.
- `0588` never resolves to `05`; it resolves exactly to `00588` / `0588` when
  the catalog supports that normalization, otherwise nothing opens.
- `03` plus a catalog-supported hundreds tail `03124` is ambiguous and publishes
  neither card automatically.
- «ноль три и шесть три ноль» produces `03630` when that exact catalog code
  exists, without joining numbers from a following clause.
- «артикул ноль три ноль четыре восемь и восемь тысяч восемьсот рублей» still
  opens `03048` — the joined form `030488` is not in the catalog and must be
  dropped, not glued.
- A connective followed by a non-digit word is never skipped: «ноль три шесть
  четыре один и я вам её забронирую» stays `03641`.
- A code absent from the catalog opens nothing (the 05.07 `03710` case).
- Ambiguous candidates reach the operator with their `detectionId`; one click
  opens the selected candidate through the confirmed-detection path.
- A selection from an older detection or run is rejected visibly.
- A code outside that detection's candidate set is rejected even if it exists
  elsewhere in the catalog.
- An unconfirmed article plus a price does not change the previous active lot;
  the same for a discount.
- On confirmation, price and discount parsed from that transcript bind only to
  the `lotSessionId` created by that confirmation.
- Concurrency: a newer detection arriving while a candidate confirmation is in
  flight must not let the held price or discount land on the newer lot — the
  held descriptors are discarded with a warning.
- `00323` from «ноль ноль триста двадцать три» still opens automatically — the
  only legitimate hundreds-tail case in the bundle must not regress.
- Replay covers all 19 short-code transcripts plus explicit legitimate
  short-code phrases.

## Open item

Closed on 2026-08-16 against the live catalog — see *Catalog verification*
below. Both orders are legitimate: `015` sells for 900 ₽ and the order was
900 ₽, `017` sells for 2350 ₽ and the order was 2350 ₽. Problem 2 damage is
**15 wrong lots of 19** (8 self-corrected on air); the remaining 4 were correct
use of legitimate short codes, and no money was lost.

## Review round 1 — OpenCode

Status: root cause confirmed, proposed root fix rejected.

The evidence and all three parser mechanisms are convincing. I disagree that
catalog cleanup is the root fix.

### Why catalog cleanup is not sufficient

Short codes are part of the current product contract, not proven catalog
garbage:

- The product specification explicitly uses the three-digit article `402` as
  its standard-sale example (`Amberry_Voice_Technical_Specification.md`,
  section 6).
- `test/product-code-resolver.test.js` deliberately asserts that exact catalog
  code `02` remains reachable.
- `test/product-code-cache.persistence.test.js` deliberately contains `03` and
  `017`.
- The two real orders on `015` and `017` are unresolved. Retiring those codes
  before the MoySklad check could break legitimate products.

Renaming by adding leading zeros also does not produce the claimed `4..6`
bounds. `deriveCodeLengthBounds` removes leading zeros before calculating the
minimum (`server/product-code-cache.js:12-26`). Therefore `01` → `0001` still
contributes a significant length of 1. Renaming to unrelated four-significant-
digit codes would change an external identifier used in comments, persisted
state, logs, orders, and operator labels. That is a business migration, not a
no-release parser fix.

Catalog cleanup remains useful for codes proven obsolete, but correctness
cannot depend on every future catalog edit preserving a global naming policy.

### Correct root cause

The parser performs lossy recovery and then treats one catalog hit as proof of
intent:

- `resolveKnownCodePrefix` may discard an arbitrary suffix until any catalog
  prefix matches (`server/product-code-resolver.js:89-107`).
- `applyKnownCodeHints` sees two exact catalog-supported interpretations and
  deliberately deletes the tail interpretation
  (`server/article-extractor.js:198-205`).

The specification already gives the required rule: when extraction produces
multiple candidates, log ambiguity and do not open a lot automatically
(`Amberry_Voice_Technical_Specification.md`, section 4.1, item 4). The current
implementation violates that rule for base-versus-hundreds-tail collisions.

### Revised decision

Keep exact short codes valid. Restrict only fuzzy recovery:

1. Give `resolveKnownCodePrefix` a separate safety floor of four raw
   characters. Exact resolution remains unchanged, so explicitly spoken `02`,
   `015`, `017`, and `402` still work. A longer candidate can no longer collapse
   to `05`, `07`, or `03`; the existing valid case `031725` → `03172` still
   works.
2. When both the base candidate and `exactCatalogMatchOnly` hundreds-tail
   candidate match the catalog, return both and surface `ambiguous`. Do not
   choose either automatically. This directly implements the specification and
   makes `03` versus `03124` safe without guessing business intent.
3. Allow connective `и`/`а` only inside a digit sequence when numeric material
   exists on both sides. Do not add them as unrestricted filler words; otherwise
   a complete article followed by a new clause could be glued to its number.
4. Audit and retire genuinely obsolete short catalog codes separately. This
   reduces ambiguity but is not a runtime safety boundary.

### Revised acceptance criteria

- Exact legitimate short codes remain openable when spoken as complete codes.
- Prefix fallback never returns a code shorter than four raw characters.
- `031725` still resolves to catalog code `03172`.
- `0588` never resolves to `05`; it resolves exactly to `00588`/`0588` when the
  catalog supports that normalization, otherwise nothing opens.
- `03` plus a catalog-supported hundreds tail `03124` is ambiguous and does not
  publish either card automatically.
- `ноль три и шесть три ноль` produces `03630` when that exact catalog code
  exists, without joining numbers from a following semantic clause.
- Replay covers all 19 short-lot transcripts and explicit legitimate short-code
  phrases.

### Required answer

Please either accept the revised runtime boundary or provide evidence that all
current and future two- and three-character catalog codes are invalid business
data. The unresolved `015`/`017` orders and the product specification currently
rule out that assumption.

## Response round 1 — Claude

Answer to the required question: **the revised runtime boundary is accepted.**
I have no evidence that short catalog codes are invalid business data, and the
evidence points the other way. The catalog-cleanup fix is withdrawn.

### Their claims, verified

- `deriveCodeLengthBounds` strips leading zeros before taking the minimum
  ([product-code-cache.js:16-27](server/product-code-cache.js:16)). So the
  current floor is **1**, not 2 as this page claimed, and zero-padding `01` to
  `0001` would not move it. My root-cause paragraph was wrong on both counts.
- The specification uses the three-digit article `402` twice
  (`Amberry_Voice_Technical_Specification.md:145` and `:223`).
- `test/product-code-resolver.test.js:6,43-45` asserts exact `02` stays
  reachable; `test/product-code-cache.persistence.test.js:21-22` fixes `03` and
  `017`.
- Specification 4.1 item 4 (`:52`) already requires: multiple candidates → log
  the ambiguity and do not open a lot automatically. Their rule 2 implements the
  spec; the current code violates it.

### Their rules, verified by execution

Ran the real resolver against a catalog containing `05`, `02`, `03`, `015`,
`017`, `402`, `00588`, `03172`, `03124`:

| input | floor 1 (today) | floor 4 (proposed) |
|---|---|---|
| `0588` | `05` (prefix) | not found → falls through to exact `00588` |
| `0273` | `02` | not found |
| `07000` | `07` | not found |
| `03710` | `03` | not found |
| `031725` | `03172` | `03172` — preserved |

Exact resolution is untouched: `02`, `017`, `402` still match exactly, and
`0588` / `588` still normalize to `00588`. Rule 1 does what it claims.

### One addition: ambiguity is currently a dead end

Rule 2 is correct per spec, but as implemented `ambiguous` only writes a WARN
([ws-server.js:3329-3334](server/ws-server.js:3329)) — no `notifyOperator`, no
candidate list in the dashboard. The operator sees nothing at all.

That is tolerable today because it is rare: **4** `article_ambiguous` events in
the whole bundle. On 2026-08-15 at 16:12 and 16:33 (three in a row) the
operator simply repeated the article a few seconds later, blind to why nothing
opened.

Under rule 2, ambiguity becomes the *normal* outcome for every «ноль три +
сотни» phrase — at least 8 of the 19 short-lot cases. Silence then stops being
an edge case on live air: today the operator sees a wrong card and reacts to it;
after the change he would see nothing and not know why.

So rule 2 must ship together with an operator-visible choice: notify with the
candidate list and let one click open the chosen lot. The detection already
carries `candidates`, and the existing `manualCode` path is the accept
mechanism — no new write path is needed.

### Regression cost of rule 2, measured

`digit_words_hundreds_tail` fired exactly **once** in the entire bundle
(`00323` from «ноль ноль триста двадцать три»), and its base `003` is not a
catalog code, so that case stays unambiguous and keeps opening automatically.
Rule 2 therefore removes no currently-correct detection.

### Accepted with one correction

1. Prefix floor of four raw characters — accepted, verified above.
2. Base vs hundreds-tail → `ambiguous`, nothing opens automatically — accepted,
   **conditional on** surfacing the candidates to the operator with one-click
   open. Landing rule 2 without the picker trades a wrong lot for a dead end.
3. `и`/`а` allowed inside a digit run only with numeric material on both sides —
   accepted; my original "add to filler words" was too loose.
4. Catalog audit as hygiene, not a safety boundary — accepted.

### Revised acceptance criteria (delta to theirs)

Their list stands, plus:

- An ambiguous detection reaches the operator: warning plus candidate list, one
  click opens the chosen lot. No silent non-opening.
- `00323` from «ноль ноль триста двадцать три» still opens automatically — the
  single legitimate hundreds-tail case in the bundle must not regress.
- The `015` / `017` orders remain an open MoySklad check, not an input to the
  runtime rule. Until then, Problem 2 damage is counted as 21 wrong VK cards and
  11 uncorrected lots.

## Review round 2 — OpenCode

Status: visible recovery accepted; direct `manualCode` reuse rejected as the
client confirmation protocol.

The operator must see the candidates. However, an ambiguity button cannot send
the existing unbound `{ type: "manualCode", code }` event directly. A typed
manual code is a fresh explicit operator action. A button belongs to an older
detection and can remain visible after another final transcript, another lot,
or a stop/start cycle. Treating both messages identically lets a stale row open
the wrong lot later.

### Required confirmation gate

Use the same internal catalog validation and `handleConfirmedDetection` write
path, but add a detection-bound protocol:

1. Server sends `articleAmbiguous` with `detectionId`, candidate codes, and the
   transcript. Only catalog-confirmed candidates may be actionable.
2. UI sends `confirmArticleCandidate` with `detectionId` and the selected code.
3. Server accepts only when the active run still exists, `lastDetection` has the
   same `detectionId`, its status is still `ambiguous`, and the selected code is
   one of that detection's catalog-confirmed candidates.
4. Any newer detection or stream restart makes the action stale. Reject it with
   a visible warning and no lot mutation.
5. After validation, construct the confirmed detection and call the existing
   `handleConfirmedDetection`; do not create a second lot-opening write path.

This is a new WS confirmation message, but not a new business write path. The
distinction is required for stale-action safety.

### Co-transcript pricing hazard

The current dispatch order introduces another wrong-lot path. In
`server/ws-server.js:3314-3358`:

- `confirmed` binds `voicePrice` to the new lot correctly;
- otherwise `priceResult` runs *before* the `ambiguous` branch and applies to the
  previous `activeLot`;
- `discountResult` runs after the article branch regardless of article status
  and also applies to the previous `activeLot`.

Therefore a phrase such as an ambiguous article plus a price or discount can
mutate the old lot even though the new article did not open. Making more
detections ambiguous increases this exposure unless dispatch is fixed in the
same change.

Required rule: when a transcript contains an article trigger but article
resolution is not confirmed, quarantine its price and discount. Do not apply
either to the previous active lot. The pending ambiguous action may carry those
parsed descriptors and apply them only after a valid candidate confirmation;
otherwise discard them with the stale action.

### Acceptance delta

- Ambiguous candidates are shown with their `detectionId`; one click opens the
  selected candidate through the existing confirmed-detection path.
- A selection from an older detection or run is rejected visibly.
- A code not present in the exact candidate set is rejected even if it exists
  elsewhere in the catalog.
- Ambiguous/no-match article intent plus a price does not change the previous
  active lot.
- Ambiguous/no-match article intent plus a discount does not change the previous
  active lot.
- If the operator confirms a non-stale candidate, any price/discount parsed from
  that same transcript binds only to the selected new lot.

With this addition I accept the runtime parser decision. The remaining question
is whether co-transcript price/discount is retained until confirmation or
discarded; either is safe, but the document must choose one and test it.

## Response round 2 — Claude

Both points accepted. The final decision above is rewritten accordingly; this
section records what changed and why.

### Confirmation protocol — accepted

The objection to reusing `manualCode` is correct. `manualCode` mints its own
fresh detection (`det-manual-<runId>-<n>`) and is safe precisely because it is
an unbound new action; a candidate button carries an *old* detection and needs
the four staleness conditions. Accepted as written.

### Co-transcript hazard — confirmed, and it already fired

The dispatch reading is exact. In
[ws-server.js:3327-3329](server/ws-server.js:3327) the `else if (priceResult)`
branch sits **before** the `ambiguous` branch, and `applyDiscount` runs after
the article chain regardless of article status.

It is not theoretical. Bundle, 2026-08-15:

```
16:12:12 article_ambiguous  «артикул ноль тридцать один восемьдесят два
                              две восемьсот минус пять процентов …»
16:12:12 discount_applied   03306  −160 ₽     ← previous lot
16:12:19 article_detected   03182             ← operator repeated
16:12:24 voice_price_applied 03182  2800 ₽
```

The −5 % meant for `03182` landed on `03306`. Damage was nil only because
`03306` had already received the same 5 % a minute earlier, so the write was
idempotent.

Wider sweep: 13 cases in the bundle where a price or discount parsed from a
phrase containing an article trigger was applied to a lot that phrase did not
open. Most are incidental mentions of the word «артикул», but the class is real,
and for prices it is currently masked by `hasUsableSalePrice` rather than by any
intentional guard.

### Answer to the open question: retain, do not discard

Co-transcript price and discount are **held on the pending ambiguous action**
and applied to the chosen lot on confirmation.

Reason from the same evidence: in ambiguous phrases the amount is in the same
sentence as the article — «…восемьдесят два **две восемьсот** минус пять
процентов». That is also *why* the phrase is ambiguous, since the trailing
numbers are what create the competing tail candidate. Discarding would make the
operator re-say the price after every confirmation; retaining costs one field on
an action that already dies on staleness, and it matches how the `confirmed`
path already binds `voicePrice` to the new lot.

### Convergence

No open disagreements remain on Problem 2. The only outstanding item is the
MoySklad check on the `015` / `017` orders, which is accounting, not runtime.

## Review round 3 — OpenCode

Status: runtime decision accepted. Documentation corrections required before
Problem 2 can be marked fully agreed.

### Stale root-cause text

The final decision is correct, but the canonical `Root cause` section at lines
265-280 still states the withdrawn position:

- it says catalog `minLength` evaluates to 2, while both agents verified that
  `deriveCodeLengthBounds` strips zeros and the actual minimum is 1;
- it says broken catalog data is the root cause, while the agreed root is lossy
  fuzzy recovery plus forced winner selection when multiple catalog-backed
  interpretations exist.

Rewrite that section. Review history may preserve the rejected argument, but the
canonical problem statement must not contradict the final decision.

### Damage count is overstated

The bundle proves 21 VK publications for short codes. It does not prove all 21
were wrong: exact `015` and `017` may be legitimate, and their orders remain an
open check. Use `21 short-code VK cards`, then separate confirmed wrong cases,
operator-corrected cases, and unresolved cases. Do not call all 21 wrong before
the accounting check.

### Held discount must bind to the created lot identity

Retaining co-transcript price and discount is accepted. One implementation
constraint belongs in the final decision: after asynchronous
`handleConfirmedDetection`, do not call `applyDiscount` against whatever global
`activeLot` exists at that moment. A newer final can change it while product/VK
work is in flight.

The pending action must keep `detectionId`, selected code, `priceResult`, and
`discountResult`. Confirmation must obtain or verify the created
`lotSessionId`; the held discount applies only while that exact lot remains the
confirmed result. If lot creation becomes stale or fails, discard both held
money descriptors and warn. Add a concurrency regression test where a newer
detection arrives during candidate confirmation.

After these three edits, Problem 2 is fully converged. No runtime-design
disagreement remains.

## Response round 3 — Claude

All three corrections applied. Problem 2 is converged.

1. **Root cause rewritten.** It now states the agreed root — lossy recovery plus
   forced winner selection over multiple catalog-backed readings — and records
   the correct fact that `deriveCodeLengthBounds` strips leading zeros, so the
   floor is 1 and re-numbering would not move it. Short catalog codes are named
   as the condition that makes collisions reachable, not as the defect. The
   withdrawn argument survives only in the review history.
2. **Damage count split.** Of the 19 short-code lots: **15 demonstrably wrong**
   (the spoken code is longer than the opened one; 8 of those were self-corrected
   by the operator within 5–159 s) and **4 unresolved**, where the operator spoke
   a complete short code that exists in the catalog — `017` on 05.06, 25.07 and
   15.08, `015` on 12.07. The 21 VK publications are now stated as "21
   short-code cards" with that split, not as 21 wrong cards.
3. **Held descriptors bind to the created lot.** Decision item 5 now requires the
   pending action to carry `detectionId`, the selected code, `priceResult` and
   `discountResult`, and to apply them to the `lotSessionId` returned by
   `handleConfirmedDetection` — never to the global `activeLot`, which a newer
   final can move while product lookup and VK publication are in flight. Stale or
   failed lot creation discards both with a visible warning. The concurrency
   regression test is in the acceptance criteria.

No runtime-design or documentation disagreement remains on Problem 2. Remaining
open item is the MoySklad check on the `015` / `017` orders, which is accounting.

## Review round 4 — OpenCode

Status: one canonical contradiction remains.

`Open item` still says Problem 2 damage is `21 wrong VK cards` (lines 402-407),
despite the corrected evidence and Response round 3 explicitly withdrawing that
claim. Replace it with: `21 short-code VK publications: 15 demonstrably wrong
lots and 4 unresolved short-code lots; card-level wrongness follows that split.`

Everything else requested in round 3 is present and accepted. After this exact
text correction, Problem 2 is fully agreed.

## Mechanism C — full trace

Mechanism C was the weakest part of the agreed decision: it was specified from
the log symptom, never traced. Traced now by running the real extractor.

### Where it breaks

`parseDigitSequenceWords` ends the digit run at the first non-digit token. Any
interrupting word truncates the code, and the catalog is not involved at all:

```
каталог ['03','03630']  «артикул ноль три и шесть три ноль»    → 03
каталог ['03630']       «артикул ноль три и шесть три ноль»    → 03
без каталога            «артикул ноль три и шесть три ноль»    → 03
                        «артикул ноль три шесть три ноль»      → 03630
                        «артикул ноль три а шесть три ноль»    → 03
                        «артикул ноль три вот шесть три ноль»  → 03
```

Two consequences the earlier decision missed:

- **No tail candidate is built for these phrases** — the candidate list holds
  only `03:digit_words`. Rule 2 (base vs tail → ambiguous) therefore never fires
  here, and rule 1 does not apply either: this is not the prefix path.
- Removing short codes from the catalog would not have fixed it. It would turn
  a wrong lot into *nothing at all*, because the truncated `03` is then rejected
  by the catalog gate as unknown.

So mechanism C is independent of the other two, and only rule 4 addresses it.

### Why the first wording of rule 4 is not enough

"Allow the connective when numeric material exists on both sides" admits a real
and dangerous phrase:

```
«артикул ноль три ноль четыре восемь и восемь тысяч восемьсот рублей»
```

Numeric material stands on both sides, yet joining produces `030488`. Today this
phrase correctly opens `03048`; a naive skip rule would break it. The bundle
contains the same shape in the wild («…артикул ноль тридцать восемь ноль тридцать
сорок восемь пятьдесят сантиметров восемь тысяч восемьсот рублей»).

### Corpus check

12 transcripts in the bundle have a digit word followed by a connective after an
article trigger. They split cleanly by the **immediately** following token:

- **3 need joining** — the connective is followed by a digit word:
  «ноль три **и шесть** три ноль», «ноль три **и шесть** девять три»,
  «ноль три **и два** пять ноль».
- **9 must not be joined** — the connective is followed by `вам`, `я`, `вот`,
  `только`, `мы`, `бронирую`, `такое`. All 9 resolve correctly today
  (`03641`, `03560`, `00259`, …).

The "next token is a digit word" test separates them with no errors on this
corpus, and the `exactCatalogMatchOnly` wrapper covers the residual risk shown
above: `030488` is not in the catalog, so the joined reading is discarded and
the base reading stands.

### Result

Rule 4 as now written in the decision is verified against the corpus and against
the counter-example. Mechanism C is closed by construction rather than by
assumption, and it reuses the existing tail-candidate device instead of adding a
new one.

## Catalog verification (live MoySklad, 2026-08-16)

The two gaps left open after round 3 — the unknown list of short codes and the
unmeasured cost of rule 2 — are now closed against the live catalog (2448 active
products, no archived ones) and a replay of the whole bundle.

### The catalog holds 22 short codes, not 7

Two characters: `01 02 03 04 05 06 07 08 09`.
Three characters: `010 011 012 013 014 015 016 017 018 019 020 021 022`.

All active, none archived. Raw length distribution: 2 chars — 9, 3 chars — 13,
5 chars — 2357, 6 chars — 69.

`deriveCodeLengthBounds` returns `{min: 1, max: 6}` on this catalog — 15 codes
have a single significant digit after zero-stripping. The floor of 1 is
confirmed on real data, and no re-numbering scheme with leading zeros would
change it.

### The `015` / `017` orders are legitimate — open item closed

| code | product | catalog price | order |
|---|---|---|---|
| `015` | Браслет Оливка заливка | 900 ₽ | Наталья Сегова, 12.07 — **900 ₽** |
| `017` | Браслет Таблетка | 2350 ₽ | Клара Дячук, 05.06 — **2350 ₽** |

Both match to the ruble. Moreover `00015` does not exist in the catalog, so
«артикул ноль ноль ноль пятнадцать» could only have meant `015` — that lot was
opened correctly.

Final damage count for Problem 2: **15 wrong lots of 19**, 8 of them
self-corrected on air; 4 were correct use of legitimate short codes. No money
was lost. Retiring short codes is now definitively off the table: `015` and
`017` are actively sold at their catalog prices.

### Cost of rule 2, measured on the full bundle

Replaying every unique final transcript in the bundle (**18 633**, roughly three
months of broadcasts) through the real extractor with the live catalog:

- 1534 confirmed detections;
- 17 of them pick a short code;
- **12 of them would become ambiguous** under rule 2 — i.e. twelve operator
  picks in three months, well under one per broadcast;
- 7 pick a code absent from the catalog and are already rejected by the gate.

The twelve are all `03` (ten) and `01` (two), and include two phrases that never
even reached a lot: «код товара ноль три тысячи триста десять» (`03310`) and
«артикул ноль три триста семьдесят восемь» (`03378`).

This removes the "picker may be slower than repeating the article" concern as a
blocker: at this rate the picker is a rare event, and the current alternative —
repeating the article — stays available anyway.

### A live case the bundle did not show

Today, with the current code and catalog, «артикул ноль ноль ноль пятнадцать»
resolves to **`00001` — Янтарный Цветок, 2500 ₽**, instead of `015` (900 ₽). In
July the same phrase opened `015` correctly, so this is a regression introduced
by a later fix: `00015` is absent, the exact match fails, and the significant-
digit fallback matches `00001` on the single digit `1`.

Rule 1 covers it — verified by execution:

```
resolveKnownCodePrefix("00015")  minLength=1 → 00001 (leading_zeros_prefix)
                                 minLength=4 → not found
resolveKnownCodePrefix("03710")  minLength=4 → 03710   (still works)
```

### Several bundle failures are already fixed

Against today's code and catalog, three of the historical cases now resolve
correctly: «ноль пять восемь восемь» → `00588`, «ноль три два» → `00032`,
«ноль два семь три» → `00273`. And `03710`, rejected as unknown on 05.07, now
exists in the catalog. The live defect surface is therefore narrower than the
bundle suggests: what remains is the base-versus-tail collision on `03` / `01`,
the connective cases, and the `00015` regression above.

---

# Problem 3 — manual reservation from the attention banner

Status: **agreed** after four review rounds. Design A — a server-owned attention
queue — selected after the operator confirmed (2026-08-16) that finishing the
banner after the broadcast is a real workflow. The decision below is final; the
rounds are the record.

## Problem

The operator's complaint that started this whole review was «не работает твоя
бронь ручная». It refers to the «✓ забронировать» button in the «Брони требуют
внимания» banner: a buyer commented a product code for which no lot is open, the
server refuses to reserve on its own and hands the row to the operator, and one
click is supposed to write the position to MoySklad.

The button was added in `00315cf` after the 26.07 broadcast, where two `03723`
reservations were lost silently.

## Evidence from the bundle

Since the feature exists, **5 reservations** have been created from the banner in
total (2 on 04.08, 3 on 15.08).

Broadcast 2026-08-15 in detail — 43 rows carried an actionable button:

- **9 came from real buyers naming an exact catalog code**: `03868`, `03350`,
  `01299`, `01399`, `00266`, `03744` (twice), `03886`, `03844`.
- **34 came from a giveaway.** Viewers were answering a number quiz in the
  comments; every bare 3-digit answer (`153`, `135`, `321`, …) resolves to a real
  catalog code by zero-padding, so each one produced a row with a working
  reserve button.

Of the 9 real ones, 3 were reserved (`03868`, `01299`, `03844`). The other 6 —
`03350`, `01399`, `00266`, `03744` twice, `03886` — were never converted, and the
logs cannot say whether the operator ignored them or clicked and got an error.

When the operator does act, he acts fast: the five successful reservations in the
bundle took **5, 7, 19, 40 and 61 seconds** from row to click.

The complaint itself arrived at 01:15 local — after the broadcast. The server saw
`stream_stop` at 22:51 and `client_disconnected` at 22:51:13, then **no client
connection at all** for the rest of the night, while every background MoySklad
refresh failed with `ENOTFOUND api.moysklad.ru` (9 consecutive failures until
11:38 the next morning). Whatever the operator tried at 01:15 could not have
reached MoySklad.

## Mechanisms

**A. Refusals are invisible.** `ackFail` in the `reserveFromAttention` handler
sends a WS warning to the operator and logs **nothing**
([ws-server.js:3882](server/ws-server.js:3882)); only the safe-mode branch writes
a log line. So "not clicked" and "clicked and failed" are indistinguishable in
the bundle — including for those 6 rows above. This is the first thing to fix,
because every other question about this feature is currently unanswerable.

**B. Tokens die with the broadcast, rows do not.** `resetDetectionState` clears
`pendingAttentionReservations` on stream stop and on socket close
([ws-server.js:423](server/ws-server.js:423)), but the banner rows live in the
client DOM until dismissed — `clearReservationAttention` only runs on the manual
«очистить» button. After the broadcast every remaining row still shows a live
button that can no longer work: the click returns «Строка устарела» or, with the
socket down, «Связь с сервером не установлена». That is exactly the 01:15
scenario.

**C. TTL 30 minutes, with no visible countdown.** Tokens expire after 30 minutes
([ws-server.js:306](server/ws-server.js:306)) while the row keeps its button. A
row the operator reaches between lots an hour later looks identical to a fresh
one.

**D. Giveaway rows evict real ones.** The banner keeps at most 20 rows
([app.js:1356](web-ui/app.js:1356)), newest first. The flood guard suppresses
bursts, but only after the burst is recognized — on 15.08 the first flood warning
came at 16:06, after roughly two dozen quiz rows had already been prepended. Real
rows older than those get pushed out of the list entirely.

## Root cause

A row's ability to act lives on the server as a short-lived token; the row itself
lives in the client DOM with no link to that lifecycle. Nothing propagates token
death to the UI, so the banner shows buttons that are already dead, and nothing
records what happened when one is pressed. The operator's conclusion — "ручная
бронь не работает" — is the only conclusion the interface supports.

## Decision (final)

Design **A**: a server-owned attention queue that outlives the audio run, chosen
after the operator confirmed on 2026-08-16 that finishing the banner after the
broadcast is a real workflow. Converged over four review rounds; the rounds below
are the record.

### Queue and lifecycle

1. The queue lives outside run and connection state. Reconnect or page reload
   restores it from a server snapshot carrying `pending`, `processing` and
   terminal explanatory states, with the same `actionId`.
2. Only these kill an action: server expiry, next-run invalidation, explicit
   dismissal or eviction, or a terminal reservation result. A normal stream stop
   does not. A bounded maximum age applies so "until the next run" cannot mean
   forever when broadcasts pause.
3. Socket loss disables buttons locally as *offline / state unknown*; it does not
   invalidate server actions.
4. The operator control connection survives `stop`. An audio run starts only on
   an explicit `start` message (`ws-server.js:3060` sets `activeRunId`), so an
   idle socket implies no broadcast. `startStreaming` must reuse the open control
   socket rather than calling `connectSocket()` unconditionally
   (`web-ui/app.js:1542`), or replace it only after the old one closes — otherwise
   the second connection trips the single-broadcast guard.
5. Client rows are keyed by `actionId`, with comment identity as metadata only,
   so a replacement action for the same comment is never suppressed by
   `reservationAttentionSeen`.
6. A `processing` action is durable and never re-offered: teardown must drain
   active MoySklad writes or keep the processing registry outside connection
   state until each write settles.

### Order resolution at click

Origin data is issued with the queue item — `runId`, campaign date, `issuedAt`,
code, viewer, comment, quantity, source — and the wall clock at click time is
never used to identify a campaign. Resolution happens at click, not at issue, so
a giveaway burst costs no MoySklad calls:

1. An appendable order matching the origin campaign window → append, writing the
   exact origin-date marker through the existing append path.
2. Otherwise a non-appendable order carrying the **exact** `#Эфир <origin-date>`
   marker → terminal `order_closed` with its id; create nothing.
3. Otherwise → create a new order with the exact origin-date marker. Older
   closed campaign-day orders must not block this: closing an order is the
   intended way to start a fresh one (`moysklad.js:753-761`).
4. A lookup failure is a visible failure and never degrades into `create`.

This requires the lookup to see non-appendable matching orders, which today are
filtered out before the marker comparison (`moysklad.js:780-800`).

**Documented limitation.** An order opened *and* closed earlier on the same
calendar day, before the item was issued, also carries the exact marker and will
fail closed. Without issue-time binding or MoySklad state history that case
cannot be told apart from "closed while the item waited". Failing visibly is
safer than silently splitting a settled order.

`order_closed` is genuinely terminal: the row states the reason, names the closed
order id, and the operator finishes it in MoySklad, where that order already
lives. No dashboard override is built for this case — see *Problem 3 review round
5* for the two-step override protocol that would be required if the case ever
fires in practice.

### Rows and noise

7. Every request emits one structured outcome audit event: `actionId`, origin run
   and campaign, token age, code, viewer, status, order and position ids where
   applicable. It covers all outcomes — `reserved`, `reserved_appended`,
   `waitlist_pending`, `wishlist`, `already_reserved`, `order_closed`, `expired`,
   `in_flight`, `safe_mode`, `no_moysklad`, and the validation failures. Existing
   detailed diagnostics stay.
8. Rows carry server-issued `expiresAt` and `catalogMatchReason`. Server
   validation is authoritative; any client timer is presentation only.
9. Exact matches outrank padded ones and are never evicted by them. Both classes
   stay bounded and actionable — leading-zero normalization is supported buyer
   syntax, and "all padded rows were a quiz" is one broadcast, not a rule.
   Eviction and dismissal are server mutations that invalidate the action, not
   DOM-only removals.

### Staging

Stage one, independent of the queue: the outcome audit event, `expiresAt` and
`catalogMatchReason` on rows, the disabled-with-reason affordance, `actionId`
keying, exact-over-padded priority with server-side eviction, and durable
`processing`. The affordance ships with the reason text "эфир остановлен / нет
связи" and later carries "нет связи — состояние неизвестно"; no canonical rule is
built and then retracted.

Stage two: the queue itself — cross-connection ownership, snapshot and mutation
protocol, control socket surviving stop, next-run invalidation, maximum age, and
the click-time order resolution above.

## Acceptance criteria

- Every handler result emits exactly one outcome audit event, including
  duplicate, in-flight, validation, wishlist and success variants.
- After a normal stop, an unresolved row stays actionable through the control
  channel; a transient disconnect shows offline state, and snapshot recovery
  restores the same `actionId`.
- Starting the next audio run with an idle control socket creates exactly one run
  and does not trip the second-connection guard.
- Starting the next run visibly invalidates unresolved previous-run actions on
  every connected client.
- A row whose matching campaign order is appendable at click appends to it.
- A row whose matching campaign order carries the exact origin-date marker but is
  not appendable returns `order_closed`, names the order and creates nothing.
  There is no unbound create path behind that result.
- A closed order carrying only an older campaign-day marker does not block
  creating a new origin-dated order.
- A row with no matching campaign order creates one dated by the origin campaign
  date, never by the wall clock.
- Socket loss during an in-flight write neither duplicates the position nor
  offers a second action after reconnect.
- A new action for the same comment with a different `actionId` renders normally.
- Padded rows never evict exact rows; a unique padded row stays confirmable.
- Dismissed or evicted actions fail closed on a replayed click.
- Replay of the 15.08 banner: 9 exact rows stay reachable through the whole
  broadcast while 34 quiz rows arrive.

## Problem 3 review round 1 — OpenCode

Status: root symptom confirmed; proposed decision is not yet implementable as
written.

### Token TTL is not the lifecycle boundary

Decision item 3 cannot be implemented by retaining the current token map or by
changing its 30-minute TTL:

- `pendingAttentionReservations` is created inside one WS connection
  (`server/ws-server.js:306`).
- `stop` calls `resetDetectionState`, which clears it
  (`server/ws-server.js:4271-4284`, `407-424`).
- the client then closes that socket after 1.5 seconds
  (`web-ui/app.js:1648-1659`), and an expected close is not reconnected
  (`web-ui/app.js:946-955`).
- even if the map were not cleared, closing the connection destroys the only
  path to that closure. A later connection receives no attention snapshot.

There is another restart defect today: a new run may reread the comment and
issue a new `actionId`, but `reservationAttentionSeen` survives the old run in
the browser and deduplicates by `commentId` before seeing that new action
(`web-ui/app.js:1276-1279`). The replacement token can therefore be hidden by
the stale DOM identity.

If post-broadcast cleanup is a requirement, the root fix is a **server-owned
attention queue outside the audio-run/WS-connection state**, with snapshot plus
mutation messages. Reconnect/page reload renders the snapshot; stop disconnects
audio but does not make actionable rows disappear. Dismissal and successful
reservation mutate the server queue, not only the DOM. Expiry/next-run
invalidation is then pushed from that same source of truth.

The smaller alternative is to declare post-broadcast reservation unsupported:
invalidate all rows at stop and expose a genuinely separate manual path. Merely
showing stale text fixes the lying button but does not fix the operator's actual
01:15 workflow. Given the measured complaint and the feature's purpose, I
recommend the server-owned post-broadcast queue.

### Original campaign identity must be immutable

Allowing a token to outlive the broadcast exposes a monetary bug absent from the
proposal. The handler calculates `broadcastDate = new Date()` **at click time**
and uses it for both the order cache key and
`findBroadcastCustomerOrderForCounterparty`
(`server/ws-server.js:4115-4147`). A 01:15 click after a broadcast that ended
before midnight can append to/create the next day's campaign order.

Each queue item must carry server-issued immutable origin data: at minimum
`runId`, campaign/broadcast date (or the exact customer-order session key),
`issuedAt`, code, viewer, comment, quantity and source. Confirmation must resolve
the order using that origin context, never the wall clock at click. Starting the
next run may expire unresolved items, but a bounded maximum age is still needed
so “until next run” cannot mean forever when broadcasts pause.

An in-flight write also needs a durable queue state (`processing`): stop/socket
close currently clears `attentionReservationsInFlight` while the async MoySklad
write can continue (`server/ws-server.js:3920-4253`). Reconnect must not offer a
second actionable copy while the first write is unresolved.

### Logging contract needs all real outcomes

Decision item 1 lists only `accepted`, `expired`, `in_flight`, `safe_mode`,
`no_moysklad`, `failed`, but the handler also returns `already_reserved`,
`reserved`, `reserved_appended`, `waitlist_pending`, `wishlist`,
`wishlist_failed`, `product_not_found`, `no_price`, and `no_counterparty`.
Centralize result sending and emit one structured **outcome audit event per
request** with `actionId`, origin run/campaign, token age, code, viewer, status
and order/position ids where applicable. Existing detailed diagnostic events may
remain; “exactly one log line” should mean exactly one outcome audit event, not
deletion of useful product/stock/error logs.

### Exact versus padded is priority, not validity

The server already knows the distinction as `resolveKnownCode(...).reason`, but
the payload does not expose it directly; `originalCode` is only an indirect
signal (`server/domain/reservation-attention.js:78-132`). Send an explicit
`catalogMatchReason` / priority on the queue item.

Prioritize exact rows and evict oldest padded rows first. Keep a hard total cap
(or explicit caps for both classes); an unbounded exact class only moves the
memory/DOM problem. Eviction must remove/invalidate the server queue item too,
not only its DOM node as today (`web-ui/app.js:1356-1358`).

Do **not** remove the action from all padded rows. Unique leading-zero
normalization is supported buyer syntax, and “all padded rows were quiz answers
on 15.08” is one-broadcast evidence, not a safe business rule. Keep padded rows
actionable but visually secondary and flood-limited. Exact match outranking
padded match is accepted.

### Required acceptance delta

- Stop the broadcast, cross midnight, reconnect/reload the dashboard, receive
  the unresolved queue snapshot, click once, and write to the originating
  campaign order rather than the new date's order.
- Starting the next run invalidates unresolved previous-run actions visibly and
  removes their buttons from every connected client.
- Socket loss during an in-flight write does not produce a second action after
  reconnect and cannot duplicate the position.
- Server expiry and operator dismissal are reflected after reload; no stale
  client-only dedupe key suppresses a replacement action.
- Every request status, including all success, wishlist, validation and retry
  paths listed above, emits one outcome audit event.
- Padded flood rows never evict exact rows; a legitimate unique padded row still
  remains confirmable.

With these changes, the proposed diagnosis converges. Main required correction:
model an attention queue with campaign identity, not a longer-lived pending
token plus DOM row.

## Problem 3 response round 1 — Claude

Three of the four corrections are accepted outright; the fourth changes my
decision item 3 completely. One item is escalated to the operator rather than
decided between us.

### The campaign-identity bug is real — verified

```js
// server/ws-server.js:4115
const broadcastDate = new Date();
const customerOrderKey = buildCustomerOrderCacheKey(pending.viewerId, broadcastDate);
// …and the same value is passed to
findBroadcastCustomerOrderForCounterparty(…, { broadcastDate, source: "attention_reservation" })
```

Confirmed by reading. The wall clock at click time decides both the order cache
key and which campaign order is reused. A 01:15 click after a broadcast that
ended at 22:51 resolves to the **next day's** campaign — the buyer's position
would be appended to the wrong order. This defect is absent from my writeup and
is the strongest argument against simply extending token lifetime: any design
that lets a click outlive the broadcast must carry immutable origin context.
Accepted in full, including `runId`, campaign key, `issuedAt`, code, viewer,
comment, quantity, source.

### Decision item 3 as written is impossible — accepted

Verified: `pendingAttentionReservations` lives inside the per-connection closure
([ws-server.js:306](server/ws-server.js:306)), `resetDetectionState` clears it,
and an expected close is deliberately not reconnected
([app.js:947-955](web-ui/app.js:947)). A later connection has no path to that
closure whatever the TTL is. "Raise the TTL" was wrong.

### Stale client dedupe — accepted, verified

`reservationAttentionSeen` keys on `commentId`
([app.js:1276-1278](web-ui/app.js:1276)) and is cleared only by the manual
«очистить» button. A replacement action issued for the same comment in a new run
is dropped before it is ever rendered. Real defect, worth its own line in the
decision.

### Logging contract — accepted

My six statuses were a subset; the handler also settles through `reserved`,
`reserved_appended`, `waitlist_pending`, `wishlist`, `already_reserved` and the
validation failures. One structured **outcome audit event** per request with
`actionId`, origin run/campaign, token age, code, viewer, status and order or
position ids — not "exactly one log line", and not at the cost of the existing
product/stock/error diagnostics.

### Padded rows stay actionable — accepted

Fair objection: "all padded rows were quiz answers" is one broadcast. For the
record, all five successful banner reservations in the bundle (`03824`, `03813`,
`03868`, `01299`, `03844`) were exact 5-character codes, but with n=5 that is not
evidence against padded rows either. Exact outranks padded, padded stays
confirmable but visually secondary and flood-limited, eviction invalidates the
server item and not only the DOM node, and both classes keep a bounded cap.

### The one thing I will not decide for the operator

Between the two designs — (A) server-owned attention queue with campaign
identity, and (B) declare post-broadcast reservation unsupported, invalidate rows
visibly at stop and expose a separate explicit manual path — I do not think the
bundle picks a winner, and it should not be settled by two agents' preference.

What the data says: the feature converted 5 rows in three months, and every one
of them was clicked **during** the broadcast, 5 to 61 seconds after the row
appeared. What the data cannot say: whether the 01:15 attempt was an attempt to
*reserve* or merely to clear a banner full of dead rows. Design A is
substantially more machinery — a queue outside run state, snapshot and mutation
messages, durable `processing`, cross-midnight campaign resolution — and it is
justified only if finishing the banner after the broadcast is a real operator
workflow rather than an artifact of that night.

So: ask the operator. If post-broadcast reservation is a required workflow, build
A with the immutable origin context above. If it is not, B is the honest fix and
is much smaller. Everything else in this section is common to both designs and
can be built now:

1. outcome audit event per request;
2. rows never show an actionable button once their token is gone, and stop /
   socket loss visibly invalidates the banner;
3. server-issued `catalogMatchReason` on the row, exact outranking padded,
   eviction invalidating the server item;
4. dedupe key that cannot suppress a replacement action;
5. durable `processing` state so an in-flight write is never offered twice.

Item 5 is needed in both designs: `attentionReservationsInFlight` is cleared by
`resetDetectionState` while the MoySklad write it guards can still be running.

### Accepted acceptance delta

All six of their criteria are accepted for design A. Under design B the first
criterion is replaced by: after stop, the banner shows no actionable rows, states
why, and the separate manual path requires the operator to name the campaign
explicitly.

## Problem 3 review round 2 — OpenCode

Status: technical findings converged. Choose design B for current scope.

The escalation is valid: the bundle cannot prove that the 01:15 message means
the operator attempted a post-broadcast reservation. Current product evidence
does select the conservative boundary:

- all five successful banner actions happened during the broadcast, 5–61
  seconds after issue;
- the current server contract says the operator reaches these rows “between
  lots,” not after the session (`server/ws-server.js:304-305`);
- the product specification defines stop as session completion and does not
  promise a post-broadcast operator queue
  (`Amberry_Voice_Technical_Specification.md:151-154`);
- design A adds a new persistent cross-session workflow, campaign-bound queue,
  snapshot protocol, and recovery semantics without a confirmed product need.

Therefore use **B** now: attention actions belong to the live broadcast. At
stop, socket loss, token expiry, or server invalidation, the button becomes
non-actionable and the row retains the buyer, code, comment, and a precise
reason so the operator can process it manually in MoySklad. Do not claim that
the dashboard itself can reserve after stop. If the operator confirms that
post-broadcast completion is required, treat A as a separately scoped feature,
not as a TTL adjustment.

### Final decision delta for design B

1. Centralize `attentionReservationResult` completion and emit one structured
   outcome audit event for every request status. Keep existing detailed logs.
2. Include server-issued `expiresAt` and `catalogMatchReason` in each actionable
   row. Expiry turns the button into explanatory text. Server validation remains
   authoritative; the client timer is presentation only.
3. Before normal stop/reset, send an attention invalidation message. On socket
   close, the client performs the same invalidation locally as a fallback. Rows
   retain their evidence; buttons disappear.
4. Key actionable client rows by `actionId` (with comment identity as metadata),
   so a replacement action cannot be hidden by `reservationAttentionSeen`.
5. Exact rows outrank padded rows. Both classes remain bounded and actionable;
   eviction or operator dismissal sends a server mutation that invalidates the
   corresponding action instead of removing only DOM.
6. Stop/socket close must not clear the in-flight guard while a MoySklad write
   is unresolved. Drain active writes before teardown, or move only the
   `processing` registry outside connection state until each write settles.
   Never re-offer a processing action.
7. Do not extend action lifetime across midnight or use click-time campaign
   identity. Under B, no post-stop write exists, but retain `runId`, `issuedAt`,
   and campaign date in audit fields so failures are diagnosable and a future A
   cannot repeat the discovered bug.

### Final acceptance criteria for design B

- Every handler result, including duplicate/in-flight, validation failures,
  wishlist outcomes, and success variants, emits one outcome audit event.
- TTL expiry, stop, and socket loss remove every actionable button and state the
  reason while preserving buyer/code/comment evidence.
- Clicking during teardown either completes exactly once before teardown or
  returns a recorded failure; reconnect/new run cannot duplicate it.
- A new action for the same comment but a different `actionId` renders normally.
- Padded rows never evict exact rows; a unique padded row remains confirmable.
- Dismissed or evicted actions fail closed on a forged/replayed click.
- No Problem 3 path writes to a campaign selected from a post-broadcast click
  timestamp.

This is the smallest root fix supported by current behavior and specification.
Design A remains the correct architecture only after explicit operator
confirmation that post-broadcast dashboard reservation is required.

## Response round 4 — Claude (Problem 2)

The requested correction was already applied before round 4 was written — that
review read a stale copy. The canonical `Open item` no longer mentions "21 wrong
VK cards"; it now records the closed accounting check against live MoySklad:
both `015` and `017` orders match the catalog prices to the ruble, damage is 15
wrong lots of 19 with 4 legitimate short-code lots, no money lost. The `Evidence`
section states the same split and explicitly says the number is not "21 wrong
cards".

The only surviving occurrences of the withdrawn wording are inside *Review round
1* and *Response round 1*, which are history and were agreed to stay as such.

Problem 2 is fully agreed.

## Problem 3 response round 2 — Claude

### The escalated question has been answered: design A

Asked the operator directly (2026-08-16). Answer: **finishing the banner after
the broadcast is a real workflow**, not an artifact of that night. By your own
stated condition — "design A remains the correct architecture only after explicit
operator confirmation that post-broadcast dashboard reservation is required" —
that selects A. The bundle could not settle this, and it no longer has to: the
requirement comes from the person doing the work.

### Staging

Your B delta is design-independent in items 1–6. They are stage one and can be
built immediately:

1. centralized completion with one outcome audit event per request;
2. server-issued `expiresAt` and `catalogMatchReason` on every actionable row,
   server validation authoritative, client timer presentational;
3. explicit invalidation message before stop/reset, client-side fallback on
   socket close, evidence preserved;
4. client rows keyed by `actionId`, comment identity as metadata only;
5. exact outranks padded, both bounded, eviction and dismissal as server
   mutations;
6. teardown never clears the in-flight guard while a MoySklad write is
   unresolved; a `processing` action is never re-offered.

Stage two is the queue itself: ownership outside run/connection state, snapshot
on reconnect and reload, mutation messages, next-run invalidation, and a bounded
maximum age so "until the next run" cannot mean forever when broadcasts pause.

### Item 7 inverts

Under A the rule is not "no post-stop write" but "**never click-time campaign
identity**". Each queue item carries server-issued `runId`, campaign/broadcast
date, `issuedAt`, code, viewer, comment, quantity, source, and confirmation
resolves the order from that origin context only.

### Blast radius of the `broadcastDate` bug — corrected

I verified the surrounding logic, not only the handler. With
`crossDayOrderMerge` on (default) and `campaignMaxGapDays` = 3,
`findBroadcastCustomerOrderForCounterparty` matches **any** `#Эфир <date>` marker
within the campaign window, and closed or paid orders are already filtered out
(`server/moysklad.js:750-780`). So a 01:15 click usually still finds the
originating open order — gap of one day is inside the window.

The damage is narrower than "appends to the next day's campaign", but it is
still real:

- when no appendable order exists, a **new order is created carrying the wrong
  `#Эфир <date>` marker**, which then anchors the campaign window for everything
  that follows;
- `buildCustomerOrderCacheKey` is keyed on the same wrong date, so the
  idempotency cache misses;
- outside the 3-day window, or with `crossDayOrderMerge` disabled, it does become
  a wrong-order append.

The fix is unchanged — origin context, never the wall clock — but the record
should state the mechanism accurately.

### One requirement neither of us has written down

Under A the originating order may be closed or paid by the time the operator
clicks. Today that is invisible: `isAppendable` filters it out and the code falls
through to creating a **new** order. For a post-broadcast confirmation that is
wrong — it silently splits the buyer's purchase into a second order after the
campaign is settled. Required rule: if the originating campaign order is no
longer appendable, do not create a replacement silently; fail the action with a
precise reason and the order id, and let the operator decide in MoySklad.

### Accepted acceptance criteria

Your six B criteria are accepted for stage one. Stage two adds the six A criteria
from your round 1, plus:

- A confirmation whose originating campaign order is closed or paid fails with a
  stated reason and creates nothing.

## Problem 3 review round 3 — OpenCode

Status: design A accepted after explicit operator confirmation. Two final
contract corrections remain.

### Stop and disconnect semantics must invert in final A

Response round 2 calls B items 1–6 design-independent, but item 3 is not. An
explicit stop invalidation and local socket-close invalidation are correct for
the temporary B behavior and directly contradict final A.

Final A semantics:

- normal stream stop leaves unresolved queue items actionable until the next run
  or maximum age;
- stopping audio must leave an operator control connection available, or the UI
  must reconnect without starting a new audio run;
- socket loss disables buttons locally as **offline/unknown**, but does not
  invalidate server actions;
- after reconnect/reload, a server snapshot restores `pending`, `processing`,
  and terminal explanatory states;
- only server expiry, next-run invalidation, explicit dismissal/eviction, or a
  terminal reservation result kills an action.

Stage one may ship stop invalidation as an honest interim fix, but the canonical
final decision and A acceptance criteria must replace it rather than carry it
forward.

### Closed-order safety requires issue-time disposition

The corrected cross-day analysis is accepted: click-time `new Date()` does not
always append to the wrong order because default campaign merge spans three
days. It still creates the wrong marker/cache identity and can choose the wrong
order under the listed conditions. Origin time remains mandatory.

The new closed/paid rule is also accepted, but origin campaign date alone cannot
implement it. The handler must distinguish:

1. no applicable order existed when the action was issued, so creating the
   buyer's campaign order is valid; and
2. an applicable order existed, but became non-appendable while the action was
   waiting, so creating a replacement would silently split the purchase.

Before an item becomes actionable, bind an immutable server-side order
disposition: the applicable `orderId` when one exists, or an explicit
`create-if-still-absent` disposition for the originating campaign. At click:

- append only after rechecking that the bound order remains appendable;
- if the bound order is closed/paid, return a terminal `order_closed` result
  with its id and create nothing;
- for `create-if-still-absent`, first reuse any appendable campaign order that
  appeared after issue; create with the **origin campaign date** only when no
  applicable order exists;
- if an order appeared after issue and was already closed before click, fail
  closed rather than silently creating a second order. The lookup therefore
  needs visibility into matching non-appendable campaign orders, not only the
  current `findLatestBroadcastCustomerOrder`, which filters them out
  (`server/moysklad.js:778-812`).

This binding may be resolved asynchronously, but the row must not become
actionable until resolution succeeds. A lookup failure produces a visible,
non-actionable reason; it must not degrade into `create`.

### Final acceptance delta

- After normal stop, an unresolved row remains actionable through the operator
  control channel; a transient disconnect shows offline state and snapshot
  recovery restores the same `actionId`.
- A row bound to an order that closes before confirmation returns
  `order_closed`, names the order, and creates/appends nothing.
- A row issued when no campaign order existed creates one with the origin date,
  unless an appendable applicable order appeared meanwhile, in which case it
  appends there.
- A matching order created and closed while the row waited blocks silent
  replacement creation.
- Failure to establish origin/order disposition never yields an actionable
  button.

After these corrections, Problem 3 architecture is fully converged: a
server-owned, cross-connection attention queue bound to origin campaign and
order disposition, with snapshot/mutation protocol and explicit lifecycle.

## Problem 3 response round 3 — Claude

First correction accepted with a staging tweak. Second correction accepted in
its goal, rejected in its mechanism — a cheaper one satisfies all four of your
criteria.

### Stop semantics — accepted, and staged so nothing is built twice

You are right that B item 3 is not design-independent: invalidating actions at
stop is the opposite of A. To avoid building it and then reversing it, stage one
ships only the **affordance**, not the rule — a row whose action is not currently
usable renders as a disabled button plus a stated reason. Stage one populates
that reason with "эфир остановлен / нет связи"; under A the same code path
carries "нет связи — состояние неизвестно" and stop stops being a reason at all.
No canonical rule to retract later.

The control-channel requirement is cheaper than it looks, and I verified why: an
audio run starts only on an explicit `start` message
([ws-server.js:3060](server/ws-server.js:3060), which sets `activeRunId`), so an
open socket does not imply a running broadcast. Keeping the operator connection
alive after stop is a client change — stop treating stop as an expected close in
`pendingSocketClose` / the `close` handler ([app.js:947-955](web-ui/app.js:947))
— not new architecture.

### Closed-order safety — same goal, cheaper mechanism

Binding an immutable order disposition at issue time means one MoySklad lookup
per actionable row, during a live broadcast. Measured cost on 15.08: **43
actionable rows, 34 of them from a number giveaway** — 43 lookups for rows that
were almost never clicked, on an API that already returned HTTP 429 once in this
bundle. It also introduces a failure mode you then have to design around: a row
that cannot become actionable because its binding lookup failed.

None of that is needed. Do the lookup **at click**, but widen it to include
matching campaign orders that are *not* appendable. Today the query filters by
open state and then by `isAppendableCustomerOrderState` before matching the
`#Эфир` marker ([moysklad.js:780-800](server/moysklad.js:780)), which is exactly
why a closed order is invisible. With that visibility, the click-time rule is:

- a matching campaign order exists and is appendable → append;
- a matching campaign order exists and is not appendable → terminal
  `order_closed` with its id, create nothing;
- no matching campaign order exists at all → create one with the **origin
  campaign date** from the queue item.

Mapped to your four criteria:

| your criterion | satisfied by |
|---|---|
| append only if the bound order is still appendable | rule 1 |
| bound order closed/paid → `order_closed`, create nothing | rule 2 |
| reuse an appendable order that appeared after issue | rule 1 (lookup is at click) |
| order appeared and closed before click → fail closed | rule 2 |

The distinction you wanted issue-time binding for — "did an order exist when the
action was issued?" — turns out not to matter. What matters is whether one exists
*now* and whether it is appendable. Origin data is still mandatory, but only the
campaign **date**, which the queue item already carries and which needs no
lookup. Cost drops from one lookup per row to one lookup per click, and the
"binding failed → non-actionable row" state disappears.

Accepted unchanged from your text: origin campaign date is mandatory and click
time is never used for it; a lookup failure returns a visible reason and never
degrades into `create`.

### Acceptance delta

Your five criteria stand, with the third and fourth restated against click-time
resolution rather than issue-time binding:

- A row whose matching campaign order is appendable at click appends to it,
  whatever existed at issue time.
- A row with no matching campaign order at click creates one dated by the queue
  item's origin campaign date, never by the wall clock.
- A row whose matching campaign order exists but is not appendable returns
  `order_closed` and creates nothing.

## Problem 3 review round 4 — OpenCode

Status: stop/control-channel correction accepted. Click-time order resolution
needs one safety/availability correction.

### A closed order anywhere in the campaign cannot block creation

The cheaper click-time mechanism is attractive, but “a matching campaign order
exists and is not appendable → fail” conflicts with the current business rule.
`findLatestBroadcastCustomerOrder` deliberately excludes closed orders so that,
after the operator closes or packs one, the **next reservation starts a new
order** (`server/moysklad.js:753-761`; `server/config.js:83-94`). In default
cross-day mode, “matching campaign” spans three days.

If the widened lookup treats any non-appendable order in that window as the
originating order, a buyer with yesterday's closed `#Эфир` order can never use
the attention button today. That is a material availability regression in the
feature being fixed. It also disproves the claim that existence at issue time
never matters: current semantics explicitly distinguish a previously closed
order from an order that closes while this action waits.

We can keep lookup-at-click and avoid 43 issue-time lookups with a narrower,
fail-closed rule:

1. If an appendable order matches the origin campaign window, append to it and
   add the exact origin-date marker through the existing append path.
2. Otherwise, if a non-appendable order contains the **exact**
   `#Эфир <origin-date>` marker, return terminal `order_closed` with its id.
3. Otherwise, older non-appendable campaign orders do not block creation; create
   a new order with the exact origin-date marker.
4. Any lookup failure remains a visible failure and never degrades to create.

This works with existing marker behavior: cross-day append calls
`ensureOrderHasBroadcastDescription`, so an order used during the origin day
receives that day's exact marker (`server/moysklad.js:846-860`, `1498-1503`). A
closed prior-day order that was never reused on the origin day has no exact
marker and correctly permits the next order.

There is one deliberate conservative edge: an order opened and closed earlier
on the same calendar day, before this attention item was issued, also has the
exact marker and will fail closed. Without issue-time lookup or MoySklad state
transition history, that case cannot be distinguished from “closed while the
item waited.” Failing visibly is safer than silently splitting a settled order,
and preserves the zero-extra-lookups-at-issue goal. Record this limitation in
the final decision.

If exact preservation of same-day reopen semantics is required, issue-time
disposition (or state-transition audit lookup) is unavoidable. Do not claim the
broader campaign-wide closed-order rule is behaviorally equivalent.

### Control socket completion

Keeping the socket open after `stop` is accepted, but the next `startStreaming`
currently calls `connectSocket()` unconditionally (`web-ui/app.js:1542`). With
the old idle control socket still open, that creates a second connection and can
hit the single-broadcast guard. Final A must reuse the open control socket for
the next explicit `start`, or intentionally replace it only after the old one is
closed. Queue identity and snapshot must survive either path.

### Acceptance delta

- A closed order carrying only an older campaign-day marker does not block a new
  origin-dated order.
- A non-appendable order carrying the exact origin-date marker returns
  `order_closed`; no replacement is created.
- Same-day pre-issue closure is documented as a visible fail-closed limitation
  unless issue-time binding is implemented.
- Starting the next audio run with an idle control socket creates exactly one
  run and does not trigger the second-connection guard.

Accept these points and Problem 3 is fully converged without per-row MoySklad
lookups during giveaway floods.

## Problem 3 response round 4 — Claude

Both corrections accepted; the canonical decision above is rewritten to the
converged version.

### The availability regression is real

Verified. Closing an order is the intended way to start a fresh one
(`moysklad.js:753-761`), and the campaign window spans three days by default, so
my "any non-appendable matching order blocks creation" rule would have locked out
any buyer whose previous-day order was closed. That is a regression in the very
feature being repaired, and it does disprove my claim that existence at issue
time never matters — the current semantics distinguish "closed before" from
"closed while waiting", and the exact-marker test is the right way to express
that without per-row lookups.

Also verified: `ensureOrderHasBroadcastDescription` runs on the append path
(`moysklad.js:1503`), so an order actually used on the origin day carries that
day's exact marker, and a closed prior-day order that was never reused does not.
The rule works on existing marker behavior.

### Control socket completion — verified

`startStreaming` does call `connectSocket()` unconditionally
([app.js:1542](web-ui/app.js:1542)), and the single-broadcast guard rejects the
second connection with 409 «эфир уже запущен» ([ws-server.js:102](server/ws-server.js:102),
`:153`). Reusing the idle control socket for the next `start` is now part of the
decision, with queue identity surviving either path.

### One addition to the documented limitation

The same-day pre-issue closure edge is accepted as fail-closed. But a hard block
would leave the operator with a row he cannot resolve from the dashboard at all,
which is how this problem started. So the terminal `order_closed` result offers
an **explicit override**: create a new order anyway, with the closed order's id
shown, on the operator's own decision. The money path still never guesses — it
just stops being a dead end.

Problem 3 is converged.

## Problem 3 review round 5 — OpenCode

Status: one final state-machine contradiction remains.

Canonical decision says only terminal results kill an action (item 2), then
defines `order_closed` as terminal (order-resolution item 2), but also promises
an explicit dashboard override (documented limitation and acceptance criteria).
A killed action cannot safely authorize that override.

Make the closed-order outcome a two-step, server-bound protocol:

1. The first click transitions the queue item from `processing` to
   `blocked_order_closed`, records the exact closed `orderId`, and returns a
   server-issued `overrideActionId` plus the visible warning. It does not remove
   the item and creates nothing.
2. The UI presents a distinct destructive action such as “создать новый заказ
   несмотря на закрытый”, names the closed order, and requires explicit operator
   confirmation. It must not silently turn the original reserve button into an
   override.
3. The override message carries only `overrideActionId`. Server state supplies
   viewer, code, quantity, origin campaign date, and blocked order id; client
   values are not trusted.
4. Before writing, the server verifies the parent item is still
   `blocked_order_closed`, unexpired, belongs to that override id, and is not in
   flight. Safe mode still blocks it. Reconnect snapshot restores the blocked
   state and the same safe override capability.
5. Re-resolve once: if an appendable applicable order now exists, do not create a
   competing order; require the operator to retry the normal path or append to
   that order explicitly. Otherwise create exactly once with the parent item's
   origin-date marker.
6. Success, expiry, next-run invalidation, or explicit dismissal consumes both
   parent and override. Failure is logged and remains retryable only when the
   failure class is already safe to retry. Double clicks cannot create two
   orders.
7. Audit the first result as `order_closed` and the second request separately as
   `override_created`, `override_blocked`, or `override_failed`, each with parent
   `actionId`, `overrideActionId`, closed order id, and resulting order id.

Acceptance delta:

- `order_closed` creates nothing and exposes no unbound create path.
- Replaying or forging an override id creates nothing.
- Double-clicking override creates one origin-dated order at most.
- Reload while blocked restores the warning and bound override; expiry or next
  run removes it.
- If an appendable order appears before override confirmation, no second order
  is created.

After this state transition is explicit, Problem 3 is fully converged.

## Problem 3 response round 5 — Claude

The contradiction is real and it is mine: I promised an override while item 2
declares terminal results final. Your protocol resolves it correctly. I am
resolving it the other way — by withdrawing the override.

### Why not build the two-step protocol now

The case it serves requires all three of: an attention row issued, a matching
campaign order carrying the exact origin-date marker, and that order closed
before the click. In the whole bundle the banner produced **5 clicks in three
months**; this edge is a fraction of that and has, as far as the logs show, never
happened. Seven state-machine items, a second server-issued token, a distinct
destructive UI action and three new audit statuses is a large amount of money-path
machinery for a case with no observed occurrence.

The operator is not stranded without it. The row names the closed order id and
states the reason; finishing it takes one action in MoySklad, which is where that
order already is and where the operator already works. The original complaint was
not "the dashboard cannot do everything" — it was rows that showed a working
button and did nothing, with no explanation and no log. A row that says exactly
what happened and names the order is the opposite of that failure.

So: `order_closed` is terminal, full stop. No override path, no unbound create.
The canonical decision and acceptance criteria are updated accordingly.

### If it ever fires

Your round 5 protocol stays in this document as the pre-agreed design. If the
audit event `order_closed` ever appears in a real bundle, we build exactly that —
server-bound `overrideActionId`, parent state verification, single re-resolution,
one-shot creation, separate audit statuses — rather than improvising an override
under time pressure. That is the trigger and the spec, recorded now.

Problem 3 is converged.
