import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarness, createVkMock, createMoyskladMock } from "./helpers/ws-harness.js";
import { createAttentionStore } from "../server/attention-store.js";

// Разбор после эфира. Покупатель пишет код, открытого лота под него нет —
// строка уходит в стор и переживает эфир. Оператор разбирает её потом, когда
// глаза и руки свободны: во время трансляции телефон занят как камера, и за
// 13 эфиров из 6488 строк живого баннера не была отработана ни одна.

const CARD_03204 = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};
const CARD_00777 = {
  id: "p-00777", name: "Браслет", code: "00777",
  pathName: "Украшения/Браслеты", salePrice: 1200, availableStock: 3,
};

async function freshAttentionStore() {
  const dir = await mkdtemp(join(tmpdir(), "attention-ws-"));
  const store = createAttentionStore({ filePath: join(dir, "attention.jsonl") });
  await store.load();
  return store;
}

test("комментарий без открытого лота попадает в разбор и переживает конец эфира", async () => {
  const vk = createVkMock();
  const attentionStore = await freshAttentionStore();
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204, "00777": CARD_00777 },
    knownCodes: ["03204", "00777"],
    vk,
    attentionStore,
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

    // Покупателю нужен ДРУГОЙ артикул — лота под него нет.
    vk.pushComment({ id: 401, fromId: 5001, text: "бронь 00777", firstName: "Аня" });
    const banner = await client.waitFor((m) => m.type === "reservationAttention", { timeoutMs: 6000 });
    assert.equal(banner.code, "00777");
    assert.ok(banner.rowId, "строка баннера и строка разбора — одна и та же запись");

    client.send({ type: "stop", stoppedAt: new Date().toISOString() });
    await client.waitFor((m) => m.type === "state" && m.openLots?.length === 0, { timeoutMs: 6000 });

    // Эфир кончился — строка на месте.
    assert.equal(attentionStore.openCount(), 1);
    const row = attentionStore.get(banner.rowId);
    assert.equal(row.code, "00777");
    assert.equal(row.viewerName, "Аня");
    assert.equal(row.bookable, true);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("бронь из разбора после эфира создаёт позицию в МойСкладе", async () => {
  const vk = createVkMock();
  const attentionStore = await freshAttentionStore();
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204, "00777": CARD_00777 },
    knownCodes: ["03204", "00777"],
    vk,
    attentionStore,
    // Безлотовый путь сам контрагента не заводит: без него недоступны поиск
    // заказа кампании и проверка на дубль, и каждый повтор писал бы новый заказ.
    moysklad: createMoyskladMock({
      cardsByCode: { "03204": CARD_03204, "00777": CARD_00777 },
      overrides: { ensureCounterparty: async () => ({ id: "cp-1", name: "Ира" }) },
    }),
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

    vk.pushComment({ id: 402, fromId: 5002, text: "бронь 00777", firstName: "Ира" });
    const banner = await client.waitFor((m) => m.type === "reservationAttention", { timeoutMs: 6000 });

    client.send({ type: "stop", stoppedAt: new Date().toISOString() });
    await client.waitFor((m) => m.type === "state" && m.openLots?.length === 0, { timeoutMs: 6000 });

    // Живой токен баннера умер вместе с эфиром — бронируем ПО СТРОКЕ разбора.
    client.send({ type: "reserveFromAttention", rowId: banner.rowId });
    const result = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(result.ok, true, result.message);
    assert.equal(result.rowId, banner.rowId);
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 1);
    assert.equal(attentionStore.openCount(), 0, "разобранная строка уходит из списка");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("отказ оставляет строку в разборе — можно повторить", async () => {
  const vk = createVkMock();
  const attentionStore = await freshAttentionStore();
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204, "00777": CARD_00777 },
    knownCodes: ["03204", "00777"],
    vk,
    attentionStore,
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

    vk.pushComment({ id: 403, fromId: 5003, text: "бронь 00777", firstName: "Оля" });
    const banner = await client.waitFor((m) => m.type === "reservationAttention", { timeoutMs: 6000 });

    client.send({ type: "setSafeMode", enabled: true });
    await client.waitFor((m) => m.type === "state" && m.safeMode === true, { timeoutMs: 6000 });

    client.send({ type: "reserveFromAttention", rowId: banner.rowId });
    const result = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(result.ok, false);
    assert.equal(result.status, "safe_mode");
    assert.equal(attentionStore.openCount(), 1, "строка остаётся: safe-mode выключат и повторят");
  } finally {
    client.send({ type: "setSafeMode", enabled: false });
    await client.close();
    await harness.close();
  }
});
