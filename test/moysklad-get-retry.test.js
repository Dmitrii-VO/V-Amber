import test from "node:test";
import assert from "node:assert/strict";

import { createMoySkladClient } from "../server/moysklad.js";

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test("MoySklad GET retries a 429 before returning product codes", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? new URL(input) : input;
    calls.push(url);
    if (calls.length === 1) {
      return response(429, {});
    }
    return response(200, {
      meta: { size: 1 },
      rows: [{ code: "00243", archived: false }],
    });
  };

  const emitted = [];
  try {
    const moysklad = createMoySkladClient({
      baseUrl: "https://example.test/api/remap/1.2/",
      login: "user",
      password: "pass",
      getRetryBaseDelayMs: 1,
      getRetryAttempts: 2,
    }, { onCall: (event) => emitted.push(event) });

    const codes = await moysklad.getProductCodes();
    assert.deepEqual(codes, ["00243"]);
    assert.equal(calls.length, 2);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].ok, true);
    assert.equal(emitted[0].attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MoySklad does not retry POST writes on 429", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? new URL(input) : input;
    calls.push(url);
    if (url.pathname.endsWith("/entity/organization")) {
      return response(200, { rows: [{ id: "org-1" }] });
    }
    if (url.pathname.endsWith("/entity/store")) {
      return response(200, { rows: [{ id: "store-1", name: "Основной" }] });
    }
    if (url.pathname.endsWith("/entity/customerorder")) {
      return response(429, {});
    }
    return response(200, { rows: [] });
  };

  try {
    const moysklad = createMoySkladClient({
      baseUrl: "https://example.test/api/remap/1.2/",
      login: "user",
      password: "pass",
      getRetryBaseDelayMs: 1,
      getRetryAttempts: 2,
    });

    await assert.rejects(
      () => moysklad.createCustomerOrderReservation({
        activeLot: { code: "00243", lotSessionId: "lot-1", product: { id: "prod-1" } },
        productCard: { id: "prod-1", salePrice: 1000 },
        reservation: { viewerId: 42, viewerName: "Аня", commentId: 10, quantity: 1 },
        counterparty: { id: "cp-1" },
        broadcastDate: "2026-06-08",
      }),
      /MoySklad HTTP 429/,
    );
    const writeCalls = calls.filter((url) => url.pathname.endsWith("/entity/customerorder"));
    assert.equal(writeCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
