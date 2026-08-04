import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createMoyskladMock } from "./helpers/ws-harness.js";

// lot.reservations.events обрезался до последних 20 (state.events.slice(-20)).
// Массив — рабочее состояние лота, а не лог, поэтому на популярном лоте
// вытеснение ранних броней ломало расчёты. Тесты фиксируют два самых дорогих
// последствия: недосчитанную скидку и потерянную очередь ожидания.

const POPULAR = {
  id: "p-03737", name: "Бусы", code: "03737",
  pathName: "Украшения/Бусы", salePrice: 2200, availableStock: 30,
};

const RESERVED = new Set(["reserved", "reserved_appended"]);

function countByStatus(message, statuses) {
  const events = message?.activeLot?.reservations?.events;
  if (!Array.isArray(events)) return 0;
  return events.filter((event) => statuses.has(event.status)).length;
}

// Уникальные positionId на каждую бронь: иначе backfill нельзя отличить
// «пересчитал все» от «пересчитал одну и ту же».
function makeMoysklad(card) {
  let created = 0;
  return createMoyskladMock({
    cardsByCode: { "03737": card },
    overrides: {
      createCustomerOrderReservation: async () => {
        created += 1;
        return { id: `co-${created}`, positionId: `pos-${created}` };
      },
      appendPositionToCustomerOrder: async () => {
        created += 1;
        return { orderId: `co-${created}`, positionId: `pos-${created}` };
      },
    },
  });
}

async function openLot(harness, client) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code: "03737" });
  await client.waitFor((m) => m.type === "state" && m.activeLot);
}

function pushBuyers(harness, count) {
  for (let index = 1; index <= count; index += 1) {
    harness.vk.pushComment({
      id: 100 + index,
      fromId: 5000 + index,
      text: "03737",
      firstName: `Покупатель${index}`,
    });
  }
}

test("скидка догоняет все брони лота, а не только последние двадцать", async () => {
  const moysklad = makeMoysklad(POPULAR);
  const harness = await startHarness({ knownCodes: ["03737"], moysklad });
  const client = await harness.connect();
  try {
    await openLot(harness, client);
    pushBuyers(harness, 22);

    await client.waitFor(
      (m) => m.type === "state" && countByStatus(m, RESERVED) === 22,
      { timeoutMs: 30000 },
    );

    harness.getLastSpeechKitSession().handlers.onFinal({ text: "скидка пять процентов", latencyMs: 10 });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.discountAmount > 0, { timeoutMs: 10000 });

    const calls = harness.moysklad.callsTo("updateCustomerOrderPositionPricing");
    assert.equal(calls.length, 22, "пересчитаться должны все 22 брони, а не 20");

    // Именно самые ранние покупатели вытеснялись обрезкой и платили полную цену.
    const positions = calls.map((call) => call.args[0].positionId);
    assert.ok(positions.includes("pos-1"), "первая бронь лота обязана попасть в пересчёт");
    assert.ok(positions.includes("pos-2"), "вторая бронь лота обязана попасть в пересчёт");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("все брони остаются в состоянии лота — журнал эфира не теряет ранних покупателей", async () => {
  const moysklad = makeMoysklad(POPULAR);
  const harness = await startHarness({ knownCodes: ["03737"], moysklad });
  const client = await harness.connect();
  try {
    await openLot(harness, client);
    pushBuyers(harness, 25);

    const state = await client.waitFor(
      (m) => m.type === "state" && countByStatus(m, RESERVED) === 25,
      { timeoutMs: 30000 },
    );

    const viewerIds = state.activeLot.reservations.events.map((event) => event.viewerId);
    assert.ok(viewerIds.includes(5001), "первый покупатель эфира не должен вытесняться");
    assert.equal(new Set(viewerIds).size, 25);
  } finally {
    await client.close();
    await harness.close();
  }
});
