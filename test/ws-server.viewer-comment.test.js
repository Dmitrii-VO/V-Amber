import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createVkMock } from "./helpers/ws-harness.js";

// Лента «Комментарии зала»: КАЖДЫЙ незаблокированный комментарий зрителя —
// не только «бронь» — уходит оператору событием `viewerComment`, чтобы Роман
// читал зал на ноутбуке (телефон занят как камера). Эмит стоит сразу после
// фильтра блокировок в ingestViewerComment, до парсинга броней.

const CARD_03204 = {
  id: "p-03204", name: "Серьги янтарь", code: "03204",
  pathName: "Украшения/Серьги", salePrice: 4500, availableStock: 7,
};

const BUYER_ID = 5001;
const SPAMMER_ID = 7777;

function createBlockedStoreStub(blockedIds) {
  const blocked = new Set(blockedIds.map(String));
  return {
    isBlocked: (viewerId) => blocked.has(String(viewerId)),
    get: (viewerId) => (blocked.has(String(viewerId)) ? { viewerId, name: "Спамер" } : null),
  };
}

test("обычный (не «бронь») комментарий уходит оператору как viewerComment", async () => {
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

    vk.pushComment({ id: 401, fromId: BUYER_ID, text: "Красивые серьги! Сколько стоят?", firstName: "Аня" });

    const feed = await client.waitFor(
      (m) => m.type === "viewerComment" && m.commentId === 401,
      { timeoutMs: 6000 },
    );
    assert.equal(feed.viewerId, BUYER_ID);
    assert.equal(feed.viewerName, "Аня");
    assert.equal(feed.text, "Красивые серьги! Сколько стоят?");
    assert.equal(feed.source, "vk");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("заблокированный зритель не попадает в ленту viewerComment", async () => {
  const vk = createVkMock();
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
    vk,
    blockedViewersStore: createBlockedStoreStub([SPAMMER_ID]),
  });
  const client = await harness.connect();
  try {
    client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
    await harness.waitForSession();
    client.send({ type: "manualCode", code: "03204" });
    await client.waitFor((m) => m.type === "state" && m.activeLot);

    vk.pushComment({ id: 411, fromId: SPAMMER_ID, text: "ЗАРАБОТОК В ИНТЕРНЕТЕ", firstName: "Спамер" });
    // Живой зритель следом — служит барьером: дождавшись его viewerComment,
    // мы уверены, что спамерский (более ранний) точно не придёт позже.
    vk.pushComment({ id: 412, fromId: BUYER_ID, text: "а браслет есть?", firstName: "Оля" });

    await client.waitFor((m) => m.type === "viewerComment" && m.commentId === 412, { timeoutMs: 6000 });

    const fromSpammer = client.messages.filter(
      (m) => m.type === "viewerComment" && m.viewerId === SPAMMER_ID,
    );
    assert.equal(fromSpammer.length, 0, "комментарий спамера не должен попадать в ленту");
  } finally {
    await client.close();
    await harness.close();
  }
});
