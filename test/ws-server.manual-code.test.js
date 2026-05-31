import { test } from "node:test";
import assert from "node:assert/strict";
import { createVkMock, startHarness } from "./helpers/ws-harness.js";

// Сценарии ручного ввода кода на активном лоте (#14). Вариант А: ручной ввод
// разрешён только при активном STT-стриме; код обязан быть в каталоге.
// См. knowledge/wiki/deferred-operator-features.md #14.

const CARD_03204 = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};
const CARD_03199 = {
  id: "p-03199", name: "Кольцо янтарь", code: "03199",
  pathName: "Украшения/Кольца", salePrice: 3200, availableStock: 4,
};
const CARD_03204_ONE_IN_STOCK = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 1,
};
// Карточка с НЕизвестным остатком (availableStock отсутствует) — для
// проверки floor=1 на первой брони.
const CARD_03204_NO_STOCK = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: null,
};

const hasReserved = (m) =>
  m.type === "state"
  && Array.isArray(m.activeLot?.reservations?.events)
  && m.activeLot.reservations.events.some((e) => e.status === "reserved");

const hasReservedInOpenLot = (code) => (m) =>
  m.type === "state"
  && Array.isArray(m.openLots)
  && m.openLots.some((lot) => lot.code === code
    && Array.isArray(lot.reservations?.events)
    && lot.reservations.events.some((e) => e.status === "reserved" || e.status === "reserved_appended"));

const hasReservationStatusInOpenLot = (code, status) => (m) =>
  m.type === "state"
  && Array.isArray(m.openLots)
  && m.openLots.some((lot) => lot.code === code
    && Array.isArray(lot.reservations?.events)
    && lot.reservations.events.some((e) => e.status === status));

// Запускает STT-стрим (без голосовой детекции) — ставит activeRunId.
async function startStream(client, harness) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
}

test("#14: manualCode before stream start is rejected (Variant A gate)", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    client.send({ type: "manualCode", code: "03204" });
    const warning = await client.waitFor("warning");
    assert.match(warning.message, /Запустите распознавание/);
    assert.equal(harness.moysklad.callsTo("getProductCardByCode").length, 0);
    assert.equal(harness.vk.callsTo("publishLotCard").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode with a code outside the catalog is rejected", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "99999" });
    const warning = await client.waitFor("warning");
    assert.match(warning.message, /не найден в каталоге/);
    assert.equal(harness.moysklad.callsTo("getProductCardByCode").length, 0);
    assert.equal(harness.vk.callsTo("publishLotCard").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode is rejected when the catalog is not loaded", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: [] });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    const warning = await client.waitFor("warning");
    assert.match(warning.message, /Каталог товаров не загружен/);
    assert.equal(harness.vk.callsTo("publishLotCard").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode on idle opens a new lot with source=manual", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    const state = await client.waitFor((m) => m.type === "state" && m.activeLot);
    assert.equal(state.activeLot.code, "03204");
    assert.equal(state.activeLot.source, "manual");
    assert.equal(state.activeLot.product.name, "Серьги янтарь");
    assert.equal(harness.vk.callsTo("publishLotCard").length, 1);
    assert.equal(harness.moysklad.callsTo("getProductCardByCode")[0].args[0], "03204");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode matching the active lot merges (no new lot, no new VK card)", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    const first = await client.waitFor((m) => m.type === "state" && m.activeLot);
    const lotSessionId = first.activeLot.lotSessionId;

    client.send({ type: "manualCode", code: "03204" });
    const second = await client.waitFor((m) => m.type === "state" && m.activeLot);
    // Тот же lotSessionId — merge, а не close+reopen: брони сохраняются.
    assert.equal(second.activeLot.lotSessionId, lotSessionId);
    // Карточка VK опубликована ровно один раз (нет дубля поллера/карточки).
    assert.equal(harness.vk.callsTo("publishLotCard").length, 1);
    assert.equal(harness.vk.callsTo("publishLotClosed").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manual -> voice -> manual on the same code keeps a single lot", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    const session = harness.getLastSpeechKitSession();

    client.send({ type: "manualCode", code: "03204" });
    const first = await client.waitFor((m) => m.type === "state" && m.activeLot);
    const lotSessionId = first.activeLot.lotSessionId;

    // Голосовой повтор того же кода → merge.
    session.handlers.onFinal({ text: "код товара 03204", latencyMs: 10 });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.lotSessionId === lotSessionId);

    // Снова ручной ввод того же кода → merge.
    client.send({ type: "manualCode", code: "03204" });
    const third = await client.waitFor((m) => m.type === "state" && m.activeLot);

    assert.equal(third.activeLot.lotSessionId, lotSessionId);
    // Один лот за всю цепочку → одна карточка, ни одного закрытия.
    assert.equal(harness.vk.callsTo("publishLotCard").length, 1);
    assert.equal(harness.vk.callsTo("publishLotClosed").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode with unknown stock — first reservation falls back to floor=1", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204_NO_STOCK },
    knownCodes: ["03204"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    const open = await client.waitFor((m) => m.type === "state" && m.activeLot);
    assert.equal(open.activeLot.product.availableStock, null);

    // Зритель бронирует голым кодом — поллер подхватит на ближайшем опросе.
    harness.vk.pushComment({ id: 101, fromId: 5001, text: "03204", firstName: "Аня" });

    const reserved = await client.waitFor(hasReserved, { timeoutMs: 6000 });
    assert.equal(reserved.activeLot.reservations.committedReservationCount, 1);
    // Открытие лота + ensureStockKnownBeforeFirstReservation → карточка
    // запрошена минимум дважды (floor=1 пропускает первую бронь).
    assert.ok(harness.moysklad.callsTo("getProductCardByCode").length >= 2);
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});

// Этап 4: unknown stock после refresh → лот помечается stockUnknown, оператор
// получает явный warning «риск перепродажи». UI рисует amber pill по флагу.
test("unknown stock surfaces a stockUnknown flag and a warning to the operator", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204_NO_STOCK },
    knownCodes: ["03204"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

    harness.vk.pushComment({ id: 201, fromId: 6001, text: "03204", firstName: "Оля" });

    const warning = await client.waitFor(
      (m) => m.type === "warning" && /Остаток.*неизвестен/.test(m.message || ""),
      { timeoutMs: 6000 },
    );
    assert.match(warning.message, /03204/);

    const flagged = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.stockUnknown === true,
      { timeoutMs: 6000 },
    );
    assert.equal(flagged.activeLot.product.availableStock, null);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode re-entry preserves an accepted reservation (no poison, no close)", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    const open = await client.waitFor((m) => m.type === "state" && m.activeLot);
    const lotSessionId = open.activeLot.lotSessionId;

    harness.vk.pushComment({ id: 101, fromId: 5001, text: "03204", firstName: "Аня" });
    await client.waitFor(hasReserved, { timeoutMs: 6000 });

    // Повторный ручной ввод того же кода → merge, бронь не теряется.
    client.send({ type: "manualCode", code: "03204" });
    const merged = await client.waitFor("state");
    assert.equal(merged.activeLot.lotSessionId, lotSessionId);
    assert.equal(merged.activeLot.reservations.committedReservationCount, 1);
    assert.equal(harness.vk.callsTo("publishLotClosed").length, 0);
    assert.equal(harness.vk.callsTo("publishLotCard").length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode switching to a different code keeps the previous lot open", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204, "03199": CARD_03199 },
    knownCodes: ["03204", "03199"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

    client.send({ type: "manualCode", code: "03199" });
    const switched = await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03199");

    assert.equal(switched.activeLot.source, "manual");
    assert.equal(switched.openLots.length, 2);
    assert.deepEqual(switched.openLots.map((lot) => lot.code), ["03204", "03199"]);
    assert.equal(harness.vk.callsTo("publishLotCard").length, 2);
    assert.equal(harness.vk.callsTo("publishLotClosed").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: one poller routes reservations to old and current open lots by code", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204, "03199": CARD_03199 },
    knownCodes: ["03204", "03199"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

    client.send({ type: "manualCode", code: "03199" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03199" && m.openLots?.length === 2);

    harness.vk.pushComment({ id: 101, fromId: 5001, text: "03204", firstName: "Аня" });
    await client.waitFor(hasReservedInOpenLot("03204"), { timeoutMs: 6000 });

    harness.vk.pushComment({ id: 102, fromId: 5002, text: "03199", firstName: "Оля" });
    const state = await client.waitFor(hasReservedInOpenLot("03199"), { timeoutMs: 6000 });

    const oldLot = state.openLots.find((lot) => lot.code === "03204");
    const currentLot = state.openLots.find((lot) => lot.code === "03199");
    assert.equal(oldLot.reservations.committedReservationCount, 1);
    assert.equal(currentLot.reservations.committedReservationCount, 1);
    assert.equal(harness.vk.callsTo("publishLotClosed").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: overflow on an inactive open lot goes to wishlist", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204_ONE_IN_STOCK, "03199": CARD_03199 },
    knownCodes: ["03204", "03199"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

    client.send({ type: "manualCode", code: "03199" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03199" && m.openLots?.length === 2);

    harness.vk.pushComment({ id: 101, fromId: 5001, text: "03204", firstName: "Аня" });
    await client.waitFor(hasReservedInOpenLot("03204"), { timeoutMs: 6000 });

    harness.vk.pushComment({ id: 102, fromId: 5002, text: "03204", firstName: "Оля" });
    const state = await client.waitFor(hasReservationStatusInOpenLot("03204", "out_of_stock"), { timeoutMs: 6000 });

    const oldLot = state.openLots.find((lot) => lot.code === "03204");
    assert.equal(oldLot.reservations.committedReservationCount, 1);
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 1);
    assert.equal(harness.wishlistStore.calls.length, 1);
    assert.equal(harness.wishlistStore.calls[0].lot.code, "03204");
    assert.equal(harness.wishlistStore.calls[0].event.viewerName, "Оля");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("stream stop skips remaining lot-close publishes when VK video is gone", async () => {
  const videoGoneError = new Error("VK API 15: Access denied: video not found");
  videoGoneError.vkErrorCode = 15;
  const vk = createVkMock({
    publishLotClosed: async () => {
      throw videoGoneError;
    },
  });
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204, "03199": CARD_03199 },
    knownCodes: ["03204", "03199"],
    vk,
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

    client.send({ type: "manualCode", code: "03199" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03199" && m.openLots?.length === 2);

    client.send({ type: "stop", stoppedAt: new Date().toISOString() });
    await client.waitFor((m) => m.type === "state" && m.openLots?.length === 0, { timeoutMs: 6000 });

    assert.equal(harness.vk.callsTo("publishLotClosed").length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});
