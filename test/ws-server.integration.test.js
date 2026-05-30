import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/ws-harness.js";

// Эти тесты валидируют саму обвязку (test/helpers/ws-harness.js) на уже
// существующем поведении ws-server: голосовое открытие лота, ручная цена,
// ручное закрытие. Это «Prerequisite — WebSocket integration tests» из
// knowledge/wiki/deferred-operator-features.md. Сценарии manual-code (#14)
// добавляются поверх в отдельном тест-файле.

const CARD_03204 = {
  id: "p-03204",
  name: "Серьги янтарь",
  code: "03204",
  pathName: "Украшения/Серьги",
  salePrice: 4500,
  availableStock: 7,
};

// Гоняет голосовой путь: start → onFinal(транскрипт с триггером) → лот.
async function openLotByVoice(client, harness, text = "код товара 03204") {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  // start обрабатывается асинхронно — дожидаемся фейковой SpeechKit-сессии.
  const session = await harness.waitForSession();
  session.handlers.onFinal({ text, latencyMs: 10 });
  return client.waitFor((m) => m.type === "state" && m.activeLot);
}

test("harness: voice-confirmed detection opens a lot and publishes a VK card", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
  });
  const client = await harness.connect();
  try {
    const state = await openLotByVoice(client, harness);
    assert.equal(state.activeLot.code, "03204");
    // source лота = метка способа извлечения из article-extractor ("regex"),
    // не "voice". Ручной ввод (#14) будет отдельным значением "manual".
    assert.equal(state.activeLot.source, "regex");
    assert.equal(harness.vk.callsTo("publishLotCard").length, 1);
    assert.equal(harness.moysklad.callsTo("getProductCardByCode")[0].args[0], "03204");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("harness: setLotPrice overrides price on the active lot (priceSource=manual)", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
  });
  const client = await harness.connect();
  try {
    await openLotByVoice(client, harness);
    client.send({ type: "setLotPrice", value: 5200 });
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.priceSource === "manual",
    );
    assert.equal(state.activeLot.product.voicePrice, 5200);
    assert.equal(state.activeLot.product.salePrice, 5200);
    assert.ok(harness.vk.callsTo("publishPriceUpdate").length >= 1);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("harness: closeLot clears the active lot and publishes lot-closed", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
  });
  const client = await harness.connect();
  try {
    await openLotByVoice(client, harness);
    client.send({ type: "closeLot" });
    const state = await client.waitFor((m) => m.type === "state" && m.activeLot === null);
    assert.equal(state.activeLot, null);
    assert.ok(harness.vk.callsTo("publishLotClosed").length >= 1);
  } finally {
    await client.close();
    await harness.close();
  }
});
