# Voice control hardening plan

This page records the current weak points in voice-controlled live commerce and
the recommended fixes. It complements [[live-commerce-flow]],
[[speechkit-integration]], and [[voice-price-parsing]] by focusing on reliability
work rather than implemented behavior.

## Target state

Voice stays the fast path for the operator, but every irreversible or public
action must have one of three protections: a catalog-backed match, an explicit
operator confirmation, or a fast rollback path.

- Product-code opening remains automatic only when the code is catalog-backed
  or the operator explicitly accepts running without the catalog.
- Price and discount updates remain fast, but risky changes surface a visible
  undo or confirmation affordance.
- STT behavior becomes measurable against real broadcast audio instead of tuned
  from anecdotes.
- `server/ws-server.js` stops carrying all voice, lot, reservation, and external
  write logic in one module.

## Priority 1: Make STT segmentation configurable

SpeechKit currently uses a hard-coded end-of-utterance pause:
`maxPauseBetweenWordsHintMs: 700` in `server/speechkit-stream.js`. This can split
one natural operator phrase, such as `код товара 03204 цена 2500`, into separate
final transcripts.

Recommended changes:

- Add `YANDEX_SPEECHKIT_EOU_PAUSE_MS` to `server/config.js` with a default that
  preserves current behavior.
- Pass the configured value into `createSessionOptions` in
  `server/speechkit-stream.js`.
- Add focused tests that assert the value reaches the SpeechKit session options.
- Re-test real operator recordings at 700 ms, 1000 ms, and 1300 ms before
  changing the default.

Done when code-plus-price phrases are less likely to split while single-product
lot switching still feels responsive during a live stream.

## Priority 2: Add a catalog-required start mode

The browser starts a stream even when product-code cache refresh fails. That is
useful during operations, but it weakens the voice gate because raw detected
codes can reach the lot-opening path before the catalog can reject them.

Recommended changes:

- Add an operator-visible choice when cache refresh fails: **Start in safe
  catalogless mode** or **Retry catalog load**.
- In catalogless mode, allow manual code entry but require confirmation before
  voice-detected codes publish a VK lot card.
- Make the server include a `catalogReady` flag in emitted state so the UI can
  show whether automatic voice opening is fully protected.
- Log every catalogless voice detection with `reason: "catalog_unavailable"`.

Done when a cache outage no longer silently degrades voice detection into a less
trusted mode.

## Priority 3: Confirm or undo voice discounts

Voice discounts are applied automatically in `applyDiscount`. The parser rejects
vague phrases and invalid amounts, but a valid-looking STT mistake can still
change the active lot immediately.

Recommended changes:

- For discounts, send a `voiceDiscountSuggestion` event instead of applying the
  mutation immediately when the source is voice.
- Show a short-lived **Apply discount** button in the active-lot panel, similar
  to the existing voice quantity confirmation flow.
- Keep manual discount paths, if added later, separate from voice suggestions.
- If immediate application is preferred for operator speed, add a visible
  **Undo discount** action with a 10 to 15 second TTL and log whether it was
  used.

Done when one mistranscribed discount cannot silently alter the lot without an
operator-visible recovery path.

## Priority 4: Make voice price changes observable and reversible

Voice price application is safer than discount application because it does not
overwrite an existing usable MoySklad sale price. The risk remains when the
product lacks a sale price and the voice result fills `voicePrice`.

Recommended changes:

- Add a visible `priceSource` badge in the active-lot UI: `МойСклад`, `голос`,
  or `вручную`.
- When `priceSource === "voice"`, show a one-click edit affordance and keep the
  current manual price override path as the correction mechanism.
- Log `voice_price_applied` with whether the price was published to VK, not only
  whether local state changed.
- Add a regression test for code-plus-price flow across split finals after the
  EOU setting is configurable.

Done when the operator can immediately see that a price came from voice and can
correct it without hunting through controls.

## Priority 5: Build an STT benchmark harness

SpeechKit versus Whisper cannot be decided reliably from general model quality.
The project needs a small benchmark built from real broadcasts and judged by
domain outcomes.

Recommended changes:

- Save or import redacted audio snippets for representative phrases: product
  code, code plus price, discount, cancellation, and quantity append.
- Create a script that runs the same snippets through the current SpeechKit path
  and a Whisper candidate, such as `faster-whisper`.
- Score domain metrics, not only word error rate: product-code accuracy, price
  accuracy, discount accuracy, false lot opens, missed commands, and latency.
- Keep Whisper in shadow mode until it wins on both accuracy and acceptable
  latency for the operator's machine.

Done when STT choice is backed by a repeatable report and not by isolated live
failures.

## Priority 6: Split voice orchestration out of `ws-server.js`

`server/ws-server.js` owns STT handlers, lot state, VK polling, reservations,
wishlist, safe mode, and several parsers. The file is large enough that voice
changes carry avoidable regression risk.

Recommended split order:

- Move voice command dispatch from `onFinal` into a `server/domain/voice-actions.js`
  module that returns typed actions: cancel suggestion, quantity suggestion,
  discount suggestion, price result, or article detection request.
- Move article detection orchestration into a small module that owns
  `voicePipeline.buildDetectionInputs`, `detectArticle`, and the confirmed versus
  ambiguous decision.
- Keep external writes in `ws-server.js` until the extracted modules are covered
  by integration tests. This preserves the current safe-mode and race guards.
- Split only one seam at a time and run the full `npm test` suite after each
  extraction.

Done when voice parser decisions can be tested without booting the full WebSocket
harness, while money writes still stay behind the existing guarded paths.

## Priority 7: Centralize voice vocabulary

Command phrases are currently split across config and parser modules. This is
acceptable for a small MVP, but it makes operator-language changes more fragile.

Recommended changes:

- Create a single voice vocabulary module for command triggers, filler words,
  and operator-facing examples.
- Keep environment overrides for article and discount triggers, but normalize
  them through the shared module.
- Add tests for common operator variants before adding new accepted phrases.
- Record newly observed phrases in [[operator-feedback]] or this page before
  implementing broad parser changes.

Done when adding a new operator phrase requires one vocabulary change and one
focused test, not a search across unrelated parser files.

## Recommended implementation order

This order reduces live-stream risk first, then improves architecture.

1. Make SpeechKit EOU pause configurable and test real recordings.
2. Add catalog-ready UI/state and an explicit catalogless mode.
3. Add discount confirmation or undo.
4. Add voice-price source visibility and split-final regression tests.
5. Build the STT benchmark harness and run SpeechKit versus Whisper in shadow
   mode.
6. Extract voice action dispatch from `ws-server.js`.
7. Centralize voice vocabulary after the extracted dispatch module exists.

## Non-goals

These items are intentionally out of scope for the first hardening pass.

- Do not replace SpeechKit with Whisper before benchmark data exists.
- Do not auto-execute voice cancellation or voice quantity append. The current
  confirm-by-click contract protects real MoySklad writes and must remain.
- Do not make the LLM fallback publish unvalidated codes. Catalog validation is
  the safety boundary for LLM output.
- Do not remove manual operator controls. They are required recovery paths for
  voice failures.

## Related pages

These pages describe the behavior that this plan changes or protects.

- [[live-commerce-flow]]
- [[speechkit-integration]]
- [[voice-price-parsing]]
- [[operator-feedback]]
- [[reservation-flow]]
- [[testing-guide]]
