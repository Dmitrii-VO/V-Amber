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
- **Reactive reconnect on stream errors (2026-06-11)** — grpc-js surfaces
  network blips as the *error* event (UNAVAILABLE), not as a clean *end*.
  `onError` used to publish «лот закрыт» to VK for every open lot and end the
  broadcast immediately; it now retries `openSpeechKitSession` per
  `config.speechkit.errorRetryDelaysMs` (default `[500, 2000, 5000]`; array
  length = attempt budget, overridable in tests). The attempt counter resets
  on the first recognized transcript. Full teardown
  (`teardownAfterStreamFailure`) runs only when retries are exhausted, with
  the same runId/epoch guards. Covered in `test/ws-server.reconnect.test.js`.
- **Final-transcript serialization (2026-06-11)** — `onFinal` work (article
  detection, voice price, discount) runs through a per-broadcast promise
  chain (`finalProcessingChain`), so commands apply strictly in spoken order
  and a slow YandexGPT fallback can no longer let an older utterance open its
  lot *after* a newer one. Discounts apply after article detection, so
  «артикул NNN скидка 10%» discounts the newly opened lot, and a discount in
  the next phrase waits for the pending lot-open. Detection inputs are still
  captured at utterance time (trigger window is wall-clock based).
- **WS heartbeat (2026-06-11)** — the server pings every operator socket
  (`config.wsHeartbeatIntervalMs`, default 30 s) and terminates those missing
  a pong by the next sweep, so a half-dead connection no longer blocks
  reconnect with 409 via the single-broadcast guard. The browser WebSocket
  answers pings automatically. The web UI auto-reconnects after an unexpected
  close with capped backoff (2–30 s) and skips the cache prompt on resume.
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
- **Capture at 16 кГц natively** — `web-ui/app.js` (`createCaptureAudioContext`)
  requests `new AudioContext({ sampleRate: 16000 })`, so the browser resamples
  the mic with its own high-quality resampler and `downsampleToInt16` becomes a
  no-op (`inputRate === targetRate`). This sidesteps the box-filter drift on
  non-integer ratios (44.1 → 16 кГц). Browsers that ignore the hint fall back
  to the default context + our resampler, and the UI logs which path is active.
- **SpeechKit confidence surfaced (gate dormant)** — `final` confidence is read
  in `speechkit-stream.js`, passed through `onFinal`, and logged in
  `final_transcript` + the session log. A config gate
  (`YANDEX_SPEECHKIT_MIN_CONFIDENCE`, default `0` = off) drops finals only on a
  *positive* confidence below the threshold. **Yandex STT v3 currently always
  returns `confidence: 0`** ("Currently is not used" in the SDK
  `Alternative` type), so the gate is dormant today — the plumbing and lever
  are in place for when the field starts being populated.

## Backlog / TODO

Findings from the 2026-05-31 speech-recognition review, deferred for a later
pass:

- [ ] **Tune the EOU pause.** `maxPauseBetweenWordsHintMs: 700`
  (`speechkit-stream.js`) splits a code+price spoken in one breath into two
  finals — directly relevant to the operator request to publish price together
  with the lot card (see [[voice-price-parsing]]). Make it configurable and
  test against real recordings.

See [[voice-price-parsing]] and [[operator-feedback]].
