import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createMoyskladMock } from "./helpers/ws-harness.js";
import { setSafeMode } from "../server/safe-mode.js";

// Бронь из строки «требует внимания»: покупатель написал код, под который
// открытого лота нет (лот закрылся раньше в этом же эфире или карточка была
// в другой день кампании). До 2026-07-26 такие брони пропадали молча — за один
// эфир так потерялись две ручки 03723. Теперь оператор бронирует их кликом,
// а сервер берёт code/viewerId из своего однократного токена.

const CARD_LOT = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};
const CARD_CLOSED = {
  id: "p-03723", name: "Ручка феолетовая", code: "03723",
  pathName: "Ручки", salePrice: 200, availableStock: 10,
};
const CARD_CLOSED_OOS = { ...CARD_CLOSED, availableStock: 0 };

// Открывает лот 03204 и роняет в комментарии бронь на код 03723, под который
// открытого лота нет → сервер поднимает строку внимания.
async function attentionFor(harness, client, { commentText = "бронь 03723", commentId = 501 } = {}) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code: "03204" });
  await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

  harness.vk.pushComment({ id: commentId, fromId: 8101, text: commentText, firstName: "Марго", lastName: "Краснова" });
  return client.waitFor((m) => m.type === "reservationAttention", { timeoutMs: 6000 });
}

test("строка внимания несёт actionId и по нему создаётся заказ", async () => {
  const moysklad = createMoyskladMock({
    cardsByCode: { "03204": CARD_LOT, "03723": CARD_CLOSED },
    overrides: { ensureCounterparty: async () => ({ id: "cp-1", name: "Марго Краснова" }) },
  });
  const harness = await startHarness({ moysklad, knownCodes: ["03204", "03723"] });
  const client = await harness.connect();
  try {
    const attention = await attentionFor(harness, client);
    assert.equal(attention.reason, "no_open_lot");
    assert.equal(attention.code, "03723");
    assert.ok(attention.actionId, "строка внимания должна нести actionId");

    client.send({ type: "reserveFromAttention", actionId: attention.actionId });
    const result = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(result.ok, true);
    assert.equal(result.status, "reserved");
    const created = moysklad.callsTo("createCustomerOrderReservation");
    assert.equal(created.length, 1);
    // Позиция уходит на товар из карточки, а не на код открытого лота.
    assert.equal(created[0].args[0].activeLot.product.id, "p-03723");
    assert.equal(created[0].args[0].reservation.viewerId, 8101);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("при открытом заказе кампании позиция дописывается, а не создаётся новый", async () => {
  const moysklad = createMoyskladMock({
    cardsByCode: { "03204": CARD_LOT, "03723": CARD_CLOSED },
    overrides: {
      ensureCounterparty: async () => ({ id: "cp-1", name: "Марго Краснова" }),
      findBroadcastCustomerOrderForCounterparty: async () => ({ id: "co-camp-1", name: "00042" }),
    },
  });
  const harness = await startHarness({ moysklad, knownCodes: ["03204", "03723"] });
  const client = await harness.connect();
  try {
    const attention = await attentionFor(harness, client);
    client.send({ type: "reserveFromAttention", actionId: attention.actionId });
    const result = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(result.ok, true);
    assert.equal(result.status, "reserved");
    assert.equal(moysklad.callsTo("appendPositionToCustomerOrder").length, 1);
    assert.equal(moysklad.callsTo("createCustomerOrderReservation").length, 0);
    assert.equal(moysklad.callsTo("appendPositionToCustomerOrder")[0].args[0].orderId, "co-camp-1");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("повторный клик не дублирует позицию в заказе", async () => {
  const moysklad = createMoyskladMock({
    cardsByCode: { "03204": CARD_LOT, "03723": CARD_CLOSED },
    overrides: {
      ensureCounterparty: async () => ({ id: "cp-1", name: "Марго Краснова" }),
      findBroadcastCustomerOrderForCounterparty: async () => ({ id: "co-camp-1", name: "00042" }),
      hasPositionInOrder: async () => ({ present: true, positionId: "pos-1" }),
    },
  });
  const harness = await startHarness({ moysklad, knownCodes: ["03204", "03723"] });
  const client = await harness.connect();
  try {
    const attention = await attentionFor(harness, client);
    client.send({ type: "reserveFromAttention", actionId: attention.actionId });
    const result = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(result.status, "already_reserved");
    assert.equal(moysklad.callsTo("appendPositionToCustomerOrder").length, 0);
    assert.equal(moysklad.callsTo("createCustomerOrderReservation").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("нет остатка — покупатель уходит в список ожидания, без записи в МойСклад", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_LOT, "03723": CARD_CLOSED_OOS },
    knownCodes: ["03204", "03723"],
  });
  const client = await harness.connect();
  try {
    const attention = await attentionFor(harness, client);
    client.send({ type: "reserveFromAttention", actionId: attention.actionId });
    const result = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(result.status, "wishlist");
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
    assert.equal(harness.moysklad.callsTo("appendPositionToCustomerOrder").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("подделанный actionId ничего не пишет", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_LOT, "03723": CARD_CLOSED },
    knownCodes: ["03204", "03723"],
  });
  const client = await harness.connect();
  try {
    await attentionFor(harness, client);
    client.send({ type: "reserveFromAttention", actionId: "не-выдавался-сервером" });
    const result = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(result.ok, false);
    assert.equal(result.status, "expired");
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("safe-mode блокирует бронь из строки внимания", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_LOT, "03723": CARD_CLOSED },
    knownCodes: ["03204", "03723"],
  });
  const client = await harness.connect();
  try {
    const attention = await attentionFor(harness, client);
    setSafeMode(true, { source: "test" });
    client.send({ type: "reserveFromAttention", actionId: attention.actionId });
    const result = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(result.ok, false);
    assert.equal(result.status, "safe_mode");
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
    assert.equal(harness.moysklad.callsTo("getProductCardByCode").filter((c) => c.args[0] === "03723").length, 0);
  } finally {
    setSafeMode(false, { source: "test" });
    await client.close();
    await harness.close();
  }
});

test("код вне каталога не получает кнопку брони", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_LOT },
    knownCodes: ["03204"],
  });
  const client = await harness.connect();
  try {
    // 09999 нет в каталоге — бронировать нечего, actionId не выдаём.
    const attention = await attentionFor(harness, client, { commentText: "бронь 09999", commentId: 502 });
    assert.equal(attention.code, "09999");
    assert.equal(attention.actionId, undefined);
  } finally {
    await client.close();
    await harness.close();
  }
});

// --- Найдено ревью перед мержем ---

test("двойной клик не создаёт второй заказ", async () => {
  // Токен намеренно не тратится до успешной записи (чтобы сбой МойСклада можно
  // было повторить), а обработчик сообщений не сериализован — оба кадра
  // успевали пройти проверку до первой записи и создавали ДВА заказа одному
  // покупателю. Задержка в ensureCounterparty моделирует сетевую латентность.
  const slow = (value) => async () => {
    await new Promise((r) => setTimeout(r, 30));
    return value;
  };
  const moysklad = createMoyskladMock({
    cardsByCode: { "03204": CARD_LOT, "03723": CARD_CLOSED },
    overrides: {
      ensureCounterparty: slow({ id: "cp-1", name: "Марго Краснова" }),
      createCustomerOrderReservation: slow({ id: "co-new-1", positionId: "pos-1" }),
    },
  });
  const harness = await startHarness({ moysklad, knownCodes: ["03204", "03723"] });
  const client = await harness.connect();
  try {
    const attention = await attentionFor(harness, client);
    client.send({ type: "reserveFromAttention", actionId: attention.actionId });
    client.send({ type: "reserveFromAttention", actionId: attention.actionId });

    const first = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });
    const second = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(moysklad.callsTo("createCustomerOrderReservation").length, 1);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, ["in_flight", "reserved"]);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("товар без цены в каталоге не уходит в заказ по 0 ₽", async () => {
  // Лота нет — значит нет и озвученной цены, подставить её неоткуда. Раньше
  // позиция создавалась по 0 ₽, а оператор видел зелёное «забронирован».
  const moysklad = createMoyskladMock({
    cardsByCode: {
      "03204": CARD_LOT,
      "03723": { ...CARD_CLOSED, salePrice: 0 },
    },
    overrides: { ensureCounterparty: async () => ({ id: "cp-1", name: "Марго Краснова" }) },
  });
  const harness = await startHarness({ moysklad, knownCodes: ["03204", "03723"] });
  const client = await harness.connect();
  try {
    const attention = await attentionFor(harness, client);
    client.send({ type: "reserveFromAttention", actionId: attention.actionId });
    const result = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(result.ok, false);
    assert.equal(result.status, "no_price");
    assert.equal(moysklad.callsTo("createCustomerOrderReservation").length, 0);
    assert.equal(moysklad.callsTo("appendPositionToCustomerOrder").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("без контрагента отказ, а не заказ вслепую", async () => {
  // Без id контрагента недоступны ни поиск заказа кампании, ни проверка на
  // дубль — значит каждый повтор писал бы новый заказ. Отказываем закрыто.
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_LOT, "03723": CARD_CLOSED },
    knownCodes: ["03204", "03723"],
  });
  const client = await harness.connect();
  try {
    const attention = await attentionFor(harness, client);
    client.send({ type: "reserveFromAttention", actionId: attention.actionId });
    const result = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(result.ok, false);
    assert.equal(result.status, "no_counterparty");
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("проверка дубля смотрит в заказ кампании, а не в посторонний открытый", async () => {
  // hasPositionForProduct берёт последний незакрытый заказ контрагента — без
  // маркера #Эфир и без окна кампании. Если у покупателя есть посторонний
  // ручной заказ с тем же товаром, он выглядел бы как «уже забронировано»,
  // и бронь молча терялась бы — ровно та потеря, ради которой всё это писалось.
  const moysklad = createMoyskladMock({
    cardsByCode: { "03204": CARD_LOT, "03723": CARD_CLOSED },
    overrides: {
      ensureCounterparty: async () => ({ id: "cp-1", name: "Марго Краснова" }),
      findBroadcastCustomerOrderForCounterparty: async () => ({ id: "co-camp-1", name: "00042" }),
      // Посторонний заказ с этим товаром есть...
      hasPositionForProduct: async () => ({ inOpenOrder: true, orderId: "co-manual-9", orderName: "00099" }),
      // ...но в заказе кампании товара нет.
      hasPositionInOrder: async () => ({ present: false }),
    },
  });
  const harness = await startHarness({ moysklad, knownCodes: ["03204", "03723"] });
  const client = await harness.connect();
  try {
    const attention = await attentionFor(harness, client);
    client.send({ type: "reserveFromAttention", actionId: attention.actionId });
    const result = await client.waitFor((m) => m.type === "attentionReservationResult", { timeoutMs: 6000 });

    assert.equal(result.status, "reserved");
    assert.equal(moysklad.callsTo("appendPositionToCustomerOrder").length, 1);
    assert.equal(moysklad.callsTo("hasPositionInOrder")[0].args[0], "co-camp-1");
  } finally {
    await client.close();
    await harness.close();
  }
});
