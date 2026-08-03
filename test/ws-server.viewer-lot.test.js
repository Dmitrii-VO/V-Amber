import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createVkMock, createChatClientMock } from "./helpers/ws-harness.js";

// Карточка лота на своей площадке /efir/: оператор называет артикул — зритель
// видит лот (замечание Романа: в VK карточка есть, у нас лот «не высвечивался»).
// Проверяем сквозной путь ws-server → chat-service, а не только сам публикатор.

const CARD_03204 = {
  id: "p-03204",
  name: "Серьги янтарь",
  code: "03204",
  pathName: "Украшения/Серьги",
  salePrice: 4500,
  availableStock: 7,
};

test("открытие лота публикует карточку зрителям своей площадки", async () => {
  const chatClient = createChatClientMock();
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
    vk: createVkMock(),
    chatClient,
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot);

    const published = await chatClient.waitForLot((p) => p.lot?.code === "03204");
    assert.equal(published.lot.name, "Серьги янтарь");
    assert.equal(published.lot.price, 4500);
    assert.equal(published.lot.availableStock, 7);
    assert.equal(published.lot.status, "open");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("закрытие лота переводит карточку в статус closed, остановка эфира её снимает", async () => {
  const chatClient = createChatClientMock();
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
    vk: createVkMock(),
    chatClient,
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    const state = await client.waitFor((m) => m.type === "state" && m.activeLot);
    await chatClient.waitForLot((p) => p.lot?.code === "03204");

    client.send({ type: "closeLot", lotSessionId: state.activeLot.lotSessionId });
    await chatClient.waitForLot((p) => p.lot?.status === "closed", { timeoutMs: 6000 });

    client.send({ type: "stop" });
    await chatClient.waitForLot((p) => p.lot === null, { timeoutMs: 6000 });
  } finally {
    await client.close();
    await harness.close();
  }
});
