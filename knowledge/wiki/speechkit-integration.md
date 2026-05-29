# SpeechKit integration

Yandex SpeechKit Streaming API provides realtime speech-to-text for V-Amber.

## Runtime files

- `server/speechkit-stream.js` manages the streaming session.
- `server/config.js` reads SpeechKit configuration from `.env`.
- `server/ws-server.js` consumes final transcript events.

## Required configuration

`YANDEX_SPEECHKIT_API_KEY` is required for backend startup. Additional optional
values include folder ID, language, and model.

## Downstream parsing

Final transcripts feed article, price, and discount detection:

- `server/article-extractor.js`
- `server/price-detector.js`
- `server/discount-detector.js`

See [[live-commerce-flow]].
