import { test } from "node:test";
import assert from "node:assert/strict";
import { createMoySkladClient } from "../server/moysklad.js";

// Фоллбэк получения positionId для отмены брони (#16). POST entity/customerorder
// возвращает positions как { meta } без rows, поэтому id первой позиции
// дотягивается отдельным GET. Здесь проверяется именно этот резолвер.

const BASE = "https://api.moysklad.ru/api/remap/1.2";
const CONFIG = { baseUrl: BASE, login: "u", password: "p", organizationId: "org-1", storeId: "store-1" };

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function withMockedFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return (async () => {
    try { return await run(); } finally { globalThis.fetch = originalFetch; }
  })();
}

test("#16: resolveFirstOrderPositionId returns the first position id via GET", async () => {
  await withMockedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/entity/customerorder/co-1/positions")) {
        return jsonResponse({ rows: [{ id: "pos-real-1" }, { id: "pos-real-2" }] });
      }
      return jsonResponse({ rows: [] });
    },
    async () => {
      const client = createMoySkladClient(CONFIG);
      const positionId = await client.resolveFirstOrderPositionId("co-1");
      assert.equal(positionId, "pos-real-1");
    },
  );
});

test("#16: resolveFirstOrderPositionId returns null on empty positions", async () => {
  await withMockedFetch(
    async () => jsonResponse({ rows: [] }),
    async () => {
      const client = createMoySkladClient(CONFIG);
      assert.equal(await client.resolveFirstOrderPositionId("co-empty"), null);
    },
  );
});

test("#16: resolveFirstOrderPositionId swallows a failed lookup and returns null", async () => {
  await withMockedFetch(
    async () => jsonResponse({ errors: [{ error: "boom" }] }, 500),
    async () => {
      const client = createMoySkladClient(CONFIG);
      // Сбой дотяжки не должен бросать — бронь уже создана, просто станет
      // неотменяемой из UI.
      assert.equal(await client.resolveFirstOrderPositionId("co-fail"), null);
    },
  );
});
