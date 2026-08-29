import test from "node:test";
import assert from "node:assert/strict";

import { createMoySkladClient } from "../server/moysklad.js";

const BASE = "https://example.test/api/remap/1.2/";

function response(payload) {
  return { ok: true, status: 200, async json() { return payload; } };
}

// remainingPositions — сколько позиций осталось в заказе после удаления.
function stubFetch(calls, { remainingPositions = 0, positionsLookupFails = false } = {}) {
  return async (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const path = url.pathname;
    calls.push({ method: init?.method || "GET", path });

    if (init?.method === "DELETE") return { ok: true, status: 200, async json() { return {}; } };
    if (path.endsWith("/positions")) {
      if (positionsLookupFails) return { ok: false, status: 500, async json() { return {}; } };
      return response({ meta: { size: remainingPositions }, rows: [] });
    }
    throw new Error(`unexpected request: ${init?.method} ${path}`);
  };
}

async function removePosition(options) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(calls, options);
  try {
    const moysklad = createMoySkladClient({
      baseUrl: BASE, login: "u", password: "p", getRetryAttempts: 1, getRetryBaseDelayMs: 1,
    });
    const result = await moysklad.removePositionFromOrder({ orderId: "co-1", positionId: "pos-1" });
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("последняя позиция снята — заказ удаляется целиком", async () => {
  const { result, calls } = await removePosition({ remainingPositions: 0 });

  assert.equal(result.orderDeleted, true);
  const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.path);
  assert.equal(deletes.length, 2, "позиция и сам заказ");
  assert.ok(deletes[1].endsWith("/entity/customerorder/co-1"), `получили: ${deletes[1]}`);
});

test("в заказе остались другие позиции — заказ не трогаем", async () => {
  const { result, calls } = await removePosition({ remainingPositions: 2 });

  assert.equal(result.orderDeleted, false);
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1, "только позиция");
});

test("проверка позиций не удалась — заказ не удаляем", async () => {
  const { result, calls } = await removePosition({ positionsLookupFails: true });

  assert.equal(result.orderDeleted, false, "неизвестно, пуст ли заказ — значит не трогаем");
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
});
