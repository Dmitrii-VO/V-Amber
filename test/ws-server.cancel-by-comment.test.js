import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createMoyskladMock } from "./helpers/ws-harness.js";
import { setSafeMode } from "../server/safe-mode.js";

// Отмена брони комментарием покупателя, включая закрытый лот и предыдущий день
// кампании — кнопка оператора этого не умеет, она живёт на открытом лоте.
// Заказ находится по viewerId автора комментария, поэтому снять можно только
// собственную бронь.

const CARD = {
  id: "p-03770", name: "Кольцо", code: "03770",
  pathName: "Украшения/Кольца", salePrice: 2500, availableStock: 4,
};

const OTHER_CARD = {
  id: "p-03999", name: "Браслет", code: "03999",
  pathName: "Украшения/Браслеты", salePrice: 900, availableStock: 9,
};

// Поллер комментариев живёт, только пока открыт хоть какой-то лот. Поэтому
// «бронь по закрытому лоту» воспроизводится так: открыт ДРУГОЙ лот, а отмена
// приходит на код, лота под которым сейчас нет.
async function openUnrelatedLot(harness, client) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code: "03999" });
  await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03999");
}

const liveEvents = (m) => (m.activeLot?.reservations?.events || [])
  .filter((e) => e.status === "reserved" || e.status === "reserved_appended");

async function openLotAndReserve(harness, client, { commentId = 101, fromId = 5001, name = "Марина" } = {}) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code: "03770" });
  await client.waitFor((m) => m.type === "state" && m.activeLot);
  harness.vk.pushComment({ id: commentId, fromId, text: "03770", firstName: name });
  return client.waitFor((m) => m.type === "state" && liveEvents(m).length > 0, { timeoutMs: 6000 });
}

test("«отмена <код>» по открытому лоту снимает позицию и освобождает сток", async () => {
  const harness = await startHarness({ cardsByCode: { "03770": CARD }, knownCodes: ["03770"] });
  const client = await harness.connect();
  try {
    const reserved = await openLotAndReserve(harness, client);
    assert.equal(reserved.activeLot.reservations.committedReservationCount, 1);

    harness.vk.pushComment({ id: 102, fromId: 5001, text: "отмена 03770", firstName: "Марина" });
    const cancelled = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.reservations?.events?.some((e) => e.status === "cancelled"),
      { timeoutMs: 6000 },
    );

    // Слот стока вернулся — товар снова можно продать.
    assert.equal(cancelled.activeLot.reservations.committedReservationCount, 0);
    const removed = harness.moysklad.callsTo("removePositionFromOrder");
    assert.equal(removed.length, 1);
    assert.deepEqual(removed[0].args[0], { orderId: "co-test-1", positionId: "pos-created-1" });
  } finally {
    await client.close();
    await harness.close();
  }
});

test("отмена по закрытому лоту снимает позицию через заказ покупателя", async () => {
  const moysklad = createMoyskladMock({
    cardsByCode: { "03770": CARD, "03999": OTHER_CARD },
    overrides: {
      ensureCounterparty: async () => ({ id: "cp-1" }),
      findBroadcastCustomerOrderForCounterparty: async () => ({ id: "co-campaign", name: "VK03060" }),
      hasPositionInOrder: async () => ({ present: true, positionId: "pos-campaign-7" }),
    },
  });
  const harness = await startHarness({ knownCodes: ["03770", "03999"], moysklad });
  const client = await harness.connect();
  try {
    await openUnrelatedLot(harness, client);

    // Лот 03770 не открывался вовсе — это случай «бронь с прошлого дня кампании».
    harness.vk.pushComment({ id: 201, fromId: 5001, text: "отменяю 03770", firstName: "Марина" });
    const info = await client.waitFor((m) => m.type === "info" && /отменил бронь 03770/.test(m.message || ""), { timeoutMs: 6000 });
    assert.match(info.message, /VK03060/);

    const removed = harness.moysklad.callsTo("removePositionFromOrder");
    assert.equal(removed.length, 1);
    assert.equal(removed[0].args[0].orderId, "co-campaign");
    assert.equal(removed[0].args[0].positionId, "pos-campaign-7");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("покупатель не может снять чужую бронь — ищется только его заказ", async () => {
  const seenCounterpartyRequests = [];
  const moysklad = createMoyskladMock({
    cardsByCode: { "03770": CARD, "03999": OTHER_CARD },
    overrides: {
      ensureCounterparty: async (args) => { seenCounterpartyRequests.push(args); return null; },
    },
  });
  const harness = await startHarness({ knownCodes: ["03770", "03999"], moysklad });
  const client = await harness.connect();
  try {
    await openUnrelatedLot(harness, client);

    // Зритель 9999 пытается отменить чужую бронь: поиск идёт по ЕГО viewerId,
    // до чужого заказа он физически не дотягивается.
    harness.vk.pushComment({ id: 301, fromId: 9999, text: "отмена 03770", firstName: "Чужой" });
    await client.waitFor((m) => m.type === "warning" && /не найден в МойСкладе/.test(m.message || ""), { timeoutMs: 6000 });

    assert.equal(seenCounterpartyRequests.length, 1);
    assert.equal(seenCounterpartyRequests[0].viewerId, 9999);
    assert.equal(seenCounterpartyRequests[0].createIfMissing, false, "контрагента ради отмены создавать нельзя");
    assert.equal(harness.moysklad.callsTo("removePositionFromOrder").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("проведённый заказ не трогаем: нет открытого заказа кампании → оператору", async () => {
  const moysklad = createMoyskladMock({
    cardsByCode: { "03770": CARD, "03999": OTHER_CARD },
    overrides: {
      ensureCounterparty: async () => ({ id: "cp-1" }),
      findBroadcastCustomerOrderForCounterparty: async () => null,
    },
  });
  const harness = await startHarness({ knownCodes: ["03770", "03999"], moysklad });
  const client = await harness.connect();
  try {
    await openUnrelatedLot(harness, client);

    harness.vk.pushComment({ id: 401, fromId: 5001, text: "отмена 03770", firstName: "Марина" });
    const warning = await client.waitFor((m) => m.type === "warning" && /уже проведён/.test(m.message || ""), { timeoutMs: 6000 });
    assert.match(warning.message, /03770/);
    assert.equal(harness.moysklad.callsTo("removePositionFromOrder").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("«отмена» без артикула ничего не снимает, а спрашивает оператора", async () => {
  const harness = await startHarness({ cardsByCode: { "03770": CARD }, knownCodes: ["03770"] });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client);

    harness.vk.pushComment({ id: 501, fromId: 5001, text: "отмена", firstName: "Марина" });
    await client.waitFor((m) => m.type === "warning" && /не назвал артикул/.test(m.message || ""), { timeoutMs: 6000 });
    assert.equal(harness.moysklad.callsTo("removePositionFromOrder").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("повторная доставка того же комментария не отменяет второй раз", async () => {
  const moysklad = createMoyskladMock({
    cardsByCode: { "03770": CARD, "03999": OTHER_CARD },
    overrides: {
      ensureCounterparty: async () => ({ id: "cp-1" }),
      findBroadcastCustomerOrderForCounterparty: async () => ({ id: "co-campaign", name: "VK03060" }),
      hasPositionInOrder: async () => ({ present: true, positionId: "pos-campaign-7" }),
    },
  });
  const harness = await startHarness({ knownCodes: ["03770", "03999"], moysklad });
  const client = await harness.connect();
  try {
    await openUnrelatedLot(harness, client);

    harness.vk.pushComment({ id: 601, fromId: 5001, text: "отмена 03770", firstName: "Марина" });
    await client.waitFor((m) => m.type === "info" && /отменил бронь/.test(m.message || ""), { timeoutMs: 6000 });

    harness.vk.pushComment({ id: 601, fromId: 5001, text: "отмена 03770", firstName: "Марина" });
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(harness.moysklad.callsTo("removePositionFromOrder").length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("safe mode: комментарий-отмена ничего не удаляет", async () => {
  const moysklad = createMoyskladMock({
    cardsByCode: { "03770": CARD, "03999": OTHER_CARD },
    overrides: {
      ensureCounterparty: async () => ({ id: "cp-1" }),
      findBroadcastCustomerOrderForCounterparty: async () => ({ id: "co-campaign", name: "VK03060" }),
      hasPositionInOrder: async () => ({ present: true, positionId: "pos-campaign-7" }),
    },
  });
  const harness = await startHarness({ knownCodes: ["03770", "03999"], moysklad });
  const client = await harness.connect();
  try {
    await openUnrelatedLot(harness, client);
    setSafeMode(true);

    harness.vk.pushComment({ id: 701, fromId: 5001, text: "отмена 03770", firstName: "Марина" });
    await client.waitFor((m) => m.type === "warning" && /safe-mode/.test(m.message || ""), { timeoutMs: 6000 });
    assert.equal(harness.moysklad.callsTo("removePositionFromOrder").length, 0);
  } finally {
    setSafeMode(false);
    await client.close();
    await harness.close();
  }
});

test("обычная бронь голым кодом не считается отменой", async () => {
  const harness = await startHarness({ cardsByCode: { "03770": CARD }, knownCodes: ["03770"] });
  const client = await harness.connect();
  try {
    const reserved = await openLotAndReserve(harness, client);
    assert.equal(liveEvents(reserved).length, 1);
    assert.equal(harness.moysklad.callsTo("removePositionFromOrder").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});
