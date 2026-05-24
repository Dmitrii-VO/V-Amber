import test from "node:test";
import assert from "node:assert/strict";

import { createMoySkladClient } from "../server/moysklad.js";

const baseConfig = {
  baseUrl: "https://moysklad.test/api/remap/1.2/",
  login: "user",
  password: "pass",
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function pathFromUrl(url) {
  return new URL(String(url)).pathname.replace(/^\/api\/remap\/1\.2\//, "");
}

function createFetchMock(handler) {
  const calls = [];
  const mock = async (url) => {
    const parsed = new URL(String(url));
    const path = pathFromUrl(url);
    calls.push({ path, searchParams: parsed.searchParams });
    return handler(path, parsed.searchParams);
  };
  mock.calls = calls;
  return mock;
}

function installFetchMock(mock) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function defaultsResponse(path) {
  if (path === "entity/organization") return jsonResponse({ rows: [{ id: "org-1", name: "Org" }] });
  if (path === "entity/store") return jsonResponse({ rows: [{ id: "store-1", name: "Store" }] });
  if (path === "entity/customerorder/metadata") {
    return jsonResponse({
      states: [{
        id: "state-new",
        name: "Новый",
        meta: { href: "https://moysklad.test/api/remap/1.2/entity/customerorder/metadata/states/state-new" },
      }],
    });
  }
  return null;
}

test("checkOpenOrderPositionsForEntries loads open order positions once for one customer", async () => {
  const productId1 = "11111111-1111-1111-1111-111111111111";
  const productId2 = "22222222-2222-2222-2222-222222222222";
  const fetchMock = createFetchMock((path, searchParams) => {
    const defaults = defaultsResponse(path);
    if (defaults) return defaults;
    if (path === "entity/counterparty/metadata/attributes") {
      return jsonResponse({ rows: [{ id: "vk-attr", name: "VK ID" }] });
    }
    if (path === "entity/counterparty" && searchParams.has("filter")) {
      return jsonResponse({ rows: [{ id: "cp-1", name: "VK: Анна" }] });
    }
    if (path === "entity/customerorder") {
      return jsonResponse({ rows: [{ id: "co-1", name: "00001" }] });
    }
    if (path === "entity/customerorder/co-1/positions") {
      return jsonResponse({
        rows: [
          { assortment: { meta: { href: `https://moysklad.test/api/remap/1.2/entity/product/${productId1}` } } },
          { assortment: { meta: { href: "https://moysklad.test/api/remap/1.2/entity/product/33333333-3333-3333-3333-333333333333" } } },
        ],
      });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.checkOpenOrderPositionsForEntries([
      { entryId: "e-1", viewerId: "101", viewerName: "Анна", productId: productId1 },
      { entryId: "e-2", viewerId: "101", viewerName: "Анна", productId: productId2 },
    ], { source: "test" });

    assert.deepEqual(result, {
      "e-1": { inOpenOrder: true, orderId: "co-1", orderName: "00001" },
      "e-2": { inOpenOrder: false },
    });
    assert.equal(fetchMock.calls.filter((call) => call.path === "entity/customerorder").length, 1);
    assert.equal(fetchMock.calls.filter((call) => call.path === "entity/customerorder/co-1/positions").length, 1);
  } finally {
    restore();
  }
});

test("checkOpenOrderPositionsForEntries does one open-order lookup per customer", async () => {
  const fetchMock = createFetchMock((path, searchParams) => {
    const defaults = defaultsResponse(path);
    if (defaults) return defaults;
    if (path === "entity/counterparty/metadata/attributes") {
      return jsonResponse({ rows: [{ id: "vk-attr", name: "VK ID" }] });
    }
    if (path === "entity/counterparty" && searchParams.has("filter")) {
      const filter = searchParams.get("filter") || "";
      if (filter.endsWith("=101")) return jsonResponse({ rows: [{ id: "cp-1", name: "VK: 101" }] });
      if (filter.endsWith("=202")) return jsonResponse({ rows: [{ id: "cp-2", name: "VK: 202" }] });
    }
    if (path === "entity/customerorder") {
      const filter = searchParams.get("filter") || "";
      const id = filter.includes("/counterparty/cp-1") ? "co-1" : "co-2";
      return jsonResponse({ rows: [{ id, name: id }] });
    }
    if (path === "entity/customerorder/co-1/positions") {
      return jsonResponse({ rows: [{ assortment: { id: "p-1" } }] });
    }
    if (path === "entity/customerorder/co-2/positions") {
      return jsonResponse({ rows: [{ assortment: { id: "p-2" } }] });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.checkOpenOrderPositionsForEntries([
      { entryId: "e-1", viewerId: "101", productId: "p-1" },
      { entryId: "e-2", viewerId: "101", productId: "p-x" },
      { entryId: "e-3", viewerId: "202", productId: "p-2" },
    ]);

    assert.equal(result["e-1"].inOpenOrder, true);
    assert.equal(result["e-2"].inOpenOrder, false);
    assert.equal(result["e-3"].inOpenOrder, true);
    assert.equal(fetchMock.calls.filter((call) => call.path === "entity/customerorder").length, 2);
  } finally {
    restore();
  }
});

test("checkOpenOrderPositionsForEntries returns false when counterparty is missing", async () => {
  const fetchMock = createFetchMock((path) => {
    if (path === "entity/counterparty/metadata/attributes") {
      return jsonResponse({ rows: [{ id: "vk-attr", name: "VK ID" }] });
    }
    if (path === "entity/counterparty") return jsonResponse({ rows: [] });
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.checkOpenOrderPositionsForEntries([
      { entryId: "e-1", viewerId: "101", productId: "p-1" },
      { entryId: "e-2", viewerId: "101", productId: "p-2" },
    ]);

    assert.deepEqual(result, {
      "e-1": { inOpenOrder: false },
      "e-2": { inOpenOrder: false },
    });
    assert.equal(fetchMock.calls.some((call) => call.path === "entity/customerorder"), false);
  } finally {
    restore();
  }
});

test("checkOpenOrderPositionsForEntries reports lookup_failed per entry on lookup error", async () => {
  const fetchMock = createFetchMock((path) => {
    if (path === "entity/counterparty/metadata/attributes") {
      return jsonResponse({ rows: [{ id: "vk-attr", name: "VK ID" }] });
    }
    if (path === "entity/counterparty") return jsonResponse({}, 500);
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.checkOpenOrderPositionsForEntries([
      { entryId: "e-1", viewerId: "101", productId: "p-1" },
      { entryId: "e-2", viewerId: "101", productId: "p-2" },
    ]);

    assert.deepEqual(result, {
      "e-1": { inOpenOrder: false, error: "lookup_failed" },
      "e-2": { inOpenOrder: false, error: "lookup_failed" },
    });
  } finally {
    restore();
  }
});
