import { test } from "node:test";
import assert from "node:assert/strict";
import { createMoyskladMock, startHarness } from "./helpers/ws-harness.js";

// Смена цены после первых броней должна догонять уже созданные позиции в
// МойСкладе — ровно как это давно делает скидка. До объединения путей backfill
// звала только applyDiscount, поэтому ручная правка цены (единственный способ
// исправить неверную цену на лоте) оставляла заказы по старой цене, и оператор
// правил их руками. Эфир 2026-08-15, лот 03048.
//
// Второй инвариант здесь же: скидка хранится абсолютной суммой, но объявлена
// могла быть процентом. После смены цены процент обязан пересчитаться, иначе
// 5 % от старой цены остаются рублями на новой (тот же 03048: цена вернулась
// на 8800 ₽, а лот остался 8768 ₽ — 32 ₽ это 5 % от ложных 650 ₽).

const CARD = {
  id: "p-03048", name: "Бусы «Галька»", code: "03048",
  pathName: "Украшения/Бусы", salePrice: 2200, availableStock: 5,
};

const hasReserved = (m) =>
  m.type === "state"
  && m.activeLot?.reservations?.events?.some((e) => e.status === "reserved" || e.status === "reserved_appended");

async function openLotAndReserve(harness, client) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code: "03048" });
  await client.waitFor((m) => m.type === "state" && m.activeLot);
  harness.vk.pushComment({ id: 101, fromId: 5001, text: "03048", firstName: "Аня" });
  return client.waitFor(hasReserved, { timeoutMs: 6000 });
}

test("ручная смена цены пересчитывает уже созданную позицию", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client);

    client.send({ type: "setLotPrice", value: 8800 });
    await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.salePrice === 8800,
      { timeoutMs: 6000 },
    );

    const calls = harness.moysklad.callsTo("updateCustomerOrderPositionPricing");
    assert.equal(calls.length, 1, "позиция брони должна быть пересчитана ровно один раз");
    assert.deepEqual(calls[0].args[0], {
      orderId: "co-test-1",
      positionId: "pos-created-1",
      salePrice: 8800,
      discountAmount: 0,
      source: "price_backfill",
    });
  } finally {
    await client.close();
    await harness.close();
  }
});

test("процентная скидка переживает смену цены, абсолютная остаётся в рублях", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client);

    // 5 % от 2200 = 110 ₽.
    harness.getLastSpeechKitSession().handlers.onFinal({ text: "скидка пять процентов", latencyMs: 10 });
    await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.discountAmount === 110,
      { timeoutMs: 6000 },
    );

    client.send({ type: "setLotPrice", value: 8800 });
    // 5 % от 8800 = 440 ₽, а не унаследованные 110 ₽.
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.salePrice === 8800,
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.discountAmount, 440);

    const calls = harness.moysklad.callsTo("updateCustomerOrderPositionPricing");
    const last = calls.at(-1).args[0];
    assert.equal(last.salePrice, 8800);
    assert.equal(last.discountAmount, 440);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("абсолютная скидка не пересчитывается при смене цены", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client);

    harness.getLastSpeechKitSession().handlers.onFinal({ text: "скидка двести рублей", latencyMs: 10 });
    await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.discountAmount === 200,
      { timeoutMs: 6000 },
    );

    client.send({ type: "setLotPrice", value: 8800 });
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.salePrice === 8800,
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.discountAmount, 200);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("параллельные смены цены пишутся в МойСклад в порядке команд", async () => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const completedPrices = [];
  let updateNumber = 0;
  const moysklad = createMoyskladMock({
    cardsByCode: { "03048": CARD },
    overrides: {
      updateCustomerOrderPositionPricing: async ({ salePrice }) => {
        updateNumber += 1;
        if (updateNumber === 1) await firstBlocked;
        completedPrices.push(salePrice);
        return { ok: true };
      },
    },
  });
  const harness = await startHarness({ moysklad, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLotAndReserve(harness, client);

    client.send({ type: "setLotPrice", value: 8800 });
    while (moysklad.callsTo("updateCustomerOrderPositionPricing").length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    client.send({ type: "setLotPrice", value: 9900 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(
      moysklad.callsTo("updateCustomerOrderPositionPricing").length,
      1,
      "вторая запись не должна обгонять незавершённую первую",
    );

    releaseFirst();
    await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.salePrice === 9900,
      { timeoutMs: 6000 },
    );
    assert.deepEqual(completedPrices, [8800, 9900]);
  } finally {
    releaseFirst();
    await client.close();
    await harness.close();
  }
});
