# Live commerce flow

The main V-Amber workflow starts with operator speech and ends with a published
VK lot card plus reservation handling.

## Flow

1. The operator opens the browser UI and starts microphone streaming.
2. Browser audio goes to the backend over WebSocket.
3. `server/speechkit-stream.js` streams audio to Yandex SpeechKit.
4. Final transcripts are processed by `server/ws-server.js`.
5. `server/article-extractor.js` extracts a product code, optionally helped by
   `server/product-code-cache.js`.
6. `server/moysklad.js` loads product and stock data.
7. `server/vk.js` publishes the lot card to VK.
8. VK comment polling watches for `бронь` and other buyer signals.

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
