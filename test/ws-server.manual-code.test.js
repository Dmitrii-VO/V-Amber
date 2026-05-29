import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/ws-harness.js";

// Сценарии ручного ввода кода на активном лоте (#14). Вариант А: ручной ввод
// разрешён только при активном STT-стриме; код обязан быть в каталоге.
// См. knowledge/wiki/deferred-operator-features.md #14.

const CARD_03204 = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};
const CARD_03199 = {
  id: "p-03199", name: "Кольцо янтарь", code: "03199",
  pathName: "Украшения/Кольца", salePrice: 3200, availableStock: 4,
};

// Запускает STT-стрим (без голосовой детекции) — ставит activeRunId.
async function startStream(client, harness) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
}

test("#14: manualCode before stream start is rejected (Variant A gate)", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    client.send({ type: "manualCode", code: "03204" });
    const warning = await client.waitFor("warning");
    assert.match(warning.message, /Запустите распознавание/);
    assert.equal(harness.moysklad.callsTo("getProductCardByCode").length, 0);
    assert.equal(harness.vk.callsTo("publishLotCard").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode with a code outside the catalog is rejected", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "99999" });
    const warning = await client.waitFor("warning");
    assert.match(warning.message, /не найден в каталоге/);
    assert.equal(harness.moysklad.callsTo("getProductCardByCode").length, 0);
    assert.equal(harness.vk.callsTo("publishLotCard").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode is rejected when the catalog is not loaded", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: [] });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    const warning = await client.waitFor("warning");
    assert.match(warning.message, /Каталог товаров не загружен/);
    assert.equal(harness.vk.callsTo("publishLotCard").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode on idle opens a new lot with source=manual", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    const state = await client.waitFor((m) => m.type === "state" && m.activeLot);
    assert.equal(state.activeLot.code, "03204");
    assert.equal(state.activeLot.source, "manual");
    assert.equal(state.activeLot.product.name, "Серьги янтарь");
    assert.equal(harness.vk.callsTo("publishLotCard").length, 1);
    assert.equal(harness.moysklad.callsTo("getProductCardByCode")[0].args[0], "03204");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode matching the active lot merges (no new lot, no new VK card)", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    const first = await client.waitFor((m) => m.type === "state" && m.activeLot);
    const lotSessionId = first.activeLot.lotSessionId;

    client.send({ type: "manualCode", code: "03204" });
    const second = await client.waitFor((m) => m.type === "state" && m.activeLot);
    // Тот же lotSessionId — merge, а не close+reopen: брони сохраняются.
    assert.equal(second.activeLot.lotSessionId, lotSessionId);
    // Карточка VK опубликована ровно один раз (нет дубля поллера/карточки).
    assert.equal(harness.vk.callsTo("publishLotCard").length, 1);
    assert.equal(harness.vk.callsTo("publishLotClosed").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manual -> voice -> manual on the same code keeps a single lot", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    const session = harness.getLastSpeechKitSession();

    client.send({ type: "manualCode", code: "03204" });
    const first = await client.waitFor((m) => m.type === "state" && m.activeLot);
    const lotSessionId = first.activeLot.lotSessionId;

    // Голосовой повтор того же кода → merge.
    session.handlers.onFinal({ text: "код товара 03204", latencyMs: 10 });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.lotSessionId === lotSessionId);

    // Снова ручной ввод того же кода → merge.
    client.send({ type: "manualCode", code: "03204" });
    const third = await client.waitFor((m) => m.type === "state" && m.activeLot);

    assert.equal(third.activeLot.lotSessionId, lotSessionId);
    // Один лот за всю цепочку → одна карточка, ни одного закрытия.
    assert.equal(harness.vk.callsTo("publishLotCard").length, 1);
    assert.equal(harness.vk.callsTo("publishLotClosed").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("#14: manualCode switching to a different code closes the previous lot", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204, "03199": CARD_03199 },
    knownCodes: ["03204", "03199"],
  });
  const client = await harness.connect();
  try {
    await startStream(client, harness);
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

    client.send({ type: "manualCode", code: "03199" });
    const switched = await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03199");

    assert.equal(switched.activeLot.source, "manual");
    assert.equal(harness.vk.callsTo("publishLotCard").length, 2);
    assert.equal(harness.vk.callsTo("publishLotClosed").length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});
