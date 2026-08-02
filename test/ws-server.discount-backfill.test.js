import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createMoyskladMock } from "./helpers/ws-harness.js";
import { setSafeMode } from "../server/safe-mode.js";

// Скидка, объявленная ПОСЛЕ первых броней, должна догнать уже созданные
// позиции в МойСкладе. До этого фикса applyDiscount менял только лот и карточку
// VK: покупатель, забронировавший за секунду до объявления скидки, платил
// полную цену, и оператор правил заказ руками (эфир 2026-08-01, лот 03737 —
// скидка через 4 секунды после трёх броней).

const CARD = {
  id: "p-03737", name: "Бусы", code: "03737",
  pathName: "Украшения/Бусы", salePrice: 2200, availableStock: 5,
};

const hasReserved = (m) =>
  m.type === "state"
  && Array.isArray(m.activeLot?.reservations?.events)
  && m.activeLot.reservations.events.some((e) => e.status === "reserved" || e.status === "reserved_appended");

async function openLotAndReserve(harness, client, { commentId = 101, fromId = 5001 } = {}) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code: "03737" });
  await client.waitFor((m) => m.type === "state" && m.activeLot);
  harness.vk.pushComment({ id: commentId, fromId, text: "03737", firstName: "Аня" });
  return client.waitFor(hasReserved, { timeoutMs: 6000 });
}

function voiceDiscount(harness, text) {
  harness.getLastSpeechKitSession().handlers.onFinal({ text, latencyMs: 10 });
}

test("скидка после брони пересчитывает уже созданную позицию", async () => {
  const harness = await startHarness({ cardsByCode: { "03737": CARD }, knownCodes: ["03737"] });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client);

    voiceDiscount(harness, "скидка пять процентов");
    await client.waitFor((m) => m.type === "state" && m.activeLot?.discountAmount > 0, { timeoutMs: 6000 });

    const calls = harness.moysklad.callsTo("updateCustomerOrderPositionPricing");
    assert.equal(calls.length, 1, "позиция брони должна быть пересчитана ровно один раз");
    // Базовая цена не трогается — скидка уходит процентом, как и при создании
    // позиции (buildPositionPricing). 5% от 2200 = 110.
    assert.deepEqual(calls[0].args[0], {
      orderId: "co-test-1",
      positionId: "pos-created-1",
      salePrice: 2200,
      discountAmount: 110,
      source: "discount_backfill",
    });
  } finally {
    await client.close();
    await harness.close();
  }
});

test("пересчитываются все живые брони лота, отменённая — нет", async () => {
  const harness = await startHarness({ cardsByCode: { "03737": CARD }, knownCodes: ["03737"] });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client, { commentId: 101, fromId: 5001 });
    harness.vk.pushComment({ id: 102, fromId: 5002, text: "03737", firstName: "Оля" });
    await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.reservations?.events?.filter((e) => e.status === "reserved" || e.status === "reserved_appended").length === 2,
      { timeoutMs: 6000 },
    );

    client.send({ type: "cancelReservation", viewerId: 5002, commentId: 102 });
    await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.reservations?.events?.some((e) => e.status === "cancelled"),
      { timeoutMs: 6000 },
    );

    voiceDiscount(harness, "скидка пять процентов");
    await client.waitFor((m) => m.type === "state" && m.activeLot?.discountAmount > 0, { timeoutMs: 6000 });

    const calls = harness.moysklad.callsTo("updateCustomerOrderPositionPricing");
    assert.equal(calls.length, 1, "отменённую бронь пересчитывать нельзя");
    assert.equal(calls[0].args[0].positionId, "pos-created-1");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("safe mode: пересчёта нет, скидка на лоте всё равно применяется", async () => {
  const harness = await startHarness({ cardsByCode: { "03737": CARD }, knownCodes: ["03737"] });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client);
    setSafeMode(true);

    voiceDiscount(harness, "скидка пять процентов");
    const state = await client.waitFor((m) => m.type === "state" && m.activeLot?.discountAmount > 0, { timeoutMs: 6000 });

    assert.equal(state.activeLot.discountAmount, 110);
    assert.equal(harness.moysklad.callsTo("updateCustomerOrderPositionPricing").length, 0);
  } finally {
    setSafeMode(false);
    await client.close();
    await harness.close();
  }
});

test("сбой пересчёта не отменяет скидку и предупреждает оператора", async () => {
  const moysklad = createMoyskladMock({
    cardsByCode: { "03737": CARD },
    overrides: {
      updateCustomerOrderPositionPricing: async () => { throw new Error("MoySklad HTTP 500"); },
    },
  });
  const harness = await startHarness({ knownCodes: ["03737"], moysklad });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client);

    voiceDiscount(harness, "скидка пять процентов");
    const warning = await client.waitFor(
      (m) => m.type === "warning" && /не пересчитал/.test(m.message || ""),
      { timeoutMs: 6000 },
    );
    assert.match(warning.message, /03737/);

    // Скидка на лоте осталась — следующая бронь уйдёт уже с ней.
    const state = await client.waitFor((m) => m.type === "state" && m.activeLot?.discountAmount > 0, { timeoutMs: 6000 });
    assert.equal(state.activeLot.discountAmount, 110);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("броней ещё нет — пересчитывать нечего, лишних вызовов в МойСклад нет", async () => {
  const harness = await startHarness({ cardsByCode: { "03737": CARD }, knownCodes: ["03737"] });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03737" });
    await client.waitFor((m) => m.type === "state" && m.activeLot);

    voiceDiscount(harness, "скидка пять процентов");
    await client.waitFor((m) => m.type === "state" && m.activeLot?.discountAmount > 0, { timeoutMs: 6000 });

    assert.equal(harness.moysklad.callsTo("updateCustomerOrderPositionPricing").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});
