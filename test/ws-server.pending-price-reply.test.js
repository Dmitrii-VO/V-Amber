import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createVkMock } from "./helpers/ws-harness.js";
import { getReservationReplyMessage } from "../server/ws-helpers.js";

// Лот без цены: позицию в МойСклад не пишем (иначе уйдёт по 0 ₽), но и молчать
// нельзя. До этой правки бронь была тихой для ВСЕХ: покупателю не отвечали
// ничего, а оператору уходило предупреждение на дашборд, в который он во время
// эфира не смотрит. По логам 13 эфиров 177 лотов из 305 с нулевой ценой так и
// не дождались цены, и на них пришлись 116 броней.

const CARD_NO_PRICE = {
  id: "p-03048", name: "Бусы «Галька»", code: "03048",
  pathName: "Украшения/Бусы", salePrice: 0, availableStock: 5,
};

test("покупатель получает ответ, что бронь принята и ждёт цену", () => {
  const message = getReservationReplyMessage(
    { status: "pending_reservation", viewerName: "Аня" },
    { code: "03048" },
  );
  assert.match(message, /Аня/);
  assert.match(message, /03048/);
  assert.match(message, /ждём цену/i);
});

test("бронь без цены, уехавшая в хотелки, объясняет настоящую причину", () => {
  const message = getReservationReplyMessage(
    {
      status: "out_of_stock",
      previousStatus: "pending_reservation",
      wishlistEntryId: "w-1",
      viewerName: "Аня",
    },
    { code: "03048" },
  );
  assert.match(message, /цену/i, "«товара не хватило» тут обманывает: товар был");
  assert.doesNotMatch(message, /не хватило/i);
});

test("обычная нехватка товара отвечает по-прежнему", () => {
  const message = getReservationReplyMessage(
    { status: "out_of_stock", wishlistEntryId: "w-1", viewerName: "Аня" },
    { code: "03048" },
  );
  assert.match(message, /не хватило/i);
});

test("бронь по лоту без цены: ответ покупателю и звук оператору", async () => {
  const vk = createVkMock();
  const harness = await startHarness({
    cardsByCode: { "03048": CARD_NO_PRICE },
    knownCodes: ["03048"],
    vk,
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03048" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03048");

    vk.pushComment({ id: 601, fromId: 5001, text: "03048", firstName: "Аня" });

    const warning = await client.waitFor(
      (m) => m.type === "warning" && /ждёт цену/.test(m.message || ""),
      { timeoutMs: 6000 },
    );
    assert.equal(warning.sound, "attention", "оператор должен УСЛЫШАТЬ, а не увидеть");

    const replies = vk.callsTo("publishReservationReply");
    assert.equal(replies.length, 1, "покупателю отвечаем сразу, а не при закрытии лота");
    assert.match(replies[0].args[0].message, /ждём цену/i);
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0,
      "позиция по нулевой цене в МойСклад уйти не должна");
  } finally {
    await client.close();
    await harness.close();
  }
});
