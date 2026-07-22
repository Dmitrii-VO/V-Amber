import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createVkMock } from "./helpers/ws-harness.js";

// Блокировка спамера: комментарии зрителя из чёрного списка не должны
// доходить до парсинга. Фильтр стоит первым в ingestViewerComment — если он
// съедет ниже, спам снова начнёт создавать брони и позиции в МойСкладе,
// которые оператор потом снимает вручную. См. server/blocked-viewers-store.js.

const CARD_03204 = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};

const SPAMMER_ID = 7777;
const BUYER_ID = 5001;

const hasReservedFrom = (viewerId) => (m) =>
  m.type === "state"
  && Array.isArray(m.activeLot?.reservations?.events)
  && m.activeLot.reservations.events.some(
    (e) => e.viewerId === viewerId
      && (e.status === "reserved" || e.status === "reserved_appended"),
  );

function createBlockedStoreStub(blockedIds) {
  const blocked = new Set(blockedIds.map(String));
  return {
    isBlocked: (viewerId) => blocked.has(String(viewerId)),
    get: (viewerId) => (blocked.has(String(viewerId)) ? { viewerId, name: "Спамер" } : null),
  };
}

test("комментарий заблокированного зрителя не создаёт бронь", async () => {
  const vk = createVkMock();
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
    vk,
    blockedViewersStore: createBlockedStoreStub([SPAMMER_ID]),
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot);

    // Спамер пишет валидную бронь — без фильтра она бы прошла.
    vk.pushComment({ id: 301, fromId: SPAMMER_ID, text: "бронь 03204", firstName: "Спамер" });
    // Живой покупатель следом — он должен пройти как обычно.
    vk.pushComment({ id: 302, fromId: BUYER_ID, text: "бронь 03204", firstName: "Аня" });

    const reserved = await client.waitFor(hasReservedFrom(BUYER_ID), { timeoutMs: 6000 });
    const events = reserved.activeLot.reservations.events;

    assert.ok(
      !events.some((e) => e.viewerId === SPAMMER_ID),
      "заблокированный зритель не должен получать бронь",
    );
    assert.equal(reserved.activeLot.reservations.committedReservationCount, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("заблокированный зритель не поднимает reservationAttention", async () => {
  const vk = createVkMock();
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
    vk,
    blockedViewersStore: createBlockedStoreStub([SPAMMER_ID]),
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot);

    // Код, под который открытого лота нет: у обычного зрителя это дало бы
    // строку «требует внимания» на дашборде. У заблокированного — тишина.
    vk.pushComment({ id: 311, fromId: SPAMMER_ID, text: "бронь 09999", firstName: "Спамер" });
    vk.pushComment({ id: 312, fromId: BUYER_ID, text: "бронь 03204", firstName: "Аня" });

    await client.waitFor(hasReservedFrom(BUYER_ID), { timeoutMs: 6000 });

    const attention = client.messages.filter(
      (m) => m.type === "reservationAttention" && m.viewerId === SPAMMER_ID,
    );
    assert.equal(attention.length, 0, "спамер не должен попадать в «требует внимания»");
  } finally {
    await client.close();
    await harness.close();
  }
});
