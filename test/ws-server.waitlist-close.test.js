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
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(harness.wishlistStore.calls.length, 0, "close must wait for the in-flight MoySklad write");
    resolveFirstOrder({ id: "co-first", positionId: "pos-first" });
    await client.waitFor((message) => message.type === "state" && message.activeLot === null, { timeoutMs: 6000 });

    assert.equal(harness.wishlistStore.calls.length, 1);
    assert.equal(harness.wishlistStore.calls[0].trigger, "waitlist_close");
    assert.equal(harness.wishlistStore.calls[0].event.viewerId, 7002);
    const finalReplies = vk.callsTo("publishReservationReply")
      .map((call) => call.args[0])
      .filter((reply) => reply.viewerId === 7002 && reply.status === "out_of_stock");
    assert.equal(finalReplies.length, 1);
    assert.match(finalReplies[0].message, /Добавили вас в список ожидания/);
    assert.equal(
      vk.callsTo("publishReservationReply").filter(
        (call) => call.args[0].viewerId === 7001 && call.args[0].status === "reserved",
      ).length,
      1,
      "close must await the final reply for the in-flight successful order",
    );

    await client.close();
    clientClosed = true;
    assert.equal(harness.wishlistStore.calls.length, 1, "socket_close must reuse the stream_stop close promise");
  } finally {
    resolveFirstOrder({ id: "co-first", positionId: "pos-first" });
    if (!clientClosed) await client.close();
    await harness.close();
  }
});

test("stream stop awaits a lot already closing manually", async () => {
  let resolveFirstOrder;
  const firstOrder = new Promise((resolve) => { resolveFirstOrder = resolve; });
  let resolveMigration;
  const migrationGate = new Promise((resolve) => { resolveMigration = resolve; });
  const wishlistCalls = [];
  const wishlistStore = {
    async addFromOutOfStock(input) {
      wishlistCalls.push(input);
      await migrationGate;
      return { id: "wishlist-manual-close" };
    },
    flush: async () => {},
    getActiveCount: () => wishlistCalls.length,
    subscribe: () => {},
  };
  const moysklad = createMoyskladMock({
    cardsByCode: { "03820": CARD },
    overrides: { createCustomerOrderReservation: async () => firstOrder },
  });
  const vk = createVkMock();
  const harness = await startHarness({
    cardsByCode: { "03820": CARD },
    knownCodes: ["03820"],
    moysklad,
    vk,
    wishlistStore,
  });
  const client = await harness.connect();

  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03820" });
    await client.waitFor((message) => message.type === "state" && message.activeLot?.code === "03820");
    vk.pushComment({ id: 2001, fromId: 8001, text: "03820", firstName: "Инга" });
    vk.pushComment({ id: 2002, fromId: 8002, text: "03820", firstName: "Валентина" });
    await client.waitFor((message) => message.type === "state"
      && message.activeLot?.reservations?.events?.some(
        (event) => event.viewerId === 8002 && event.status === "waitlist_pending",
      ), { timeoutMs: 6000 });

    client.send({ type: "closeLot", code: "03820" });
    client.send({ type: "stop" });
    resolveFirstOrder({ id: "co-first", positionId: "pos-first" });
    const deadline = Date.now() + 6000;
    while (wishlistCalls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(wishlistCalls.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.lastState()?.activeLot?.code, "03820", "stop must wait for manual-close migration");

    resolveMigration();
    await client.waitFor((message) => message.type === "state" && message.activeLot === null, { timeoutMs: 6000 });
    assert.equal(wishlistCalls.length, 1);
  } finally {
    resolveFirstOrder({ id: "co-first", positionId: "pos-first" });
    resolveMigration();
    await client.close();
    await harness.close();
  }
});
