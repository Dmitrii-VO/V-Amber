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
- **Microphone level indicator** — `web-ui/` shows a VU meter in the transcript
  panel header (`#micMeter`), fed by the per-chunk RMS computed in the worklet
  `onmessage` handler (`updateMicLevel` / `computeRms` in `web-ui/app.js`). A
  1 s timer (`startMicMonitor`) flags `🔇 тишина` and logs a warning when the
  RMS stays below `MIC_SILENCE_RMS` for `MIC_SILENCE_MS` (4 s) — so a muted or
  wrong mic is visible without waiting for empty transcripts.
- **Shared numeral dictionaries** — `UNIT_WORDS`/`TEEN_WORDS`/`TENS_WORDS`/
  `HUNDREDS_WORDS`/`THOUSANDS_MULTIPLIERS` now live in `server/ru-numerals.js`
  and are imported by `article-extractor.js`, `price-detector.js`,
  `discount-detector.js`. `article-extractor` extends the base `UNIT_WORDS`
  with zero and derives its string `DIGIT_WORDS` from it; `price-detector`
  keeps its own `ZERO_WORDS`. Behavior is unchanged (38 detector tests green).

## Backlog / TODO

Findings from the 2026-05-31 speech-recognition review, deferred for a later
pass (in rough priority order):

- [ ] **Resampling quality for non-integer ratios.** `downsampleToInt16`
  (`web-ui/app.js`) box-averages without a proper anti-alias low-pass; for
  44.1 кГц → 16 кГц (ratio 2.75) the averaging window drifts via `Math.round`.
  Try requesting `new AudioContext({ sampleRate: 16000 })` to avoid resampling
  where the browser supports it; otherwise add a real low-pass.
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
