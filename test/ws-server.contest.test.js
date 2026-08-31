import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/ws-harness.js";

// Конкурс ставит торги на паузу целиком. Это и есть его смысл: 29.08.2026
// стихийный розыгрыш выдал 434 числа за десять минут, каждое из них V-Amber
// разбирал как возможную бронь, и ВК ушёл в rate limit при живом лоте.

const CARD = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};

const liveEvents = (m) => (m.activeLot?.reservations?.events || [])
  .filter((e) => e.status === "reserved" || e.status === "reserved_appended");

async function openLot(harness, client) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code: "03204" });
  await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");
}

test("во время конкурса комментарий с кодом лота не создаёт бронь", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);

    client.send({ type: "contestStart" });
    const started = await client.waitFor((m) => m.type === "contest" && m.active, { timeoutMs: 6000 });
    assert.ok(started.number >= 100 && started.number <= 999, `ожидали трёхзначное, получили ${started.number}`);

    // Ровно тот комментарий, который в обычное время создал бы бронь.
    harness.vk.pushComment({ id: 900, fromId: 5001, text: "03204", firstName: "Марина" });
    const attempt = await client.waitFor((m) => m.type === "contest" && m.attempts === 1, { timeoutMs: 6000 });
    assert.equal(attempt.active, true, "конкурс продолжается: код лота — не то число");

    // Лента зала во время конкурса не должна пропадать: оператор смотрит на
    // дашборд именно в этот момент.
    assert.ok(
      client.messages.some((m) => m.type === "viewerComment" && m.commentId === 900),
      "комментарий должен дойти до оператора",
    );

    // Бронь не создаётся: ждём достаточно, чтобы обычный путь успел сходить
    // в МойСклад, будь он не заблокирован.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("угаданное число завершает конкурс и снимает торги с паузы", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);

    client.send({ type: "contestStart" });
    const started = await client.waitFor((m) => m.type === "contest" && m.active, { timeoutMs: 6000 });

    harness.vk.pushComment({ id: 901, fromId: 5002, text: String(started.number), firstName: "Оля" });
    const won = await client.waitFor((m) => m.type === "contest" && m.winner, { timeoutMs: 6000 });

    assert.equal(won.winner.viewerId, 5002);
    assert.equal(won.winner.number, started.number);
    assert.equal(won.active, false, "конкурс закончился — торги идут дальше");

    // Приз в МойСклад не пишется: фиксируется только имя победителя.
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);

    // И после конкурса бронь снова работает.
    harness.vk.pushComment({ id: 902, fromId: 5001, text: "03204", firstName: "Марина" });
    const reserved = await client.waitFor((m) => m.type === "state" && liveEvents(m).length > 0, { timeoutMs: 6000 });
    assert.equal(liveEvents(reserved)[0].viewerId, 5001);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("кнопка «стоп» завершает конкурс без победителя", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);

    client.send({ type: "contestStart" });
    await client.waitFor((m) => m.type === "contest" && m.active, { timeoutMs: 6000 });

    client.send({ type: "contestStop" });
    const stopped = await client.waitFor((m) => m.type === "contest" && m.stopped, { timeoutMs: 6000 });
    assert.equal(stopped.active, false);

    // Оператор всегда подводит к победе, но эфир не должен зависать, если
    // число так и не назвали.
    harness.vk.pushComment({ id: 903, fromId: 5001, text: "03204", firstName: "Марина" });
    const reserved = await client.waitFor((m) => m.type === "state" && liveEvents(m).length > 0, { timeoutMs: 6000 });
    assert.equal(liveEvents(reserved).length, 1);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("перезагрузка дашборда посреди конкурса не снимает торги с паузы", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);
    client.send({ type: "contestStart" });
    const started = await client.waitFor((m) => m.type === "contest" && m.active, { timeoutMs: 6000 });
    await client.close();

    // Новое соединение — то же, что F5 в браузере оператора. Число он уже
    // назвал вслух; если конкурс тихо кончится, числа зрителей снова поедут
    // в брони — ровно то, ради чего фича делалась.
    const reopened = await harness.connect();
    try {
      const restored = await reopened.waitFor((m) => m.type === "contest", { timeoutMs: 6000 });
      assert.equal(restored.active, true);
      assert.equal(restored.number, started.number, "то же число, а не новое");
    } finally {
      await reopened.close();
    }
  } finally {
    await harness.close();
  }
});

// Эфир 30.08.2026: оператор дважды нажал «старт» между лотами и оба раза
// получил attempts=0 — поллеры комментариев без открытого лота не крутятся, а
// конкурс как раз и идёт при закрытых торгах. Решил, что кнопка не работает,
// и провёл розыгрыш вручную: 24 числа снова разобрались как брони, ВК ушёл в
// rate limit.
test("конкурс без открытого лота слышит комментарии и объявляет победителя в ВК", async () => {
  const harness = await startHarness({ cardsByCode: { "03204": CARD }, knownCodes: ["03204"] });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();

    client.send({ type: "contestStart" });
    const started = await client.waitFor((m) => m.type === "contest" && m.active, { timeoutMs: 6000 });

    harness.vk.pushComment({ id: 910, fromId: 5003, text: String(started.number), firstName: "Ирина" });
    const won = await client.waitFor((m) => m.type === "contest" && m.winner, { timeoutMs: 10000 });
    assert.equal(won.winner.viewerId, 5003);

    // Зал узнаёт исход только из комментариев: оператор ведёт эфир с телефона.
    const announcements = harness.vk.callsTo("publishViewerInstruction")
      .filter((c) => c.args[1] === "contest_winner");
    assert.equal(announcements.length, 1);
    assert.match(announcements[0].args[0], /Ирина/);
    assert.match(announcements[0].args[0], new RegExp(String(started.number)));
  } finally {
    await client.close();
    await harness.close();
  }
});
