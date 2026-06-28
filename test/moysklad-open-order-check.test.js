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
  const mock = async (url, init) => {
    const parsed = new URL(String(url));
    const path = pathFromUrl(url);
    calls.push({ path, searchParams: parsed.searchParams, init });
    return handler(path, parsed.searchParams, init);
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

test("findBroadcastCustomerOrderForCounterparty ignores open orders without today's marker", async () => {
  const fetchMock = createFetchMock((path) => {
    const defaults = defaultsResponse(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      return jsonResponse({
        rows: [
          { id: "old-open", name: "VK00001", description: "Regular unpaid order" },
          { id: "today-live", name: "VK00002", description: "#Эфир 2026-05-24\nVK reservation" },
          { id: "yesterday-live", name: "VK00003", description: "#Эфир 2026-05-23\nVK reservation" },
        ],
      });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.findBroadcastCustomerOrderForCounterparty("cp-1", {
      broadcastDate: "2026-05-24",
    });

    assert.deepEqual(result, {
      id: "today-live",
      name: "VK00002",
      counterpartyId: "cp-1",
      broadcastDate: "2026-05-24",
    });
    const lookup = fetchMock.calls.find((call) => call.path === "entity/customerorder");
    assert.equal(lookup.searchParams.get("limit"), "100");
  } finally {
    restore();
  }
});

test("findBroadcastCustomerOrderForCounterparty returns null when only old open order exists", async () => {
  const fetchMock = createFetchMock((path) => {
    const defaults = defaultsResponse(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      return jsonResponse({ rows: [{ id: "old-open", name: "VK00001", description: "Regular unpaid order" }] });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.findBroadcastCustomerOrderForCounterparty("cp-1", {
      broadcastDate: "2026-05-24",
    });

    assert.equal(result, null);
  } finally {
    restore();
  }
});

test("createCustomerOrderReservation writes daily broadcast marker", async () => {
  let createdPayload = null;
  const fetchMock = createFetchMock((path, searchParams, init) => {
    const defaults = defaultsResponse(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      createdPayload = JSON.parse(init.body);
      return jsonResponse({ id: "co-new", name: "VK00004" });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.createCustomerOrderReservation({
      activeLot: {
        code: "03230",
        lotSessionId: "lot-1",
        product: { id: "product-1", salePrice: 2860 },
      },
      productCard: { salePrice: 2860 },
      reservation: { viewerId: 123, viewerName: "Елена", commentId: 456 },
      counterparty: { id: "cp-1" },
      broadcastDate: "2026-05-24",
    });

    assert.equal(result.id, "co-new");
    assert.match(createdPayload.description, /^#Эфир 2026-05-24\n/);
  } finally {
    restore();
  }
});

test("findBroadcastCustomerOrderForCounterparty excludes paid orders from append lookup", async () => {
  let lookupParams = null;
  const fetchMock = createFetchMock((path, searchParams) => {
    const defaults = defaultsResponseFull(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      lookupParams = searchParams;
      return jsonResponse({
        rows: [{
          id: "co-paid",
          name: "VK-paid",
          description: "#Эфир 2026-05-24\nVK reservation",
          state: { name: "Оплачен" },
        }],
      });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.findBroadcastCustomerOrderForCounterparty("cp-1", {
      broadcastDate: "2026-05-24",
    });

    assert.equal(result, null);
    const filter = lookupParams.get("filter");
    assert.match(filter, /state!=.*states\/state-3(?:;|$)/, "Оплачен должен быть исключён из append lookup");
    assert.match(filter, /state!=.*states\/state-5(?:;|$)/, "Запакован должен быть исключён из append lookup");
  } finally {
    restore();
  }
});

test("findBroadcastCustomerOrderForCounterparty searches beyond first page (date-scoped, legacy)", async () => {
  const fetchMock = createFetchMock((path, searchParams) => {
    const defaults = defaultsResponseFull(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      const offset = Number(searchParams.get("offset") || 0);
      if (offset === 0) {
        return jsonResponse({
          meta: { size: 101 },
          rows: Array.from({ length: 100 }, (_, index) => ({
            id: `co-old-${index}`,
            name: `VK-old-${index}`,
            description: "#Эфир 2026-05-23\nVK reservation",
            state: { name: "Новый" },
          })),
        });
      }
      return jsonResponse({
        meta: { size: 101 },
        rows: [{
          id: "co-current",
          name: "VK-current",
          description: "#Эфир 2026-05-24\nVK reservation",
          state: { name: "Новый" },
        }],
      });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    // Pagination to find TODAY's marker only matters in the legacy date-scoped
    // mode; campaign mode reuses the latest open #Эфир order from page 1.
    const client = createMoySkladClient({ ...baseConfig, crossDayOrderMerge: false });
    const result = await client.findBroadcastCustomerOrderForCounterparty("cp-1", {
      broadcastDate: "2026-05-24",
    });

    assert.equal(result.id, "co-current");
    assert.deepEqual(
      fetchMock.calls
        .filter((call) => call.path === "entity/customerorder")
        .map((call) => call.searchParams.get("offset")),
      ["0", "100"],
    );
  } finally {
    restore();
  }
});

test("findBroadcastCustomerOrderForCounterparty reuses a prior-day #Эфир order across campaign days (default on)", async () => {
  // Multi-day эфир: buyer has only YESTERDAY's open #Эфир order, none for today.
  // crossDayOrderMerge is on by default → reuse it so the campaign accumulates
  // into one order per buyer.
  const fetchMock = createFetchMock((path) => {
    const defaults = defaultsResponse(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      return jsonResponse({
        rows: [{ id: "yesterday-live", name: "VK00003", description: "#Эфир 2026-05-23\nVK reservation" }],
      });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.findBroadcastCustomerOrderForCounterparty("cp-1", { broadcastDate: "2026-05-24" });
    assert.equal(result?.id, "yesterday-live");
  } finally {
    restore();
  }
});

test("findBroadcastCustomerOrderForCounterparty does NOT reuse an order older than the campaign window", async () => {
  // A week-old open #Эфир order is a different campaign (gap 7 > default 3) →
  // start a fresh order instead of appending to stale one.
  const fetchMock = createFetchMock((path) => {
    const defaults = defaultsResponse(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      return jsonResponse({ rows: [{ id: "stale", name: "VK00099", description: "#Эфир 2026-05-17\nVK reservation" }] });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.findBroadcastCustomerOrderForCounterparty("cp-1", { broadcastDate: "2026-05-24" });
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test("findBroadcastCustomerOrderForCounterparty reuses an order at the campaign-window boundary", async () => {
  // Gap of exactly 3 days is inclusive (default maxGapDays=3) → still merge.
  const fetchMock = createFetchMock((path) => {
    const defaults = defaultsResponse(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      return jsonResponse({ rows: [{ id: "recent", name: "VK00100", description: "#Эфир 2026-05-21\nVK reservation" }] });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.findBroadcastCustomerOrderForCounterparty("cp-1", { broadcastDate: "2026-05-24" });
    assert.equal(result?.id, "recent");
  } finally {
    restore();
  }
});

test("findBroadcastCustomerOrderForCounterparty stays date-scoped when crossDayOrderMerge is off", async () => {
  // Legacy behaviour: with the flag disabled, a prior-day order is NOT reused —
  // only an order carrying today's marker counts, so this returns null.
  const fetchMock = createFetchMock((path) => {
    const defaults = defaultsResponse(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      return jsonResponse({
        rows: [{ id: "yesterday-live", name: "VK00003", description: "#Эфир 2026-05-23\nVK reservation" }],
      });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient({ ...baseConfig, crossDayOrderMerge: false });
    const result = await client.findBroadcastCustomerOrderForCounterparty("cp-1", { broadcastDate: "2026-05-24" });
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test("findBroadcastCustomerOrderForCounterparty does not reuse a non-эфир open order (campaign mode)", async () => {
  // Safety: campaign merge must target эфир orders only, never hijack an
  // unrelated manual open order without any #Эфир marker.
  const fetchMock = createFetchMock((path) => {
    const defaults = defaultsResponse(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      return jsonResponse({ rows: [{ id: "manual-open", name: "VK00010", description: "Ручной заказ по телефону" }] });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.findBroadcastCustomerOrderForCounterparty("cp-1", { broadcastDate: "2026-05-24" });
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test("createCustomerOrderReservation sends discount separately from original price", async () => {
  let createdPayload = null;
  const fetchMock = createFetchMock((path, searchParams, init) => {
    const defaults = defaultsResponse(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      createdPayload = JSON.parse(init.body);
      return jsonResponse({ id: "co-new", name: "VK00004" });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    await client.createCustomerOrderReservation({
      activeLot: {
        code: "03359",
        lotSessionId: "lot-1",
        discountAmount: 205,
        product: { id: "product-1", salePrice: 2050 },
      },
      productCard: { salePrice: 2050 },
      reservation: { viewerId: 123, viewerName: "Елена", commentId: 456 },
      counterparty: { id: "cp-1" },
      broadcastDate: "2026-05-24",
    });

    const position = createdPayload.positions[0];
    assert.equal(position.price, 205000);
    assert.equal(position.discount, 10);
    assert.equal(Object.hasOwn(position, "sum"), false);
  } finally {
    restore();
  }
});

test("appendPositionToCustomerOrder sends discount separately from original price", async () => {
  let appendedPayload = null;
  const fetchMock = createFetchMock((path, searchParams, init) => {
    if (path === "entity/customerorder/co-existing") {
      return jsonResponse({ id: "co-existing", description: "#Эфир 2026-05-24" });
    }
    if (path === "entity/customerorder/co-existing/positions") {
      appendedPayload = JSON.parse(init.body);
      return jsonResponse([{ id: "pos-1" }]);
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    await client.appendPositionToCustomerOrder({
      orderId: "co-existing",
      activeLot: {
        code: "03359",
        lotSessionId: "lot-1",
        discountAmount: 205,
        product: { id: "product-1", salePrice: 2050 },
      },
      productCard: { salePrice: 2050 },
      reservation: { viewerId: 123, viewerName: "Елена", commentId: 456 },
      broadcastDate: "2026-05-24",
    });

    const position = appendedPayload[0];
    assert.equal(position.price, 205000);
    assert.equal(position.discount, 10);
    assert.equal(Object.hasOwn(position, "sum"), false);
  } finally {
    restore();
  }
});

test("isCustomerOrderAppendable rejects paid orders", async () => {
  const fetchMock = createFetchMock((path) => {
    const defaults = defaultsResponseFull(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder/co-paid") {
      return jsonResponse({ id: "co-paid", state: { name: "Оплачен" } });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const appendable = await client.isCustomerOrderAppendable("co-paid");
    assert.equal(appendable, false);
  } finally {
    restore();
  }
});

test("ensureCounterparty skips same-name counterparty with another VK ID", async () => {
  let createdPayload = null;
  const fetchMock = createFetchMock((path, searchParams, init = {}) => {
    if (path === "entity/counterparty/metadata/attributes") {
      return jsonResponse({ rows: [{ id: "vk-attr", name: "VK ID" }] });
    }
    if (path === "entity/counterparty" && init.method === "POST") {
      createdPayload = JSON.parse(init.body);
      return jsonResponse({ id: "cp-new", name: createdPayload.name });
    }
    if (path === "entity/counterparty" && searchParams.has("filter")) {
      return jsonResponse({ rows: [] });
    }
    if (path === "entity/counterparty/cp-old") {
      return jsonResponse({
        id: "cp-old",
        name: "VK: Ирина Туржанская",
        attributes: [{ id: "vk-attr", value: "111" }],
      });
    }
    if (path === "entity/counterparty") {
      const search = searchParams.get("search") || "";
      if (search === "VK: Ирина Туржанская") {
        return jsonResponse({
          rows: [{
            id: "cp-old",
            name: "VK: Ирина Туржанская",
          }],
        });
      }
      if (search === "viewerId=222") {
        return jsonResponse({ rows: [] });
      }
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const counterparty = await client.ensureCounterparty({
      viewerId: 222,
      viewerName: "Ирина Туржанская",
    });

    assert.equal(counterparty.id, "cp-new");
    assert.equal(createdPayload.name, "VK: Ирина Туржанская");
    assert.equal(createdPayload.attributes[0].value, "222");
  } finally {
    restore();
  }
});

test("ensureCounterparty reuses same-name counterparty only after matching VK ID detail", async () => {
  let createCalled = false;
  const fetchMock = createFetchMock((path, searchParams, init = {}) => {
    if (path === "entity/counterparty/metadata/attributes") {
      return jsonResponse({ rows: [{ id: "vk-attr", name: "VK ID" }] });
    }
    if (path === "entity/counterparty" && init.method === "POST") {
      createCalled = true;
      return jsonResponse({ id: "cp-new" });
    }
    if (path === "entity/counterparty" && searchParams.has("filter")) {
      return jsonResponse({ rows: [] });
    }
    if (path === "entity/counterparty/cp-existing") {
      return jsonResponse({
        id: "cp-existing",
        name: "VK: Ирина Туржанская",
        attributes: [{ id: "vk-attr", value: "222" }],
      });
    }
    if (path === "entity/counterparty") {
      const search = searchParams.get("search") || "";
      if (search === "VK: Ирина Туржанская") {
        return jsonResponse({
          rows: [{ id: "cp-existing", name: "VK: Ирина Туржанская" }],
        });
      }
      if (search === "viewerId=222") {
        return jsonResponse({ rows: [] });
      }
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const counterparty = await client.ensureCounterparty({
      viewerId: 222,
      viewerName: "Ирина Туржанская",
    });

    assert.equal(counterparty.id, "cp-existing");
    assert.equal(createCalled, false);
  } finally {
    restore();
  }
});

// Метаданные со ВСЕМИ статусами эфирного цикла. open = дописываем, closed = нет.
function fullStatesMetadata() {
  const hrefBase = "https://moysklad.test/api/remap/1.2/entity/customerorder/metadata/states";
  const names = [
    "Новый", "Собран", "Выставлен счет", "Оплачен", "Копит",
    "Запакован", "Отправлен", "Доставлен", "Отменен", "Заказ проведен",
  ];
  return {
    states: names.map((name, i) => ({
      id: `state-${i}`,
      name,
      meta: { href: `${hrefBase}/state-${i}` },
    })),
  };
}

function defaultsResponseFull(path) {
  if (path === "entity/organization") return jsonResponse({ rows: [{ id: "org-1", name: "Org" }] });
  if (path === "entity/store") return jsonResponse({ rows: [{ id: "store-1", name: "Store" }] });
  if (path === "entity/customerorder/metadata") return jsonResponse(fullStatesMetadata());
  return null;
}

test("findOpenCustomerOrderForCounterparty excludes closed states via state!= filter (day-agnostic)", async () => {
  let lookupParams = null;
  const fetchMock = createFetchMock((path, searchParams) => {
    const defaults = defaultsResponseFull(path);
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      lookupParams = searchParams;
      return jsonResponse({ rows: [{ id: "co-open", name: "VK00009" }] });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.findOpenCustomerOrderForCounterparty("cp-1");

    assert.deepEqual(result, { id: "co-open", name: "VK00009", counterpartyId: "cp-1" });
    // limit 1 + сортировка по свежести: берём самый последний открытый заказ.
    assert.equal(lookupParams.get("limit"), "1");
    assert.equal(lookupParams.get("order"), "moment,desc");
    // Фильтр исключает ровно 4 закрытых статуса и не привязан к дате.
    const filter = lookupParams.get("filter");
    const notEquals = filter.split(";").filter((part) => part.includes("state!="));
    assert.equal(notEquals.length, 4, "должно быть 4 исключения (Запакован/Отправлен/Доставлен/Отменён)");
    for (const closed of ["state-5", "state-6", "state-7", "state-8"]) {
      assert.match(filter, new RegExp(`state!=.*states/${closed}(?:;|$)`));
    }
    // Открытые статусы (Оплачен/Копит/Собран/Заказ проведён) НЕ исключаются.
    assert.doesNotMatch(filter, /states\/state-3(?:;|$)/, "Оплачен не должен быть исключён");
    assert.doesNotMatch(filter, /states\/state-4(?:;|$)/, "Копит не должен быть исключён");
  } finally {
    restore();
  }
});

test("getReservationDigestForDate includes open states beyond Новый and excludes closed", async () => {
  const fetchMock = createFetchMock((path) => {
    const defaults = defaultsResponseFull(path);
    if (defaults) return defaults;
    if (path === "entity/counterparty/metadata/attributes") {
      return jsonResponse({ rows: [{ id: "vk-attr", name: "VK ID" }] });
    }
    if (path === "entity/customerorder") {
      return jsonResponse({
        rows: [
          { id: "o-new", name: "VK01", description: "#Эфир 2026-06-05\nviewerId=101", state: { name: "Новый" }, agent: { name: "Аня" } },
          { id: "o-kopit", name: "VK02", description: "#Эфир 2026-06-05\nviewerId=102", state: { name: "Копит" }, agent: { name: "Оля" } },
          { id: "o-oplachen", name: "VK03", description: "#Эфир 2026-06-05\nviewerId=103", state: { name: "Оплачен" }, agent: { name: "Ира" } },
          { id: "o-packed", name: "VK04", description: "#Эфир 2026-06-05\nviewerId=104", state: { name: "Запакован" }, agent: { name: "Зоя" } },
          { id: "o-sent", name: "VK05", description: "#Эфир 2026-06-05\nviewerId=105", state: { name: "Отправлен" }, agent: { name: "Юля" } },
        ],
      });
    }
    if (/^entity\/customerorder\/.+\/positions$/.test(path)) {
      return jsonResponse({ rows: [{ id: "pos-1", quantity: 1, price: 100000, sum: 100000, assortment: { code: "00001", name: "Товар" } }] });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const digest = await client.getReservationDigestForDate("2026-06-05");

    // Новый/Копит/Оплачен — открыты (3); Запакован/Отправлен — закрыты (исключены).
    assert.equal(digest.count, 3);
    assert.deepEqual(
      digest.clients.map((c) => c.orders[0].stateName).sort(),
      ["Копит", "Новый", "Оплачен"],
    );
  } finally {
    restore();
  }
});

test("findOpenCustomerOrderForCounterparty falls back to Новый-only when closed states cannot be resolved", async () => {
  let lookupParams = null;
  const fetchMock = createFetchMock((path, searchParams) => {
    const defaults = defaultsResponse(path); // только «Новый»
    if (defaults) return defaults;
    if (path === "entity/customerorder") {
      lookupParams = searchParams;
      return jsonResponse({ rows: [{ id: "co-new", name: "VK00001" }] });
    }
    return jsonResponse({ rows: [] });
  });
  const restore = installFetchMock(fetchMock);
  try {
    const client = createMoySkladClient(baseConfig);
    const result = await client.findOpenCustomerOrderForCounterparty("cp-1");

    assert.deepEqual(result, { id: "co-new", name: "VK00001", counterpartyId: "cp-1" });
    const filter = lookupParams.get("filter");
    assert.match(filter, /state=.*states\/state-new/);
    assert.doesNotMatch(filter, /state!=/);
  } finally {
    restore();
  }
});
