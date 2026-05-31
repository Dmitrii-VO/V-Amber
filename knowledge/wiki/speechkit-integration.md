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

## Audio capture pipeline (landed)

- **Client chunking** — `web-ui/audio-processor.js` buffers ~100 ms of PCM
  before posting to the main thread (was: every 128-frame render quantum →
  ~375 tiny WebSocket messages/sec). The main thread downsamples each chunk to
  16 кГц and sends it. Matches Yandex's recommended chunk size and removes
  per-frame overhead.
- **Proactive reconnect** — `server/ws-server.js` (`openSpeechKitSession`)
  rotates the gRPC session ~1 min before Yandex's ~10 min cutoff
  (`YANDEX_SPEECHKIT_RECONNECT_MS`, default 9 min). The new session is created
  and swapped into `session` *before* the old one is closed, so audio chunks
  are never dropped in the close→create gap. A per-session `speechKitEpoch`
  guard makes the retired session's `onEnd`/`onError` no-ops (no double
  reconnect). Covered by `test/ws-server.reconnect.test.js`. The reactive
  `onEnd` path remains a safety net if the proactive timer is missed.

## Backlog / TODO

Findings from the 2026-05-31 speech-recognition review, deferred for a later
pass (in rough priority order):

- [ ] **Resampling quality for non-integer ratios.** `downsampleToInt16`
  (`web-ui/app.js`) box-averages without a proper anti-alias low-pass; for
  44.1 кГц → 16 кГц (ratio 2.75) the averaging window drifts via `Math.round`.
  Try requesting `new AudioContext({ sampleRate: 16000 })` to avoid resampling
  where the browser supports it; otherwise add a real low-pass.
- [ ] **Microphone level indicator.** `monitorGain` is muted and no VU meter
  is shown — the operator only learns the mic is dead/muted by the absence of
  transcripts. Add a level meter + "silence for N seconds" warning.
- [ ] **De-duplicate Russian numeral dictionaries.** `UNIT_WORDS`/`TEEN_WORDS`/
  `TENS_WORDS`/`HUNDREDS_WORDS` are copied across `article-extractor.js`,
  `price-detector.js`, `discount-detector.js`. Extract a shared
  `server/ru-numerals.js` so a fix in one place can't be forgotten in the
  others.
- [ ] **Use SpeechKit confidence.** `speechkit-stream.js` takes
  `alternatives[0]` blind to confidence; low-quality finals enter article
  detection on equal footing with confident ones. Pass confidence through and
  gate the YandexGPT fallback / publication on it.
- [ ] **Tune the EOU pause.** `maxPauseBetweenWordsHintMs: 700`
  (`speechkit-stream.js`) splits a code+price spoken in one breath into two
  finals — directly relevant to the operator request to publish price together
  with the lot card (see [[voice-price-parsing]]). Make it configurable and
  test against real recordings.

See [[voice-price-parsing]] and [[operator-feedback]].
