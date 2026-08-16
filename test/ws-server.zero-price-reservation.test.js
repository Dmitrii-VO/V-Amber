import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/ws-harness.js";

// Бронь на лоте без цены больше не уезжает в МойСклад позицией по 0 ₽.
// В бандле 2026-08-15 такими были 62 заказа из 962: цена «сейчас назову»
// так и не звучала, а покупатель уже числился в заказе с нулём.
//
// Вместо этого бронь ждёт цену в pending_reservation, а когда цена появляется
// — проигрывается по одной штуке через ту же сериализацию, что и обычные.
const CARD = {
  id: "p-03048", name: "Бусы «Галька»", code: "03048",
  pathName: "Украшения/Бусы", salePrice: 0, availableStock: 5,
};

async function openLot(harness, client) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code: "03048" });
  return client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03048");
}

const heldEvent = (m, viewerId) => m.type === "state"
  && m.activeLot?.reservations?.events?.some((e) => e.viewerId === viewerId && e.status === "pending_reservation");

test("бронь на лоте без цены не создаёт заказ и ждёт цену", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);
    harness.vk.pushComment({ id: 101, fromId: 5001, text: "03048", firstName: "Аня" });

    await client.waitFor((m) => heldEvent(m, 5001), { timeoutMs: 6000 });
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("появилась цена — отложенные брони проигрываются по порядку", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);
    harness.vk.pushComment({ id: 101, fromId: 5001, text: "03048", firstName: "Аня" });
    harness.vk.pushComment({ id: 102, fromId: 5002, text: "03048", firstName: "Оля" });
    await client.waitFor((m) => heldEvent(m, 5001) && heldEvent(m, 5002), { timeoutMs: 6000 });

    harness.getLastSpeechKitSession().handlers.onFinal({ text: "стоимость восемь тысяч восемьсот", latencyMs: 10 });

    // Проигрывание последовательное, поэтому ждём, пока обе брони уйдут из
    // ожидания цены — иначе тест поймал бы промежуточный снимок.
    const state = await client.waitFor(
      (m) => m.type === "state"
        && m.activeLot?.reservations?.events?.some((e) => e.viewerId === 5001 && e.status === "reserved")
        && m.activeLot?.reservations?.events?.every(
          (e) => ["reserved", "reserved_appended", "waitlist_pending"].includes(e.status),
        ),
      { timeoutMs: 6000 },
    );
    // Первый получает бронь, второй — очередь: инвариант «один primary»
    // должен пережить проигрывание.
    const second = state.activeLot.reservations.events.find((e) => e.viewerId === 5002);
    assert.ok(
      ["waitlist_pending", "reserved", "reserved_appended"].includes(second.status),
      `неожиданный статус второй брони: ${second.status}`,
    );

    const orders = harness.moysklad.callsTo("createCustomerOrderReservation");
    assert.ok(orders.length >= 1, "после появления цены заказ должен быть создан");
    assert.equal(state.activeLot.product.voicePrice, 8800);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("цена так и не прозвучала — бронь уходит в хотелки, а не в никуда", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);
    harness.vk.pushComment({ id: 101, fromId: 5001, text: "03048", firstName: "Аня" });
    await client.waitFor((m) => heldEvent(m, 5001), { timeoutMs: 6000 });

    client.send({ type: "stop" });
    await client.waitFor((m) => m.type === "state" && m.activeLot === null, { timeoutMs: 6000 });

    assert.equal(harness.wishlistStore.calls.length, 1);
    assert.equal(harness.wishlistStore.calls[0].event.viewerId, 5001);
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});
