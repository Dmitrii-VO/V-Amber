import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createMoyskladMock } from "./helpers/ws-harness.js";
import { setSafeMode } from "../server/safe-mode.js";

// Сценарии отмены брони оператором (#16). Оператор удаляет позицию покупателя
// из customerorder в МойСкладе адресным DELETE по сохранённому positionId,
// освобождает слот стока и позволяет тому же зрителю забронировать снова.
// См. knowledge/wiki/deferred-operator-features.md #16.

const CARD_03204 = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};

const hasReserved = (m) =>
  m.type === "state"
  && Array.isArray(m.activeLot?.reservations?.events)
  && m.activeLot.reservations.events.some((e) => e.status === "reserved" || e.status === "reserved_appended");

const hasCancelled = (m) =>
  m.type === "state"
  && Array.isArray(m.activeLot?.reservations?.events)
  && m.activeLot.reservations.events.some((e) => e.status === "cancelled");

async function startStream(client, harness) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
}

// Открывает лот ручным вводом и проводит одну бронь голым кодом через поллер.
async function openLotAndReserve(harness, client, { code = "03204", commentId = 101, fromId = 5001, name = "Аня" } = {}) {
  await startStream(client, harness);
  client.send({ type: "manualCode", code });
  await client.waitFor((m) => m.type === "state" && m.activeLot);
  harness.vk.pushComment({ id: commentId, fromId, text: code, firstName: name });
  return client.waitFor(hasReserved, { timeoutMs: 6000 });
}

test("#16: cancel a single reserved → position removed, counter and stock freed", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    const reserved = await openLotAndReserve(harness, client);
    assert.equal(reserved.activeLot.reservations.committedReservationCount, 1);

    client.send({ type: "cancelReservation", viewerId: 5001, commentId: 101 });
    const cancelled = await client.waitFor(hasCancelled, { timeoutMs: 6000 });

    // Счётчик откатился — слот стока снова свободен.
    assert.equal(cancelled.activeLot.reservations.committedReservationCount, 0);

    // DELETE адресный: ровно тот orderId+positionId, что сохранили при брони.
    const removeCalls = harness.moysklad.callsTo("removePositionFromOrder");
    assert.equal(removeCalls.length, 1);
    assert.deepEqual(removeCalls[0].args[0], { orderId: "co-test-1", positionId: "pos-created-1" });
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#16: cancel a reserved_appended buyer deletes only the targeted position", async () => {
  // Контрагент уже имеет открытый заказ дня → бронь дописывается позицией
  // (reserved_appended). Отмена должна удалить именно дописанную позицию.
  const moysklad = createMoyskladMock({
    cardsByCode: { "03204": CARD_03204 },
    overrides: {
      ensureCounterparty: async () => ({ id: "cp-1" }),
      findBroadcastCustomerOrderForCounterparty: async () => ({ id: "co-existing", name: "#Эфир" }),
      appendPositionToCustomerOrder: async () => ({ orderId: "co-existing", positionId: "pos-appended-1" }),
    },
  });
  const harness = await startHarness({ knownCodes: ["03204"], moysklad });
  const client = await harness.connect();
  try {
    const reserved = await openLotAndReserve(harness, client);
    const ev = reserved.activeLot.reservations.events.find((e) => e.status === "reserved_appended");
    assert.ok(ev, "бронь должна быть reserved_appended");

    client.send({ type: "cancelReservation", viewerId: 5001, commentId: 101 });
    await client.waitFor(hasCancelled, { timeoutMs: 6000 });

    // Удалена дописанная позиция в существующем заказе, не создавался новый.
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
    assert.equal(harness.moysklad.callsTo("appendPositionToCustomerOrder").length, 1);
    const removeCalls = harness.moysklad.callsTo("removePositionFromOrder");
    assert.equal(removeCalls.length, 1);
    assert.deepEqual(removeCalls[0].args[0], { orderId: "co-existing", positionId: "pos-appended-1" });
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#16: cancelling an already-cancelled reservation is a no-op warning", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client);

    client.send({ type: "cancelReservation", viewerId: 5001, commentId: 101 });
    await client.waitFor(hasCancelled, { timeoutMs: 6000 });

    // Повторная отмена той же брони → предупреждение, второго DELETE нет.
    client.send({ type: "cancelReservation", viewerId: 5001, commentId: 101 });
    const warning = await client.waitFor("warning");
    assert.match(warning.message, /не найдена или уже отменена/);
    assert.equal(harness.moysklad.callsTo("removePositionFromOrder").length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#16: cancel under safe-mode is blocked, MoySklad untouched", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    const reserved = await openLotAndReserve(harness, client);
    assert.equal(reserved.activeLot.reservations.committedReservationCount, 1);

    client.send({ type: "setSafeMode", enabled: true });
    await client.waitFor((m) => m.type === "state" && m.safeMode === true);

    client.send({ type: "cancelReservation", viewerId: 5001, commentId: 101 });
    const warning = await client.waitFor("warning");
    assert.match(warning.message, /safe-mode/);

    // Ничего не удалено, счётчик не тронут.
    assert.equal(harness.moysklad.callsTo("removePositionFromOrder").length, 0);
    assert.equal(client.lastState()?.activeLot?.reservations?.committedReservationCount, 1);
  } finally {
    // Глобальный singleton safe-mode не должен протечь в другие тесты файла.
    setSafeMode(false, { source: "test-cleanup" });
    await client.close();
    await harness.close();
  }
});

test("#16: after cancel the same buyer can reserve again", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client, { commentId: 101 });

    client.send({ type: "cancelReservation", viewerId: 5001, commentId: 101 });
    await client.waitFor(hasCancelled, { timeoutMs: 6000 });

    // Тот же зритель бронирует снова новым комментарием — больше не
    // отбрасывается как дубль (его сняли из acceptedUserIds), создаётся
    // новый заказ (in-memory маппинг заказа на день тоже сброшен).
    harness.vk.pushComment({ id: 102, fromId: 5001, text: "03204", firstName: "Аня" });
    const reReserved = await client.waitFor(
      (m) => m.type === "state"
        && m.activeLot?.reservations?.events?.some((e) => e.commentId === 102 && e.status === "reserved"),
      { timeoutMs: 6000 },
    );
    assert.equal(reReserved.activeLot.reservations.committedReservationCount, 1);
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 2);
  } finally {
    await client.close();
    await harness.close();
  }
});

// Анализ 2026-06-11: оператор вслух опускает ведущие нули («отмена брони
// два четыре три» при лоте «00243»), а строгое сравнение кода отвечало
// «нет открытого лота 243». Голосовой поиск лота теперь использует ту же
// толерантность к ведущим нулям, что и покупательские комментарии.
test("voice cancel matches a lot when spoken code lacks leading zeros", async () => {
  const card = { ...CARD_03204, id: "p-00243", code: "00243" };
  const harness = await startHarness({ cardsByCode: { "00243": card }, knownCodes: ["00243"] });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client, { code: "00243", commentId: 101 });

    harness.getLastSpeechKitSession().handlers.onFinal({
      text: "Аня отмена брони два четыре три",
      latencyMs: 10,
    });
    const match = await client.waitFor((m) => m.type === "voiceCancelMatch", { timeoutMs: 6000 });
    assert.equal(match.code, "243");
    assert.equal(match.viewerId, 5001);
  } finally {
    await client.close();
    await harness.close();
  }
});
