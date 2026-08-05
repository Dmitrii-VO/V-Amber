import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMoyskladMock,
  createVkMock,
  startHarness,
} from "./helpers/ws-harness.js";

const CARD = {
  id: "p-03820",
  name: "Кольцо",
  code: "03820",
  salePrice: 1700,
  availableStock: 1,
};

test("stream stop migrates a pending waitlist once and sends the final VK outcome", async () => {
  let resolveFirstOrder;
  const firstOrder = new Promise((resolve) => { resolveFirstOrder = resolve; });
  const moysklad = createMoyskladMock({
    cardsByCode: { "03820": CARD },
    overrides: {
      createCustomerOrderReservation: async () => firstOrder,
    },
  });
  const vk = createVkMock();
  const harness = await startHarness({
    cardsByCode: { "03820": CARD },
    knownCodes: ["03820"],
    moysklad,
    vk,
  });
  const client = await harness.connect();
  let clientClosed = false;

  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03820" });
    await client.waitFor((message) => message.type === "state" && message.activeLot?.code === "03820");

    vk.pushComment({ id: 1001, fromId: 7001, text: "03820", firstName: "Инга" });
    vk.pushComment({ id: 1002, fromId: 7002, text: "03820", firstName: "Валентина" });
    await client.waitFor((message) => message.type === "state"
      && message.activeLot?.reservations?.events?.some(
        (event) => event.viewerId === 7002 && event.status === "waitlist_pending",
      ), { timeoutMs: 6000 });

    client.send({ type: "stop" });
    await client.waitFor((message) => message.type === "state" && message.activeLot === null, { timeoutMs: 6000 });

    assert.equal(harness.wishlistStore.calls.length, 1);
    assert.equal(harness.wishlistStore.calls[0].trigger, "waitlist_close");
    assert.equal(harness.wishlistStore.calls[0].event.viewerId, 7002);
    const finalReplies = vk.callsTo("publishReservationReply")
      .map((call) => call.args[0])
      .filter((reply) => reply.viewerId === 7002 && reply.status === "out_of_stock");
    assert.equal(finalReplies.length, 1);
    assert.match(finalReplies[0].message, /Добавили вас в список ожидания/);

    await client.close();
    clientClosed = true;
    assert.equal(harness.wishlistStore.calls.length, 1, "socket_close must reuse the stream_stop close promise");
  } finally {
    resolveFirstOrder({ id: "co-first", positionId: "pos-first" });
    if (!clientClosed) await client.close();
    await harness.close();
  }
});
