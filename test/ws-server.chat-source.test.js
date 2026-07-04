import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createVkMock, createChatClientMock } from "./helpers/ws-harness.js";

// Чат /efir/ — второй источник броней наравне с VK (см. wiki
// stream-integration). Проверяем контракт врезки:
// 1) сообщение из чата проходит ТОТ ЖЕ денежный путь (лот, сток-гейт,
//    МойСклад), что и VK-комментарий;
// 2) ответ покупателю уходит в чат (postServiceMessage), а НЕ в VK;
// 3) VK-путь при этом работает как раньше — бронь из VK и бронь из чата
//    сосуществуют в одном лоте и делят общий счётчик остатка.

const CARD_03204 = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};

const CHAT_VIEWER_ID = 9_000_000_042;
const VK_VIEWER_ID = 5001;

const hasReservedFrom = (viewerId) => (m) =>
  m.type === "state"
  && Array.isArray(m.activeLot?.reservations?.events)
  && m.activeLot.reservations.events.some(
    (e) => e.viewerId === viewerId
      && (e.status === "reserved" || e.status === "reserved_appended"),
  );

test("chat message reserves through the shared pipeline and replies to chat", async () => {
  const vk = createVkMock();
  const chatClient = createChatClientMock();
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
    vk,
    chatClient,
    config: { chat: { pollMs: 50 } },
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot);

    // Сообщения до инициализации курсора не переигрываются — дождаться её.
    await chatClient.waitForFeedInit();
    chatClient.pushMessage({
      viewerId: CHAT_VIEWER_ID,
      name: "Оля Чатовая",
      phone: "+79990001122",
      text: "бронь 03204",
    });

    const reserved = await client.waitFor(hasReservedFrom(CHAT_VIEWER_ID), { timeoutMs: 6000 });
    const event = reserved.activeLot.reservations.events
      .find((e) => e.viewerId === CHAT_VIEWER_ID);

    assert.equal(event.source, "chat");
    assert.equal(event.viewerName, "Оля Чатовая");
    // Денежный путь общий: заказ в МойСкладе создан.
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 1);
    // Ответ ушёл в чат, а не в VK.
    assert.ok(
      chatClient.serviceMessages.some((text) => text.includes("Оля Чатовая, бронь подтверждена (код 03204)")),
      `ожидали подтверждение в чате, получили: ${JSON.stringify(chatClient.serviceMessages)}`,
    );
    assert.equal(vk.callsTo("publishReservationReply").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("vk and chat reservations share one lot and one stock counter", async () => {
  const vk = createVkMock();
  const chatClient = createChatClientMock();
  const harness = await startHarness({
    cardsByCode: { "03204": { ...CARD_03204, availableStock: 2 } },
    knownCodes: ["03204"],
    vk,
    chatClient,
    config: { chat: { pollMs: 50 } },
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot);
    await chatClient.waitForFeedInit();

    vk.pushComment({ id: 201, fromId: VK_VIEWER_ID, text: "03204", firstName: "Аня" });
    const vkReserved = await client.waitFor(hasReservedFrom(VK_VIEWER_ID), { timeoutMs: 6000 });
    assert.equal(vkReserved.activeLot.reservations.committedReservationCount, 1);

    chatClient.pushMessage({
      viewerId: CHAT_VIEWER_ID,
      name: "Оля Чатовая",
      phone: "+79990001122",
      text: "беру 03204",
    });
    const bothReserved = await client.waitFor(hasReservedFrom(CHAT_VIEWER_ID), { timeoutMs: 6000 });

    // Оба зрителя в одном лоте, счётчик общий: 2 брони из остатка 2.
    assert.equal(bothReserved.activeLot.reservations.committedReservationCount, 2);
    const sources = bothReserved.activeLot.reservations.events
      .map((e) => [e.viewerId, e.source].join(":"))
      .sort();
    assert.deepEqual(sources, [`${VK_VIEWER_ID}:vk`, `${CHAT_VIEWER_ID}:chat`]);
    // VK-ответ ушёл только по VK-брони, чат-ответ — только по чатовой.
    assert.equal(vk.callsTo("publishReservationReply").length, 1);
    assert.equal(chatClient.serviceMessages.length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});
