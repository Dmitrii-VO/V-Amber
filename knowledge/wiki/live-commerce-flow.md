# Live commerce flow

The main V-Amber workflow starts with operator speech and ends with a published
VK lot card plus reservation handling.

## Flow

1. The operator opens the browser UI and starts microphone streaming.
2. Browser audio goes to the backend over WebSocket.
3. `server/speechkit-stream.js` streams audio to Yandex SpeechKit.
4. Final transcripts are processed by `server/ws-server.js`.
5. `server/article-extractor.js` extracts a product code, helped by
   `server/product-code-cache.js` and `server/product-code-resolver.js` when the
   catalog is loaded.
6. `server/moysklad.js` loads product and stock data.
7. `server/vk.js` publishes the lot card to VK.
8. VK comment polling watches for `бронь` and other buyer signals.

## Product-code normalization

Operator code detection validates against the MoySklad product-code cache when
the cache is available. `server/product-code-resolver.js` is the shared resolver
for voice detection and manual code entry:

- exact catalog codes win first;
- a code without leading zeroes can resolve to a single matching catalog code
  (`243` → `00243`);
- trailing size or length words can still be trimmed by prefix matching,
  including the missing-leading-zero form (`26250` → `00262` when `00262` is the
  only match);
- ambiguous leading-zero matches are rejected instead of opening a guessed lot.

This keeps the voice path and `manualCode` gate symmetric. Downstream lot
opening, MoySklad product-card lookup, and VK publishing use the resolved catalog
code.

## Price and discount speech

`server/price-detector.js` and `server/discount-detector.js` detect spoken
prices and discounts. The operator feedback page records a durable request to
publish a lot immediately with price when the operator says product code and
price in one phrase. See [[voice-price-parsing]] and [[operator-feedback]].

## Related pages

- [[reservation-flow]]
- [[speechkit-integration]]
- [[vk-integration]]
- [[vk-comments]]
- [[moysklad-integration]]
