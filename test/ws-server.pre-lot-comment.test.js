import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/ws-harness.js";

// Эфир 2026-10-17: покупатели писали код за 1–3 с до того, как речь открыла
// лот (03922, 00701 ×2), и бронь терялась — строку «требует внимания»
// оператор во время эфира не нажимает. Теперь такой комментарий
// переигрывается через обычный путь брони, когда лот под код открылся.
const CARDS = {
  "03048": { id: "p-03048", name: "Бусы «Галька»", code: "03048", pathName: "Бусы", salePrice: 2500, availableStock: 5 },
  "03922": { id: "p-03922", name: "Бусы «Мятый шар»", code: "03922", pathName: "Бусы", salePrice: 3250, availableStock: 2 },
  "03555": { id: "p-03555", name: "Нить", code: "03555", pathName: "Нити", salePrice: 1000, availableStock: 2 },
};

async function openFirstLot(harness, client) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code: "03048" });
  await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03048");
}

const reservedOn = (code, viewerId) => (m) => m.type === "state"
  && (m.openLots || [m.activeLot]).some((lot) => lot?.code === code
    && lot.reservations?.events?.some((e) => e.viewerId === viewerId && e.status === "reserved"));

test("код, написанный до открытия лота, бронируется, когда лот открылся", async () => {
  const harness = await startHarness({ cardsByCode: CARDS, knownCodes: Object.keys(CARDS) });
  const client = await harness.connect();
  try {
    await openFirstLot(harness, client);
    harness.vk.pushComment({ id: 201, fromId: 7001, text: "03922", firstName: "Галина" });
    await client.waitFor((m) => m.type === "reservationAttention" && m.code === "03922", { timeoutMs: 6000 });
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);

    client.send({ type: "manualCode", code: "03922" });
    await client.waitFor(reservedOn("03922", 7001), { timeoutMs: 6000 });
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("комментарий с другим кодом при открытии лота не бронируется", async () => {
  const harness = await startHarness({ cardsByCode: CARDS, knownCodes: Object.keys(CARDS) });
  const client = await harness.connect();
  try {
    await openFirstLot(harness, client);
    harness.vk.pushComment({ id: 202, fromId: 7002, text: "03555", firstName: "Ольга" });
    await client.waitFor((m) => m.type === "reservationAttention" && m.code === "03555", { timeoutMs: 6000 });

    client.send({ type: "manualCode", code: "03922" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03922", { timeoutMs: 6000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});
