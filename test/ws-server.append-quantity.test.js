import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createMoyskladMock } from "./helpers/ws-harness.js";
import { setSafeMode } from "../server/safe-mode.js";

// Голосовое «<Имя> добавь N штук <код>» → appendReservationQuantity.
// Реальные деньги: ID-параметры берутся ТОЛЬКО из server-side pending action по
// одноразовому actionId; токен гасится лишь после успешного append; на каждый
// запрос приходит voiceQuantityResult { ok }. См.
// knowledge/wiki/reservation-flow.md → «Voice quantity (+N шт)».

const CARD_03204 = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};

const hasReserved = (m) =>
  m.type === "state"
  && Array.isArray(m.activeLot?.reservations?.events)
  && m.activeLot.reservations.events.some((e) => e.status === "reserved" || e.status === "reserved_appended");

async function startStream(client, harness) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
}

// Открывает лот ручным вводом и проводит одну бронь голым кодом через поллер.
// Возвращает { reserved, viewerName } — реальное имя из VK-профиля, чтобы
// произнесённое имя гарантированно матчилось name-matcher'ом.
async function openLotAndReserve(harness, client, {
  code = "03204", commentId = 101, fromId = 5001, firstName = "Аня", lastName = "Иванова",
} = {}) {
  await startStream(client, harness);
  client.send({ type: "manualCode", code });
  await client.waitFor((m) => m.type === "state" && m.activeLot);
  harness.vk.pushComment({ id: commentId, fromId, text: code, firstName, lastName });
  const reserved = await client.waitFor(hasReserved, { timeoutMs: 6000 });
  const event = reserved.activeLot.reservations.events.find(
    (e) => e.status === "reserved" || e.status === "reserved_appended",
  );
  return { reserved, viewerName: event.viewerName };
}

function speakQuantity(harness, text) {
  harness.getLastSpeechKitSession().handlers.onFinal({ text, latencyMs: 10 });
}

test("voice append: match → confirm → position created, counter bumped, ok ack", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    const { reserved, viewerName } = await openLotAndReserve(harness, client);
    assert.equal(reserved.activeLot.reservations.committedReservationCount, 1);

    speakQuantity(harness, `${viewerName} добавь две штуки 03204`);
    const match = await client.waitFor("voiceQuantityMatch", { timeoutMs: 6000 });
    assert.equal(match.quantity, 2);
    assert.equal(match.capped, false);
    assert.ok(match.actionId, "сервер должен выдать одноразовый actionId");
    // На матче позиция ещё НЕ создаётся — только предложение.
    assert.equal(harness.moysklad.callsTo("appendPositionToCustomerOrder").length, 0);

    client.send({ type: "appendReservationQuantity", actionId: match.actionId });
    const ack = await client.waitFor("voiceQuantityResult", { timeoutMs: 6000 });
    assert.equal(ack.ok, true);

    const appendCalls = harness.moysklad.callsTo("appendPositionToCustomerOrder");
    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].args[0].reservation.quantity, 2);

    const state = client.lastState();
    // 1 (исходная бронь) + 2 (доп-позиция голосом).
    assert.equal(state.activeLot.reservations.committedReservationCount, 3);
    assert.ok(
      state.activeLot.reservations.events.some(
        (e) => e.status === "reserved_appended" && e.quantity === 2,
      ),
      "должно появиться reserved_appended событие на 2 шт",
    );
  } finally {
    await client.close();
    await harness.close();
  }
});

test("voice append: quantity above cap is surfaced (capped flag, requested kept)", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    const { viewerName } = await openLotAndReserve(harness, client);

    speakQuantity(harness, `${viewerName} добавь двадцать штук 03204`);
    const match = await client.waitFor("voiceQuantityMatch", { timeoutMs: 6000 });
    assert.equal(match.quantity, 10);
    assert.equal(match.requested, 20);
    assert.equal(match.capped, true);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("voice append: reused actionId is rejected, no second MoySklad write", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    const { viewerName } = await openLotAndReserve(harness, client);

    speakQuantity(harness, `${viewerName} добавь две штуки 03204`);
    const match = await client.waitFor("voiceQuantityMatch", { timeoutMs: 6000 });

    client.send({ type: "appendReservationQuantity", actionId: match.actionId });
    const firstAck = await client.waitFor("voiceQuantityResult", { timeoutMs: 6000 });
    assert.equal(firstAck.ok, true);

    // Повтор того же токена — он уже погашен после успеха.
    client.send({ type: "appendReservationQuantity", actionId: match.actionId });
    const warning = await client.waitFor("warning", { timeoutMs: 6000 });
    assert.match(warning.message, /устарела|применена/);
    const reusedAck = await client.waitFor("voiceQuantityResult", { timeoutMs: 6000 });
    assert.equal(reusedAck.ok, false);
    assert.equal(harness.moysklad.callsTo("appendPositionToCustomerOrder").length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("voice append: safe-mode blocks the write, ack:false, token untouched", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD_03204 }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    const { viewerName } = await openLotAndReserve(harness, client);

    speakQuantity(harness, `${viewerName} добавь две штуки 03204`);
    const match = await client.waitFor("voiceQuantityMatch", { timeoutMs: 6000 });

    client.send({ type: "setSafeMode", enabled: true });
    await client.waitFor((m) => m.type === "state" && m.safeMode === true);

    client.send({ type: "appendReservationQuantity", actionId: match.actionId });
    const warning = await client.waitFor("warning", { timeoutMs: 6000 });
    assert.match(warning.message, /safe-mode/);
    const ack = await client.waitFor("voiceQuantityResult", { timeoutMs: 6000 });
    assert.equal(ack.ok, false);
    assert.equal(harness.moysklad.callsTo("appendPositionToCustomerOrder").length, 0);

    // Токен пережил отказ: после выключения safe-mode тот же actionId работает.
    client.send({ type: "setSafeMode", enabled: false });
    await client.waitFor((m) => m.type === "state" && m.safeMode === false);
    client.send({ type: "appendReservationQuantity", actionId: match.actionId });
    const retryAck = await client.waitFor("voiceQuantityResult", { timeoutMs: 6000 });
    assert.equal(retryAck.ok, true);
    assert.equal(harness.moysklad.callsTo("appendPositionToCustomerOrder").length, 1);
  } finally {
    setSafeMode(false, { source: "test-cleanup" });
    await client.close();
    await harness.close();
  }
});

test("voice append: MoySklad failure keeps the token alive for a retry", async () => {
  // appendPositionToCustomerOrder падает на первом вызове и проходит на втором.
  let calls = 0;
  const moysklad = createMoyskladMock({
    cardsByCode: { "03204": CARD_03204 },
    overrides: {
      appendPositionToCustomerOrder: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom: MoySklad 500");
        return { orderId: "co-test-1", positionId: "pos-appended-retry" };
      },
    },
  });
  const harness = await startHarness({ knownCodes: ["03204"], moysklad });
  const client = await harness.connect();
  try {
    const { viewerName } = await openLotAndReserve(harness, client);

    speakQuantity(harness, `${viewerName} добавь две штуки 03204`);
    const match = await client.waitFor("voiceQuantityMatch", { timeoutMs: 6000 });

    // Первый клик → ошибка, ok:false, токен НЕ потрачен.
    client.send({ type: "appendReservationQuantity", actionId: match.actionId });
    const failWarning = await client.waitFor("warning", { timeoutMs: 6000 });
    assert.match(failWarning.message, /не удалось/i);
    const failAck = await client.waitFor("voiceQuantityResult", { timeoutMs: 6000 });
    assert.equal(failAck.ok, false);

    // Повтор по тому же токену → теперь успех.
    client.send({ type: "appendReservationQuantity", actionId: match.actionId });
    const okAck = await client.waitFor("voiceQuantityResult", { timeoutMs: 6000 });
    assert.equal(okAck.ok, true);
    assert.equal(harness.moysklad.callsTo("appendPositionToCustomerOrder").length, 2);
    assert.equal(client.lastState().activeLot.reservations.committedReservationCount, 3);
  } finally {
    await client.close();
    await harness.close();
  }
});
