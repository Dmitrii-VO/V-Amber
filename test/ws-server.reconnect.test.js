import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/ws-harness.js";

// Проактивный реконнект SpeechKit (см. server/ws-server.js openSpeechKitSession).
// Yandex рвёт streaming-сессию через ~10 мин; мы переоткрываем её РАНЬШЕ,
// подменяя session атомарно, чтобы аудио не терялось в окне реконнекта.
// В тестах reconnectIntervalMs делаем крошечным, чтобы ротация сработала
// в пределах теста.

function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("waitFor condition timed out");
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
}

test("proactive reconnect rotates the SpeechKit session and closes the old one", async () => {
  const harness = await startHarness({
    config: { speechkit: { reconnectIntervalMs: 40 } },
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    const first = await harness.waitForSession();

    // Ждём, пока таймер ротации создаст вторую сессию.
    await waitFor(() => harness.getLastSpeechKitSession() !== first);
    const second = harness.getLastSpeechKitSession();

    assert.notEqual(second, first, "должна быть создана новая сессия");
    assert.equal(first.closed, true, "старая сессия закрыта при ротации");
    assert.equal(second.closed, false, "новая сессия активна");

    // Аудио после ротации уходит в живой (новый) стрим, а не в закрытый.
    client.ws.send(Buffer.from([1, 2, 3, 4]));
    await waitFor(() => second.pushedAudio.length > 0);
    assert.equal(second.pushedAudio.length, 1);
    assert.equal(first.pushedAudio.length, 0);
  } finally {
    // stop останавливает таймер ротации, чтобы он не плодил сессии после теста.
    client.send({ type: "stop" });
    await client.close();
    await harness.close();
  }
});

test("manual stop halts proactive reconnect (no further sessions)", async () => {
  const harness = await startHarness({
    config: { speechkit: { reconnectIntervalMs: 40 } },
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    await waitFor(() => harness.getLastSpeechKitSession().closed === false
      && harness.getLastSpeechKitSession().pushedAudio !== undefined);

    client.send({ type: "stop" });
    // Дождёмся, что текущая сессия закрыта по stop.
    await waitFor(() => harness.getLastSpeechKitSession().closed === true);
    const afterStop = harness.getLastSpeechKitSession();

    // Превышаем интервал ротации — новых сессий быть не должно.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(harness.getLastSpeechKitSession(), afterStop, "после stop ротация не продолжается");
  } finally {
    await client.close();
    await harness.close();
  }
});
