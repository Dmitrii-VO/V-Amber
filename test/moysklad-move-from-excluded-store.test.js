import test from "node:test";
import assert from "node:assert/strict";

import { createMoySkladClient } from "../server/moysklad.js";

const BASE = "https://example.test/api/remap/1.2/";
const MAIN_STORE = `${BASE}entity/store/a544473c-dc8f-11ef-0a80-009b002c995c`;
const BRAK_STORE = `${BASE}entity/store/0b82e30e-dfd2-11ef-0a80-0791000e5db4`;

function response(payload) {
  return { ok: true, status: 200, async json() { return payload; } };
}

function stubFetch(posts, { moveFails = false } = {}) {
  return async (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const path = url.pathname;
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(init.body) });
      if (moveFails) return { ok: false, status: 412, async json() { return {}; } };
      return response({ id: "move-1" });
    }
    if (path.endsWith("/entity/organization")) return response({ rows: [{ id: "org", name: "ООО" }] });
    if (path.endsWith("/entity/store")) {
      return response({
        rows: [
          { id: "a544473c-dc8f-11ef-0a80-009b002c995c", name: "Основной склад", meta: { href: MAIN_STORE } },
          { id: "0b82e30e-dfd2-11ef-0a80-0791000e5db4", name: "Брак(на ремонт)", meta: { href: BRAK_STORE } },
        ],
      });
    }
    if (path.endsWith("/entity/customerorder/metadata")) return response({ states: [] });
    throw new Error(`unexpected request: ${path}`);
  };
}

function client() {
  return createMoySkladClient({
    baseUrl: BASE,
    login: "u",
    password: "p",
    excludedStoreNames: ["Брак"],
    getRetryAttempts: 1,
    getRetryBaseDelayMs: 1,
  });
}

async function withFetch(stub, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("переносит ровно одну единицу с брака на основной склад", async () => {
  const posts = [];
  const moved = await withFetch(stubFetch(posts), () => client().moveOneFromExcludedStore({
    productId: "p1",
    sourceStoreHref: BRAK_STORE,
    code: "03878",
  }));

  assert.equal(moved, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path.endsWith("/entity/move"), true);
  const body = posts[0].body;
  assert.equal(body.sourceStore.meta.href.endsWith("/entity/store/0b82e30e-dfd2-11ef-0a80-0791000e5db4"), true);
  assert.equal(body.targetStore.meta.href.endsWith("/entity/store/a544473c-dc8f-11ef-0a80-009b002c995c"), true);
  assert.equal(body.positions.length, 1);
  assert.equal(body.positions[0].quantity, 1, "остальное в браке может быть браком по-настоящему");
  // Непроведённый документ остаток не меняет, а весь смысл переноса в остатке.
  assert.equal(body.applicable, true);
});

test("склад-приёмник не может оказаться складом брака", async () => {
  const posts = [];
  const originalFetch = globalThis.fetch;
  // MOYSKLAD_STORE_ID пуст, а entity/store отдаёт брак ПЕРВЫМ — ровно как в
  // боевом аккаунте. defaults.storeId в этом случае падает на stores[0].
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input;
    if (init?.method === "POST") {
      posts.push(JSON.parse(init.body));
      return response({ id: "move-1" });
    }
    if (url.pathname.endsWith("/entity/organization")) return response({ rows: [{ id: "org" }] });
    if (url.pathname.endsWith("/entity/store")) {
      return response({
        rows: [
          { id: "0b82e30e-dfd2-11ef-0a80-0791000e5db4", name: "Брак(на ремонт)", meta: { href: BRAK_STORE } },
          { id: "a544473c-dc8f-11ef-0a80-009b002c995c", name: "Склад продаж", meta: { href: MAIN_STORE } },
        ],
      });
    }
    if (url.pathname.endsWith("/entity/customerorder/metadata")) return response({ states: [] });
    throw new Error(`unexpected: ${url.pathname}`);
  };
  try {
    const moved = await createMoySkladClient({
      baseUrl: BASE, login: "u", password: "p",
      excludedStoreNames: ["Брак"], getRetryAttempts: 1, getRetryBaseDelayMs: 1,
    }).moveOneFromExcludedStore({ productId: "p1", sourceStoreHref: BRAK_STORE, code: "03878" });

    assert.equal(moved, 1);
    assert.ok(
      posts[0].targetStore.meta.href.endsWith("a544473c-dc8f-11ef-0a80-009b002c995c"),
      "перенос из брака в брак бессмыслен",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("сбой перемещения не роняет вызов — лот всё равно откроется", async () => {
  const posts = [];
  const moved = await withFetch(stubFetch(posts, { moveFails: true }), () => client().moveOneFromExcludedStore({
    productId: "p1",
    sourceStoreHref: BRAK_STORE,
    code: "03878",
  }));

  assert.equal(moved, 0);
});

test("без склада-источника ничего не пишем в учёт", async () => {
  const posts = [];
  const moved = await withFetch(stubFetch(posts), () => client().moveOneFromExcludedStore({
    productId: "p1",
    sourceStoreHref: null,
    code: "03878",
  }));

  assert.equal(moved, 0);
  assert.equal(posts.length, 0);
});
