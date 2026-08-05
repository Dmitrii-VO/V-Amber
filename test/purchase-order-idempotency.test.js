import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWriteJournal, wrapWithWriteJournal, buildPurchaseOrderWriteKey } from "../server/write-journal.js";
import { createReservationReconciler } from "../server/write-reconciler.js";
import { buildPurchaseOrderPositionsFingerprint } from "../server/moysklad-helpers.js";
import { createMoySkladClient } from "../server/moysklad.js";

async function withTempJournal(run) {
  const dir = await mkdtemp(join(tmpdir(), "purchase-order-"));
  const filePath = join(dir, "moysklad-writes.jsonl");
  try {
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const DRAFT_ID = "draft-1";
const GROUP_HASH = "sha256:aaa";

const keyBuilders = {
  createPurchaseOrder: (args) => buildPurchaseOrderWriteKey(args || {}),
};

const metaBuilders = {
  createPurchaseOrder: (args) => ({
    draftId: args?.draftId || null,
    groupHash: args?.groupHash || null,
    agentId: args?.agentId || null,
    storeId: args?.storeId || null,
  }),
};

function purchaseOrderArgs(overrides = {}) {
  return {
    organizationId: "org-1",
    storeId: "store-1",
    agentId: "supplier-1",
    positions: [{ productId: "prod-1", quantity: 2, price: 15000 }],
    description: "Закупка 2026-08-05",
    draftId: DRAFT_ID,
    groupHash: GROUP_HASH,
    ...overrides,
  };
}

function timeoutError() {
  return Object.assign(new Error("MoySklad POST timed out"), { code: "MOYSKLAD_TIMEOUT" });
}

// Клиент-дублёр: считает POST'ы и играет заданный сценарий ошибок.
function makeClient(script) {
  return {
    calls: 0,
    async createPurchaseOrder(args) {
      this.calls += 1;
      const step = Array.isArray(script) ? script[this.calls - 1] : null;
      if (step instanceof Error) throw step;
      return { id: `po-${this.calls}`, name: `ЗАК-${this.calls}`, agentId: args.agentId };
    },
  };
}

function makeReconcilerMoysklad(matches, inconclusiveReason = null) {
  return {
    lookups: 0,
    async findPurchaseOrdersByFingerprint() {
      this.lookups += 1;
      return { matches, inconclusiveReason };
    },
  };
}

test("ключ закупочного заказа строится из черновика и группы", () => {
  assert.equal(buildPurchaseOrderWriteKey({ draftId: DRAFT_ID, groupHash: GROUP_HASH }), "po::draft-1::sha256:aaa");
  assert.equal(buildPurchaseOrderWriteKey({ draftId: DRAFT_ID, groupHash: null }), null);
  assert.equal(buildPurchaseOrderWriteKey({ draftId: null, groupHash: GROUP_HASH }), null);
});

test("отпечаток позиций не зависит от порядка, но зависит от количества и цены", () => {
  const a = buildPurchaseOrderPositionsFingerprint([
    { productId: "p1", quantity: 2, price: 15000 },
    { productId: "p2", quantity: 1, price: 500 },
  ]);
  const reordered = buildPurchaseOrderPositionsFingerprint([
    { productId: "p2", quantity: 1, price: 500 },
    { productId: "p1", quantity: 2, price: 15000 },
  ]);
  assert.equal(a, reordered);

  const otherQuantity = buildPurchaseOrderPositionsFingerprint([
    { productId: "p1", quantity: 3, price: 15000 },
    { productId: "p2", quantity: 1, price: 500 },
  ]);
  assert.notEqual(a, otherQuantity);
});

test("повторная отправка той же группы не создаёт второй закупочный заказ", async () => {
  await withTempJournal(async (filePath) => {
    const journal = createWriteJournal({ filePath });
    await journal.load();
    const client = makeClient();
    const wrapped = wrapWithWriteJournal(client, journal, keyBuilders, { metaBuilders });

    const first = await wrapped.createPurchaseOrder(purchaseOrderArgs());
    const second = await wrapped.createPurchaseOrder(purchaseOrderArgs());

    assert.equal(client.calls, 1, "второй POST должен быть перехвачен журналом");
    assert.deepEqual(second, first, "повтор возвращает прежний закупочный заказ");
  });
});

test("дедуп закупочного заказа переживает рестарт процесса", async () => {
  await withTempJournal(async (filePath) => {
    const firstJournal = createWriteJournal({ filePath });
    await firstJournal.load();
    const firstClient = makeClient();
    await wrapWithWriteJournal(firstClient, firstJournal, keyBuilders, { metaBuilders })
      .createPurchaseOrder(purchaseOrderArgs());

    const secondJournal = createWriteJournal({ filePath });
    await secondJournal.load();
    const secondClient = makeClient();
    const replayed = await wrapWithWriteJournal(secondClient, secondJournal, keyBuilders, { metaBuilders })
      .createPurchaseOrder(purchaseOrderArgs());

    assert.equal(secondClient.calls, 0, "после рестарта заказ не должен создаваться заново");
    assert.equal(replayed.id, "po-1");
  });
});

test("разные группы одной отправки — разные заказы, дедуп не мешает", async () => {
  await withTempJournal(async (filePath) => {
    const journal = createWriteJournal({ filePath });
    await journal.load();
    const client = makeClient();
    const wrapped = wrapWithWriteJournal(client, journal, keyBuilders, { metaBuilders });

    await wrapped.createPurchaseOrder(purchaseOrderArgs());
    await wrapped.createPurchaseOrder(purchaseOrderArgs({ groupHash: "sha256:bbb", agentId: "supplier-2" }));

    assert.equal(client.calls, 2, "вторая группа поставщика — законный второй заказ");
  });
});

test("потерянный ответ: сверка нашла заказ — второго POST нет", async () => {
  await withTempJournal(async (filePath) => {
    const journal = createWriteJournal({ filePath });
    await journal.load();
    const moysklad = makeReconcilerMoysklad([{ id: "po-existing", name: "ЗАК-42" }]);
    const reconciler = createReservationReconciler({ moysklad, journal });
    const client = makeClient([timeoutError()]);
    const wrapped = wrapWithWriteJournal(client, journal, keyBuilders, { metaBuilders, reconciler });

    const result = await wrapped.createPurchaseOrder(purchaseOrderArgs());

    assert.equal(client.calls, 1, "после таймаута повторять POST нельзя");
    assert.equal(moysklad.lookups, 1);
    assert.equal(result.id, "po-existing", "результат берётся у найденного заказа");
  });
});

test("потерянный ответ: заказа нет — запись повторяется", async () => {
  await withTempJournal(async (filePath) => {
    const journal = createWriteJournal({ filePath });
    await journal.load();
    const moysklad = makeReconcilerMoysklad([]);
    const reconciler = createReservationReconciler({ moysklad, journal });
    const client = makeClient([timeoutError()]);
    const wrapped = wrapWithWriteJournal(client, journal, keyBuilders, {
      metaBuilders,
      reconciler,
      retryBaseDelayMs: 0,
    });

    const result = await wrapped.createPurchaseOrder(purchaseOrderArgs());

    assert.equal(client.calls, 2, "заказ не применился — повтор законен");
    assert.equal(result.id, "po-2");
  });
});

test("два одинаковых заказа — исход неизвестен, POST не повторяется", async () => {
  await withTempJournal(async (filePath) => {
    const journal = createWriteJournal({ filePath });
    await journal.load();
    const moysklad = makeReconcilerMoysklad([
      { id: "po-1", name: "ЗАК-1" },
      { id: "po-2", name: "ЗАК-2" },
    ]);
    const reconciler = createReservationReconciler({ moysklad, journal });
    const client = makeClient([timeoutError()]);
    const wrapped = wrapWithWriteJournal(client, journal, keyBuilders, { metaBuilders, reconciler });

    await assert.rejects(() => wrapped.createPurchaseOrder(purchaseOrderArgs()), /timed out/);
    assert.equal(client.calls, 1, "при неоднозначной сверке дубль создавать нельзя");

    // Следующая отправка той же группы тоже не имеет права слепо повторять POST.
    const second = makeReconcilerMoysklad([
      { id: "po-1", name: "ЗАК-1" },
      { id: "po-2", name: "ЗАК-2" },
    ]);
    const wrappedAgain = wrapWithWriteJournal(client, journal, keyBuilders, {
      metaBuilders,
      reconciler: createReservationReconciler({ moysklad: second, journal }),
    });
    await assert.rejects(
      () => wrappedAgain.createPurchaseOrder(purchaseOrderArgs()),
      /outcome is unknown/,
    );
    assert.equal(client.calls, 1);
  });
});

test("сверка без поставщика или позиций отвечает «не знаю», а не «не применилось»", async () => {
  const moysklad = makeReconcilerMoysklad([]);
  const reconciler = createReservationReconciler({ moysklad, journal: { lookup: () => null } });

  const verdict = await reconciler.resolve({
    method: "createPurchaseOrder",
    args: { agentId: null, positions: [] },
    key: "po::draft-1::sha256:aaa",
  });

  assert.equal(verdict.status, "inconclusive");
  assert.equal(moysklad.lookups, 0);
});

// --- findPurchaseOrdersByFingerprint (уровень клиента МойСклад) ---

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
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/api\/remap\/1\.2\//, "");
    calls.push({ path, searchParams: parsed.searchParams });
    return handler(path, parsed.searchParams);
  };
  return run(calls).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

const PO_LIST = {
  rows: [
    {
      id: "po-match",
      name: "ЗАК-7",
      description: "Закупка 2026-08-05",
      store: { meta: { href: "https://moysklad.test/api/remap/1.2/entity/store/aaaaaaaa-0000-4000-8000-000000000001" } },
    },
    {
      id: "po-other-description",
      name: "ЗАК-6",
      description: "Другая закупка",
      store: { meta: { href: "https://moysklad.test/api/remap/1.2/entity/store/aaaaaaaa-0000-4000-8000-000000000001" } },
    },
    {
      id: "po-other-store",
      name: "ЗАК-5",
      description: "Закупка 2026-08-05",
      store: { meta: { href: "https://moysklad.test/api/remap/1.2/entity/store/bbbbbbbb-0000-4000-8000-000000000002" } },
    },
  ],
};

function positionsResponse(rows) {
  return jsonResponse({
    rows: rows.map((r) => ({
      quantity: r.quantity,
      price: r.price,
      assortment: { meta: { href: `https://moysklad.test/api/remap/1.2/entity/product/${r.productId}` } },
    })),
  });
}

test("findPurchaseOrdersByFingerprint находит заказ по описанию, складу и составу", async () => {
  const client = createMoySkladClient(baseConfig);
  await withFetchMock((path) => {
    if (path === "entity/purchaseorder") return jsonResponse(PO_LIST);
    if (path === "entity/purchaseorder/po-match/positions") {
      return positionsResponse([{ productId: "cccccccc-0000-4000-8000-000000000003", quantity: 2, price: 15000 }]);
    }
    throw new Error(`unexpected path ${path}`);
  }, async (calls) => {
    const found = await client.findPurchaseOrdersByFingerprint({
      agentId: "supplier-1",
      storeId: "aaaaaaaa-0000-4000-8000-000000000001",
      positions: [{ productId: "cccccccc-0000-4000-8000-000000000003", quantity: 2, price: 15000 }],
      description: "Закупка 2026-08-05",
    });

    assert.deepEqual(found.matches, [{ id: "po-match", name: "ЗАК-7" }]);
    assert.equal(found.inconclusiveReason, null);
    // Позиции вычитываются только у кандидата, прошедшего по описанию и складу.
    assert.equal(calls.filter((c) => c.path.endsWith("/positions")).length, 1);
  });
});

test("findPurchaseOrdersByFingerprint не считает совпадением заказ с другим составом", async () => {
  const client = createMoySkladClient(baseConfig);
  await withFetchMock((path) => {
    if (path === "entity/purchaseorder") return jsonResponse(PO_LIST);
    if (path === "entity/purchaseorder/po-match/positions") {
      return positionsResponse([{ productId: "cccccccc-0000-4000-8000-000000000003", quantity: 5, price: 15000 }]);
    }
    throw new Error(`unexpected path ${path}`);
  }, async () => {
    const found = await client.findPurchaseOrdersByFingerprint({
      agentId: "supplier-1",
      storeId: "aaaaaaaa-0000-4000-8000-000000000001",
      positions: [{ productId: "cccccccc-0000-4000-8000-000000000003", quantity: 2, price: 15000 }],
      description: "Закупка 2026-08-05",
    });

    assert.deepEqual(found.matches, []);
  });
});

test("findPurchaseOrdersByFingerprint отвечает «не знаю» при слишком многих кандидатах", async () => {
  const client = createMoySkladClient(baseConfig);
  const rows = Array.from({ length: 6 }, (_, i) => ({
    id: `po-${i}`,
    name: `ЗАК-${i}`,
    description: "Закупка 2026-08-05",
    store: { meta: { href: "https://moysklad.test/api/remap/1.2/entity/store/aaaaaaaa-0000-4000-8000-000000000001" } },
  }));

  await withFetchMock((path) => {
    if (path === "entity/purchaseorder") return jsonResponse({ rows });
    throw new Error(`unexpected path ${path}`);
  }, async () => {
    const found = await client.findPurchaseOrdersByFingerprint({
      agentId: "supplier-1",
      storeId: "aaaaaaaa-0000-4000-8000-000000000001",
      positions: [{ productId: "cccccccc-0000-4000-8000-000000000003", quantity: 2, price: 15000 }],
      description: "Закупка 2026-08-05",
    });

    assert.deepEqual(found.matches, []);
    assert.equal(found.inconclusiveReason, "too_many_candidates");
  });
});
