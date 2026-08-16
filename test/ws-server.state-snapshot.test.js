import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/ws-harness.js";

// Полный слепок состояния — диагностическая «реперная точка» раз в 30 секунд,
// так и написано над emitStateSnapshot. Фактически он писался ещё и из каждого
// emitState, то есть на каждое изменение лота: 1014 снимков за 71 минуту вместо
// 142. Из-за этого jsonl эфира дорос до 31 МБ и бандл обрезал первые 50 минут —
// диагностика теряла ровно то, ради чего снимок и делается.
// Разбор: knowledge/wiki/broadcast-slowdown.md.

const CARD = {
  id: "p-03048", name: "Бусы «Галька»", code: "03048",
  pathName: "Украшения/Бусы", salePrice: 2200, availableStock: 5,
};

function createCountingSessionLog(snapshots) {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === "then") return undefined;
      if (prop === "getFilePath" || prop === "getJsonl") return () => null;
      if (prop === "flush") return async () => {};
      if (prop === "logStateSnapshot") return (payload) => snapshots.push(payload);
      return () => {};
    },
  });
}

test("мутации лота не пишут снимок состояния — только таймер", async () => {
  const snapshots = [];
  const harness = await startHarness({
    cardsByCode: { "03048": CARD },
    knownCodes: ["03048"],
    createSessionLog: () => createCountingSessionLog(snapshots),
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();

    client.send({ type: "manualCode", code: "03048" });
    await client.waitFor((m) => m.type === "state" && m.activeLot);

    client.send({ type: "setLotPrice", value: 8800 });
    await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.salePrice === 8800,
      { timeoutMs: 6000 },
    );

    harness.vk.pushComment({ id: 101, fromId: 5001, text: "03048", firstName: "Аня" });
    await client.waitFor(
      (m) => m.type === "state"
        && m.activeLot?.reservations?.events?.some((e) => e.status === "reserved" || e.status === "reserved_appended"),
      { timeoutMs: 6000 },
    );

    assert.equal(
      snapshots.length,
      0,
      "снимок пишет только 30-секундный таймер, а не каждое изменение лота",
    );
  } finally {
    await client.close();
    await harness.close();
  }
});
