import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, createVkMock } from "./helpers/ws-harness.js";

// Лот должен открываться, НЕ дожидаясь публикации карточки в ВК.
//
// Замер по логам шести эфиров (43 session-jsonl, 525 открытий): медиана
// «финал с кодом → lot_opened» 1.8 с, p90 7.7 с, при том что вызовы МойСклада
// в этом окне занимают 150–500 мс. Остальное съедало ожидание vk.publishLotCard,
// которое стояло на критическом пути. Эти тесты держат порядок: сначала лот
// оператору, потом карточка покупателям.

const CARD = {
  id: "p-03204",
  name: "Серьги янтарь",
  code: "03204",
  pathName: "Украшения/Серьги",
  salePrice: 4500,
  availableStock: 7,
};

// Публикация, которую тест держит открытой сколько нужно.
function createDeferredPublication() {
  let release;
  const started = [];
  const promise = new Promise((resolve) => { release = resolve; });
  return {
    started,
    release: (value = { comment_id: 777 }) => release(value),
    publishLotCard: async () => {
      started.push(Date.now());
      return promise;
    },
  };
}

async function openLot(client, harness, text = "код товара 03204") {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  const session = await harness.waitForSession();
  session.handlers.onFinal({ text, latencyMs: 10 });
  return client.waitFor((m) => m.type === "state" && m.activeLot);
}

test("лот открывается до того, как ВК ответил на публикацию карточки", async () => {
  const deferred = createDeferredPublication();
  const harness = await startHarness({
    cardsByCode: { "03204": CARD },
    knownCodes: ["03204"],
    vk: createVkMock({ publishLotCard: deferred.publishLotCard }),
  });
  const client = await harness.connect();
  try {
    // Публикация ещё висит — состояние с активным лотом обязано прийти.
    const state = await openLot(client, harness);

    assert.equal(state.activeLot.code, "03204");
    assert.equal(deferred.started.length, 1, "публикация должна быть запущена, а не отложена");
    assert.equal(
      state.activeLot.vkPublication ?? null,
      null,
      "commentId ещё неизвестен — лот открыт без него",
    );

    // Отпускаем ВК: commentId прикрепляется вторым состоянием.
    deferred.release({ comment_id: 777 });
    const withPublication = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.vkPublication?.commentId === 777,
    );
    assert.equal(withPublication.activeLot.code, "03204");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("упавшая публикация не мешает лоту открыться", async () => {
  const harness = await startHarness({
    cardsByCode: { "03204": CARD },
    knownCodes: ["03204"],
    vk: createVkMock({
      publishLotCard: async () => {
        throw new Error("VK недоступен");
      },
    }),
  });
  const client = await harness.connect();
  try {
    const state = await openLot(client, harness);
    assert.equal(state.activeLot.code, "03204", "лот нужен оператору даже без карточки");
    assert.equal(state.activeLot.vkPublication ?? null, null);
  } finally {
    await client.close();
    await harness.close();
  }
});
