import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPurchaseOrderSyncId,
  buildDeterministicUuid,
  V_AMBER_UUID_NAMESPACE,
} from "../server/moysklad-helpers.js";
import { createReservationReconciler } from "../server/write-reconciler.js";
import { createMoySkladClient } from "../server/moysklad.js";

const DRAFT_ID = "draft-1";
const GROUP_HASH = "sha256:aaa";

const baseConfig = {
  baseUrl: "https://moysklad.test/api/remap/1.2/",
  login: "user",
  password: "pass",
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function withFetchMock(handler, run) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/api\/remap\/1\.2\//, "");
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, searchParams: parsed.searchParams, method: init?.method || "GET", body });
    return handler(path, parsed.searchParams, init);
  };
  return run(calls).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test("syncId детерминирован и различает группы одной отправки", () => {
  const a = buildPurchaseOrderSyncId({ draftId: DRAFT_ID, groupHash: GROUP_HASH });
  const again = buildPurchaseOrderSyncId({ draftId: DRAFT_ID, groupHash: GROUP_HASH });
  const otherGroup = buildPurchaseOrderSyncId({ draftId: DRAFT_ID, groupHash: "sha256:bbb" });
  const otherDraft = buildPurchaseOrderSyncId({ draftId: "draft-2", groupHash: GROUP_HASH });

  assert.equal(a, again, "тот же вход — тот же syncId, иначе повтор не узнать");
  assert.notEqual(a, otherGroup);
  assert.notEqual(a, otherDraft);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "МойСклад принимает в syncId только UUID");
});

test("без draftId или groupHash syncId не строится", () => {
  assert.equal(buildPurchaseOrderSyncId({ draftId: DRAFT_ID }), null);
  assert.equal(buildPurchaseOrderSyncId({ groupHash: GROUP_HASH }), null);
  assert.equal(buildPurchaseOrderSyncId(), null);
});

test("детерминированный UUID зависит от пространства имён", () => {
  const mine = buildDeterministicUuid(V_AMBER_UUID_NAMESPACE, "x");
  const other = buildDeterministicUuid("00000000-0000-4000-8000-000000000000", "x");
  assert.notEqual(mine, other);
});

test("createPurchaseOrder кладёт syncId в POST", async () => {
  const client = createMoySkladClient(baseConfig);
  await withFetchMock((path) => {
    if (path === "entity/purchaseorder") return jsonResponse({ id: "po-1", name: "ЗАК-1" });
    throw new Error(`unexpected path ${path}`);
  }, async (calls) => {
    const result = await client.createPurchaseOrder({
      organizationId: "org-1",
      storeId: "store-1",
      agentId: "supplier-1",
      positions: [{ productId: "prod-1", quantity: 1, price: 100 }],
      description: "Закупка",
      draftId: DRAFT_ID,
      groupHash: GROUP_HASH,
    });

    const post = calls.find((c) => c.method === "POST");
    assert.equal(post.body.syncId, buildPurchaseOrderSyncId({ draftId: DRAFT_ID, groupHash: GROUP_HASH }));
    assert.equal(result.syncId, post.body.syncId, "syncId возвращается вызывающему");
  });
});

test("без draftId POST уходит без syncId — поведение не ломается", async () => {
  const client = createMoySkladClient(baseConfig);
  await withFetchMock((path) => {
    if (path === "entity/purchaseorder") return jsonResponse({ id: "po-1", name: "ЗАК-1" });
    throw new Error(`unexpected path ${path}`);
  }, async (calls) => {
    await client.createPurchaseOrder({
      organizationId: "org-1",
      agentId: "supplier-1",
      positions: [{ productId: "prod-1", quantity: 1, price: 100 }],
    });
    const post = calls.find((c) => c.method === "POST");
    assert.equal("syncId" in post.body, false);
  });
});

test("findPurchaseOrdersBySyncId сообщает о неподдержанном фильтре, а не о пустоте", async () => {
  const client = createMoySkladClient(baseConfig);
  await withFetchMock(() => jsonResponse({ errors: [{ error: "Не найден фильтр" }] }, 400), async () => {
    const found = await client.findPurchaseOrdersBySyncId({ syncId: "aaaaaaaa-0000-5000-8000-000000000001" });
    assert.equal(found.supported, false, "отказ фильтра ≠ «заказа нет»");
    assert.deepEqual(found.rows, []);
  });
});

// --- Сверка ---

function makeReconcilerMoysklad({ syncIdRows = [], syncIdSupported = true, fingerprintMatches = [] } = {}) {
  return {
    syncIdLookups: 0,
    fingerprintLookups: 0,
    async findPurchaseOrdersBySyncId() {
      this.syncIdLookups += 1;
      return { supported: syncIdSupported, rows: syncIdRows };
    },
    async findPurchaseOrdersByFingerprint() {
      this.fingerprintLookups += 1;
      return { matches: fingerprintMatches, inconclusiveReason: null };
    },
  };
}

const reconcileArgs = {
  agentId: "supplier-1",
  storeId: "store-1",
  positions: [{ productId: "prod-1", quantity: 2, price: 15000 }],
  description: "Закупка",
  draftId: DRAFT_ID,
  groupHash: GROUP_HASH,
};

test("сверка по syncId закрывает вопрос, отпечаток не нужен", async () => {
  const moysklad = makeReconcilerMoysklad({ syncIdRows: [{ id: "po-7", name: "ЗАК-7" }] });
  const reconciler = createReservationReconciler({ moysklad, journal: { lookup: () => null } });

  const verdict = await reconciler.resolve({ method: "createPurchaseOrder", args: reconcileArgs, key: "k" });

  assert.equal(verdict.status, "applied");
  assert.equal(verdict.result.id, "po-7");
  assert.equal(moysklad.syncIdLookups, 1);
  assert.equal(moysklad.fingerprintLookups, 0, "точный ключ сработал — угадывать по отпечатку незачем");
});

test("syncId ничего не нашёл — решает отпечаток, а не пустой ответ", async () => {
  const moysklad = makeReconcilerMoysklad({
    syncIdRows: [],
    fingerprintMatches: [{ id: "po-old", name: "ЗАК-старый" }],
  });
  const reconciler = createReservationReconciler({ moysklad, journal: { lookup: () => null } });

  const verdict = await reconciler.resolve({ method: "createPurchaseOrder", args: reconcileArgs, key: "k" });

  assert.equal(verdict.status, "applied", "заказ из прошлой версии приложения идёт без syncId");
  assert.equal(verdict.result.id, "po-old");
  assert.equal(moysklad.fingerprintLookups, 1);
});

test("ни syncId, ни отпечаток не нашли — запись не применилась", async () => {
  const moysklad = makeReconcilerMoysklad({ syncIdRows: [], fingerprintMatches: [] });
  const reconciler = createReservationReconciler({ moysklad, journal: { lookup: () => null } });

  const verdict = await reconciler.resolve({ method: "createPurchaseOrder", args: reconcileArgs, key: "k" });

  assert.equal(verdict.status, "not_applied");
});

test("два заказа с одним syncId — исход неизвестен", async () => {
  const moysklad = makeReconcilerMoysklad({
    syncIdRows: [{ id: "po-1", name: "ЗАК-1" }, { id: "po-2", name: "ЗАК-2" }],
  });
  const reconciler = createReservationReconciler({ moysklad, journal: { lookup: () => null } });

  const verdict = await reconciler.resolve({ method: "createPurchaseOrder", args: reconcileArgs, key: "k" });

  assert.equal(verdict.status, "inconclusive");
  assert.equal(verdict.reason, "sync_id_ambiguous");
  assert.equal(moysklad.fingerprintLookups, 0);
});

test("draftId и groupHash берутся из журнала, если их нет в аргументах", async () => {
  const moysklad = makeReconcilerMoysklad({ syncIdRows: [{ id: "po-7", name: "ЗАК-7" }] });
  const reconciler = createReservationReconciler({ moysklad, journal: { lookup: () => null } });

  const verdict = await reconciler.resolve({
    method: "createPurchaseOrder",
    args: { agentId: "supplier-1", positions: reconcileArgs.positions },
    key: "k",
    entry: { meta: { draftId: DRAFT_ID, groupHash: GROUP_HASH } },
  });

  assert.equal(verdict.status, "applied");
  assert.equal(moysklad.syncIdLookups, 1);
});
