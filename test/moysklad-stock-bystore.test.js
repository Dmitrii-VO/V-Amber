import test from "node:test";
import assert from "node:assert/strict";

import { createMoySkladClient } from "../server/moysklad.js";

const BASE = "https://example.test/api/remap/1.2/";
const MAIN_STORE = `${BASE}entity/store/main`;
const BRAK_STORE = `${BASE}entity/store/brak`;

function response(payload) {
  return { ok: true, status: 200, async json() { return payload; } };
}

// Отвечает на все запросы карточки товара. stockByStore задаётся тестом,
// null → report/stock/bystore падает (остаток честно неизвестен).
function stubFetch(stockByStore, { byStoreFails = false } = {}) {
  return async (input) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const path = url.pathname;
    if (path.endsWith("/entity/organization")) return response({ rows: [{ id: "org" }] });
    if (path.endsWith("/entity/store")) {
      return response({
        rows: [
          { id: "main", name: "Основной склад", meta: { href: MAIN_STORE } },
          { id: "brak", name: "Брак(на ремонт)", meta: { href: BRAK_STORE } },
        ],
      });
    }
    if (path.endsWith("/entity/customerorder/metadata")) return response({ states: [] });
    if (path.endsWith("/entity/product")) {
      return response({
        rows: [{ id: "p1", code: "03878", name: "Серьги", meta: { href: `${BASE}entity/product/p1` } }],
      });
    }
    if (path.endsWith("/report/stock/all")) {
      // Ровно тот случай из эфира 2026-08-29: агрегат молчит.
      return response({ rows: [] });
    }
    if (path.endsWith("/report/stock/bystore")) {
      if (byStoreFails) return { ok: false, status: 500, async json() { return {}; } };
      return response({ rows: [{ stockByStore }] });
    }
    throw new Error(`unexpected request: ${path}`);
  };
}

async function loadCard(stockByStore, options) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(stockByStore, options);
  try {
    const moysklad = createMoySkladClient({
      baseUrl: BASE,
      login: "u",
      password: "p",
      excludedStoreNames: ["Брак"],
      getRetryAttempts: 1,
      getRetryBaseDelayMs: 1,
    });
    return await moysklad.getProductCardByCode("03878");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("остаток берётся из bystore, когда агрегат вернул пустой ответ", async () => {
  const card = await loadCard([
    { name: "Основной склад", stock: 1, reserve: 1, meta: { href: MAIN_STORE } },
  ]);
  assert.equal(card.availableStock, 0, "1 в наличии, 1 в резерве чужого заказа → продавать нечего");
  assert.equal(card.excludedStoreStock, 0);
});

test("склад брака не попадает в продаваемый остаток даже при неточном имени", async () => {
  const card = await loadCard([
    { name: "Основной склад", stock: 0, reserve: 0, meta: { href: MAIN_STORE } },
    { name: "Брак(на ремонт)", stock: 2, reserve: 0, meta: { href: BRAK_STORE } },
  ]);
  assert.equal(card.availableStock, 0, "«Брак» в списке исключений должен покрывать «Брак(на ремонт)»");
  assert.equal(card.excludedStoreStock, 2, "но знать про него надо — из него делается перемещение");
});

test("товара нет ни на одном складе — это ноль, а не «неизвестно»", async () => {
  const card = await loadCard([]);
  assert.equal(card.availableStock, 0);
});

test("bystore недоступен — остаток остаётся неизвестным, а не нулём", async () => {
  const card = await loadCard([], { byStoreFails: true });
  assert.equal(card.availableStock, null, "иначе оператор потеряет бронь на товар, который держит в руках");
});
