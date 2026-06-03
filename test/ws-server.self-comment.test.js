import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createVkMock } from "./helpers/ws-harness.js";

// Регрессия: бот публикует ответы («бронь подтверждена (код …)») под своим
// VK-аккаунтом, и опрос комментариев не должен переисследовать их как новые
// брони от имени бота. Иначе — ложный out_of_stock, мусор в wishlist, а при
// остатке ≥2 фантомный заказ в МойСкладе. См. лог-ревью 2026-06-03 (сессия
// 22:33, аккаунт «Amber Standard» id 816076245 бронировал каждый лот сам у
// себя). Фильтр по comment.from_id === selfUserId в ws-server.

const CARD_03204 = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};

const SELF_ID = 816076245;

const hasReservedFrom = (viewerId) => (m) =>
  m.type === "state"
  && Array.isArray(m.activeLot?.reservations?.events)
  && m.activeLot.reservations.events.some(
    (e) => e.viewerId === viewerId
      && (e.status === "reserved" || e.status === "reserved_appended"),
  );

test("poller ignores the bot's own comments (no self-reservation)", async () => {
  const vk = createVkMock({ selfUserId: SELF_ID });
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
    vk,
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot);

    // Собственное подтверждение бота — содержит «бронь» и «код 03204», т.е.
    // без фильтра распозналось бы как бронь от имени бота.
    vk.pushComment({
      id: 201, fromId: SELF_ID,
      text: "Аня, бронь подтверждена (код 03204).",
      firstName: "Amber", lastName: "Standard",
    });
    // Реальный зритель бронирует голым кодом — это должно сработать.
    vk.pushComment({ id: 202, fromId: 5001, text: "03204", firstName: "Аня" });

    const reserved = await client.waitFor(hasReservedFrom(5001), { timeoutMs: 6000 });
    const events = reserved.activeLot.reservations.events;

    assert.ok(
      !events.some((e) => e.viewerId === SELF_ID),
      "комментарий бота не должен создавать бронь",
    );
    assert.equal(reserved.activeLot.reservations.committedReservationCount, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});
