import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createMoyskladMock } from "./helpers/ws-harness.js";

// Отказы кнопки «✓ забронировать» не писались никуда: в логах эфира «не
// кликали» и «кликнул, но не получилось» выглядели одинаково. По шести
// строкам 15.08 до сих пор неизвестно, что произошло, — и именно поэтому на
// жалобу «не работает твоя бронь ручная» ответить было нечем.
//
// Теперь каждый исход обработчика пишет ровно одно структурное событие.
const CARD = {
  id: "p-03723", name: "Ручка", code: "03723",
  salePrice: 1500, availableStock: 5,
};
const LOT_CARD = {
  id: "p-03204", name: "Браслет", code: "03204",
  salePrice: 2000, availableStock: 5,
};
const KNOWN = ["03204", "03723"];

function captureLogs() {
  const events = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const line = typeof chunk === "string" ? chunk : chunk.toString();
    for (const part of line.split("\n")) {
      if (!part.includes("attention_reservation_outcome")) continue;
      try { events.push(JSON.parse(part).meta); } catch { /* не наша строка */ }
    }
    return original(chunk, ...rest);
  };
  return { events, restore: () => { process.stdout.write = original; } };
}

// Открыт лот 03204, а покупатель просит 03723 — открытого лота под этот код
// нет, и сервер выносит строку оператору.
async function attentionRow(harness, client) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code: "03204" });
  await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");

  harness.vk.pushComment({ id: 501, fromId: 8101, text: "бронь 03723", firstName: "Марго", lastName: "Краснова" });
  return client.waitFor((m) => m.type === "reservationAttention" && m.actionId, { timeoutMs: 6000 });
}

test("успешная бронь из строки внимания пишет один структурный исход", async () => {
  const capture = captureLogs();
  const moysklad = createMoyskladMock({
    cardsByCode: { "03723": CARD, "03204": LOT_CARD },
    overrides: { ensureCounterparty: async () => ({ id: "cp-1", name: "Марго Краснова" }) },
  });
  const harness = await startHarness({ knownCodes: KNOWN, moysklad });
  const client = await harness.connect();
  try {
    const row = await attentionRow(harness, client);
    client.send({ type: "reserveFromAttention", actionId: row.actionId });
    await client.waitFor((m) => m.type === "attentionReservationResult" && m.ok === true, { timeoutMs: 6000 });

    const outcomes = capture.events.filter((e) => e.actionId === row.actionId);
    assert.equal(outcomes.length, 1, "исход должен быть ровно один");
    assert.equal(outcomes[0].status, "reserved");
    assert.equal(outcomes[0].code, "03723");
    assert.equal(outcomes[0].viewerId, 8101);
    assert.ok(outcomes[0].orderId, "в исходе должен быть номер заказа");
    assert.ok(typeof outcomes[0].tokenAgeMs === "number");
  } finally {
    capture.restore();
    await client.close();
    await harness.close();
  }
});

test("отказ тоже пишется — раньше он не оставлял следа вовсе", async () => {
  const capture = captureLogs();
  const moysklad = createMoyskladMock({
    cardsByCode: { "03723": { ...CARD, salePrice: 0 }, "03204": LOT_CARD },
  });
  const harness = await startHarness({ knownCodes: KNOWN, moysklad });
  const client = await harness.connect();
  try {
    const row = await attentionRow(harness, client);
    client.send({ type: "reserveFromAttention", actionId: row.actionId });
    await client.waitFor((m) => m.type === "attentionReservationResult" && m.ok === false, { timeoutMs: 6000 });

    const outcomes = capture.events.filter((e) => e.actionId === row.actionId);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "no_price");
    assert.equal(outcomes[0].ok, false);
  } finally {
    capture.restore();
    await client.close();
    await harness.close();
  }
});

test("строка внимания несёт срок действия и способ совпадения по каталогу", async () => {
  const harness = await startHarness({ cardsByCode: { "03723": CARD, "03204": LOT_CARD }, knownCodes: KNOWN });
  const client = await harness.connect();
  try {
    const row = await attentionRow(harness, client);
    assert.equal(row.catalogMatchReason, "exact");
    assert.ok(row.expiresAt > Date.now(), "срок действия строки должен приходить с сервера");
  } finally {
    await client.close();
    await harness.close();
  }
});
