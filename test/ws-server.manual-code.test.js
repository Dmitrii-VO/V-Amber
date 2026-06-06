import { test } from "node:test";
import assert from "node:assert/strict";
import { createVkMock, createMoyskladMock, startHarness } from "./helpers/ws-harness.js";

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

// Этап 6: покупатель пишет «бронь 0588» вместо «бронь 00588». Раньше
// exact-match терял такую бронь; теперь padding из ведущих нулей
// маршрутизирует комментарий в правильный лот.
test("buyer comment with missing leading zero matches an open lot by zero-padding", async () => {
  const CARD_00588 = {
    id: "p-00588",
    name: "Кулон янтарь",
    code: "00588",
    pathName: "Украшения/Кулоны",
    salePrice: 1800,
    availableStock: 3,
  };
  const harness = await startHarness({
    cardsByCode: { "00588": CARD_00588 },
    knownCodes: ["00588"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "00588" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "00588");

    harness.vk.pushComment({ id: 301, fromId: 7001, text: "бронь 0588", firstName: "Лена" });

    await client.waitFor(hasReserved, { timeoutMs: 6000 });
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});

// #3: бронь с ключевым словом + код, но НЕТ открытого лота под этот код →
// сервер не бронирует, а выносит оператору строку «требует внимания»
// (reservationAttention), без публичного VK-комментария.
test("reservation keyword with no matching open lot escalates to the operator", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

    harness.vk.pushComment({ id: 401, fromId: 8001, text: "бронь 09999", firstName: "Ирина" });

    const attention = await client.waitFor((m) => m.type === "reservationAttention", { timeoutMs: 6000 });
    assert.equal(attention.reason, "no_open_lot");
    assert.equal(attention.code, "09999");
    assert.equal(attention.viewerName, "Ирина");
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

// #3: код покупателя ложится zero-padding'ом сразу на НЕСКОЛЬКО открытых лотов
// → ambiguous, бронить наугад нельзя. Эскалация оператору с кандидатами.
test("ambiguous zero-padded reservation escalates with candidate codes (no auto-reserve)", async () => {
  const CARD_00588 = {
    id: "p-00588", name: "Кулон A", code: "00588", pathName: "Украшения", salePrice: 1800, availableStock: 3,
  };
  const CARD_000588 = {
    id: "p-000588", name: "Кулон B", code: "000588", pathName: "Украшения", salePrice: 1900, availableStock: 3,
  };
  const harness = await startHarness({
    cardsByCode: { "00588": CARD_00588, "000588": CARD_000588 },
    knownCodes: ["00588", "000588"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "00588" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "00588");
    client.send({ type: "manualCode", code: "000588" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "000588" && m.openLots?.length === 2);

    harness.vk.pushComment({ id: 402, fromId: 8002, text: "бронь 588", firstName: "Оля" });

    const attention = await client.waitFor((m) => m.type === "reservationAttention", { timeoutMs: 6000 });
    assert.equal(attention.reason, "ambiguous");
    assert.deepEqual([...attention.candidateCodes].sort(), ["000588", "00588"]);
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

// #2 (log review 2026-06-05): покупатель набрал ЛИШНИЕ ведущие нули
// («бронь 000296» вместо «00296»). Теперь матчится после среза ведущих нулей.
test("buyer comment with extra leading zeros matches an open lot", async () => {
  const CARD_00296 = {
    id: "p-00296", name: "Браслет янтарь", code: "00296",
    pathName: "Украшения/Браслеты", salePrice: 2100, availableStock: 3,
  };
  const harness = await startHarness({
    cardsByCode: { "00296": CARD_00296 },
    knownCodes: ["00296"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "00296" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "00296");

    harness.vk.pushComment({ id: 311, fromId: 7101, text: "бронь 000296", firstName: "Вера" });

    await client.waitFor(hasReserved, { timeoutMs: 6000 });
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});

// #1 (log review 2026-06-05): оператор перевёл заказ в закрытый статус
// (Запакован/…) во время эфира. Следующая бронь того же зрителя НЕ должна
// дописываться в закрытый заказ по устаревшему in-memory кэшу — создаётся новый.
test("cached order closed by operator mid-stream is not appended to (new order created)", async () => {
  const moysklad = createMoyskladMock({
    cardsByCode: { "03204": CARD_03204, "03199": CARD_03199 },
    overrides: {
      ensureCounterparty: async () => ({ id: "cp-1" }),
      // Кэшированный заказ к моменту перепроверки уже «Запакован».
      isCustomerOrderAppendable: async () => false,
    },
  });
  const harness = await startHarness({ knownCodes: ["03204", "03199"], moysklad });
  const client = await harness.connect();
  try {
    await startStream(client, harness);

    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");
    harness.vk.pushComment({ id: 501, fromId: 9001, text: "03204", firstName: "Зоя" });
    await client.waitFor(hasReservedInOpenLot("03204"), { timeoutMs: 6000 });

    client.send({ type: "manualCode", code: "03199" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03199" && m.openLots?.length === 2);
    harness.vk.pushComment({ id: 502, fromId: 9001, text: "03199", firstName: "Зоя" });
    await client.waitFor(hasReservedInOpenLot("03199"), { timeoutMs: 6000 });

    // Кэш отброшен после перепроверки → второй заказ создан, а не дописан.
    assert.equal(harness.moysklad.callsTo("isCustomerOrderAppendable").length, 1);
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 2);
    assert.equal(harness.moysklad.callsTo("appendPositionToCustomerOrder").length, 0);
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

// Этап 7 (post-review): остальные stream-fatal коды VK (100 — bad params,
// 801 — комментарии закрыты) тоже видео-уровневые. Раньше только код 15
// пропускал оставшиеся лоты — остальные ушли бы серией error-логов.
test("stream stop also skips remaining publishes for other stream-fatal VK errors", async () => {
  const commentsClosed = new Error("VK API 801: Comments are disabled for this video");
  commentsClosed.vkErrorCode = 801;
  const vk = createVkMock({
    publishLotClosed: async () => {
      throw commentsClosed;
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
