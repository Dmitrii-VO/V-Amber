import { test } from "node:test";
import assert from "node:assert/strict";
import { createVkPublisher } from "../server/vk.js";

// getQueuePressure отдаёт состояние общей VK-очереди: адаптивный множитель
// backoff после VK 6 и длины полос. Потребитель — poll-цикл ws-server,
// который под давлением растягивает интервал опроса комментариев.

const BASE = { userToken: "user-tok", liveOwnerId: "-1", liveVideoId: "2", apiMinIntervalMs: 1 };

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test("без трафика давление нулевое: multiplier=1, очереди пустые", () => {
  const pub = createVkPublisher(BASE);
  assert.deepEqual(pub.getQueuePressure(), {
    backoffMultiplier: 1,
    highPending: 0,
    lowPending: 0,
  });
});

test("после VK 6 multiplier растёт, после успеха затухает халвингом", async () => {
  let rateLimited = true;
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      return rateLimited
        ? { error: { error_code: 6, error_msg: "Too many requests per second" } }
        : { response: { items: [] } };
    },
  }));
  try {
    const pub = createVkPublisher(BASE);

    await assert.rejects(() => pub.getComments(1), /VK API 6/);
    assert.equal(pub.getQueuePressure().backoffMultiplier, 2);

    await assert.rejects(() => pub.getComments(1), /VK API 6/);
    assert.equal(pub.getQueuePressure().backoffMultiplier, 4);

    rateLimited = false;
    await pub.getComments(1);
    assert.equal(pub.getQueuePressure().backoffMultiplier, 2);
    await pub.getComments(1);
    assert.equal(pub.getQueuePressure().backoffMultiplier, 1);
  } finally {
    restore();
  }
});
