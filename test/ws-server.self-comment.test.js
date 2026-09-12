import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createVkMock } from "./helpers/ws-harness.js";

// Регрессия: бот публикует ответы («бронь подтверждена (код …)») и они не
// должны переисследоваться как новые брони. Иначе — ложный out_of_stock,
// мусор в wishlist, а при остатке ≥2 фантомный заказ в МойСкладе. См.
// лог-ревью 2026-06-03 (аккаунт «Amber Standard» бронировал каждый лот сам у
// себя). С 13.09.2026 бот пишет ОТ ИМЕНИ СООБЩЕСТВА, то есть с отрицательным
// from_id, и фильтр стоит в vk.js на разборе события.

const CARD_03204 = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};

// id сообщества: именно от него теперь уходят все наши комментарии.
const SELF_ID = -183296442;

const hasReservedFrom = (viewerId) => (m) =>
  m.type === "state"
  && Array.isArray(m.activeLot?.reservations?.events)
  && m.activeLot.reservations.events.some(
    (e) => e.viewerId === viewerId
      && (e.status === "reserved" || e.status === "reserved_appended"),
  );

test("poller ignores the bot's own comments (no self-reservation)", async () => {
  const vk = createVkMock();
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
