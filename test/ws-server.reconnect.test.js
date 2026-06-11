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

// Анализ 2026-06-11: сетевые мигания приходят от grpc-js как событие error
// (UNAVAILABLE), а не как чистый end, — раньше любой error немедленно
// закрывал ВСЕ открытые лоты в VK и заканчивал эфир. Теперь error получает
// реактивный reconnect (до N попыток), teardown — только после исчерпания.

const CARD_03204 = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};

test("stream error reconnects the STT session and keeps lots open", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
    config: { speechkit: { errorRetryDelaysMs: [20, 20, 20] } },
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    const first = await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot);

    await first.handlers.onError(new Error("14 UNAVAILABLE: connection dropped"));

    await waitFor(() => harness.getLastSpeechKitSession() !== first);
    const second = harness.getLastSpeechKitSession();
    assert.equal(second.closed, false, "новая сессия активна после ошибки");
    assert.equal(
      harness.vk.callsTo("publishLotClosed").length,
      0,
      "лоты НЕ закрываются из-за одиночной ошибки потока",
    );
  } finally {
    client.send({ type: "stop" });
    await client.close();
    await harness.close();
  }
});

test("persistent stream errors exhaust retries and tear the session down", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
    config: { speechkit: { errorRetryDelaysMs: [10, 10, 10] } },
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot);

    // Роняем каждую новую сессию, пока сервер не сдастся и не пришлёт error.
    let stopFailing = false;
    const failLoop = (async () => {
      const failed = new Set();
      while (!stopFailing) {
        const s = harness.getLastSpeechKitSession();
        if (s && !failed.has(s)) {
          failed.add(s);
          await s.handlers.onError(new Error("permanent failure"));
        }
        await new Promise((r) => setTimeout(r, 5));
        if (failed.size > 8) throw new Error("teardown never happened");
      }
    })();
    const errorMsg = await client.waitFor((m) => m.type === "error", { timeoutMs: 6000 });
    stopFailing = true;
    await failLoop;
    assert.equal(errorMsg.type, "error");
    assert.ok(
      harness.vk.callsTo("publishLotClosed").length >= 1,
      "после исчерпания попыток лоты закрываются",
    );
  } finally {
    await client.close();
    await harness.close();
  }
});

// Heartbeat: зомби-сокет (клиент перестал отвечать на ping) должен быть
// прибит сервером, иначе он вечно блокирует реконнект оператора через
// single-broadcast guard (409). Живой клиент (auto-pong) выживает.
test("heartbeat terminates a client that stops answering pings", async () => {
  const harness = await startHarness({
    config: { wsHeartbeatIntervalMs: 25 },
  });
  // Клиент с отключённым auto-pong имитирует полумёртвое соединение.
  const { WebSocket } = await import("ws");
  const deadWs = new WebSocket(harness.url, { autoPong: false });
  await new Promise((resolve, reject) => {
    deadWs.once("open", resolve);
    deadWs.once("error", reject);
  });
  try {
    const closed = new Promise((resolve) => deadWs.once("close", resolve));
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("not terminated")), 2000)),
    ]);
  } finally {
    deadWs.close();
    await harness.close();
  }
});

test("heartbeat keeps a responsive client connected", async () => {
  const harness = await startHarness({
    config: { wsHeartbeatIntervalMs: 25 },
  });
  const client = await harness.connect();
  try {
    let closed = false;
    client.ws.once("close", () => { closed = true; });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(closed, false, "живой клиент не должен отключаться heartbeat-ом");
  } finally {
    await client.close();
    await harness.close();
  }
});
