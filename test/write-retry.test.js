import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWriteJournal, wrapWithWriteJournal, buildReservationWriteKey } from "../server/write-journal.js";
import { createReservationReconciler } from "../server/write-reconciler.js";

async function withTempJournal(run) {
  const dir = await mkdtemp(join(tmpdir(), "write-retry-"));
  const filePath = join(dir, "moysklad-writes.jsonl");
  try {
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const LOT = { lotSessionId: "lot-1", code: "03204", product: { id: "prod-1" } };
const COUNTERPARTY = { id: "cp-1" };

const keyBuilders = {
  createCustomerOrderReservation: (args) => buildReservationWriteKey(args || {}),
  appendPositionToCustomerOrder: (args) => buildReservationWriteKey(args || {}),
};

const metaBuilders = {
  createCustomerOrderReservation: (args) => ({ productId: args?.activeLot?.product?.id || null, orderId: null }),
  appendPositionToCustomerOrder: (args) => ({ productId: args?.activeLot?.product?.id || null, orderId: args?.orderId || null }),
};

function timeoutError() {
  return Object.assign(new Error("MoySklad POST timed out"), { code: "MOYSKLAD_TIMEOUT" });
}

function connectionError() {
  return Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
}

// Клиент-дублёр: считает попытки и играет заданный сценарий ошибок.
function makeClient(script) {
  return {
    createCalls: 0,
    appendCalls: 0,
    async createCustomerOrderReservation() {
      this.createCalls += 1;
      const step = script[this.createCalls - 1];
      if (step instanceof Error) throw step;
      return step || { id: `order-${this.createCalls}`, positionId: `pos-${this.createCalls}` };
    },
    async appendPositionToCustomerOrder({ orderId }) {
      this.appendCalls += 1;
      const step = script[this.appendCalls - 1];
      if (step instanceof Error) throw step;
      return step || { orderId, positionId: `pos-${this.appendCalls}`, positionsAdded: 1 };
    },
  };
}

const ARGS = {
  activeLot: LOT,
  reservation: { viewerId: 42, commentId: 7 },
  counterparty: COUNTERPARTY,
};

async function buildWrapped(filePath, client, { reconciler = null, retryAttempts = 2 } = {}) {
  const journal = createWriteJournal({ filePath });
  await journal.load();
  const wrapped = wrapWithWriteJournal(client, journal, keyBuilders, {
    metaBuilders,
    reconciler,
    retryAttempts,
    retryBaseDelayMs: 0,
  });
  return { journal, wrapped };
}

test("обрыв соединения — запись заведомо не дошла, повторяем автоматически", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([connectionError()]);
    const { wrapped } = await buildWrapped(filePath, client);

    const result = await wrapped.createCustomerOrderReservation(ARGS);

    assert.equal(client.createCalls, 2, "после ECONNREFUSED должна быть вторая попытка");
    assert.equal(result.id, "order-2");
  });
});

test("таймаут без сверки не повторяется — исход неизвестен", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([timeoutError()]);
    const { wrapped } = await buildWrapped(filePath, client);

    await assert.rejects(() => wrapped.createCustomerOrderReservation(ARGS), /timed out/);
    assert.equal(client.createCalls, 1, "вслепую повторять запись нельзя");
  });
});

test("сверка нашла заказ — второй записи не будет, бронь считается применённой", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([timeoutError()]);
    const moysklad = {
      async findCustomerOrderByCommentMarker({ commentId }) {
        return commentId === 7 ? { id: "order-lost", name: "00042" } : null;
      },
      async resolveFirstOrderPositionId() { return "pos-lost"; },
    };
    const { journal, wrapped } = await buildWrapped(filePath, client, {
      reconciler: createReservationReconciler({ moysklad, journal: { countApplied: () => 0 } }),
    });

    const result = await wrapped.createCustomerOrderReservation(ARGS);

    assert.equal(client.createCalls, 1, "повтор не нужен — заказ уже в МойСкладе");
    assert.equal(result.id, "order-lost");
    assert.equal(result.positionId, "pos-lost", "positionId нужен отмене брони");
    assert.equal(journal.lookup("lot-1::42::7").status, "done");
  });
});

test("сверка не нашла заказ — запись повторяется", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([timeoutError()]);
    const moysklad = {
      async findCustomerOrderByCommentMarker() { return null; },
      async resolveFirstOrderPositionId() { return null; },
    };
    const { wrapped } = await buildWrapped(filePath, client, {
      reconciler: createReservationReconciler({ moysklad, journal: { countApplied: () => 0 } }),
    });

    const result = await wrapped.createCustomerOrderReservation(ARGS);

    assert.equal(client.createCalls, 2);
    assert.equal(result.id, "order-2");
  });
});

test("сверка не смогла ответить — не угадываем, отдаём ошибку оператору", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([timeoutError()]);
    const moysklad = {
      async findCustomerOrderByCommentMarker() { throw new Error("МойСклад недоступен"); },
      async resolveFirstOrderPositionId() { return null; },
    };
    const { journal, wrapped } = await buildWrapped(filePath, client, {
      reconciler: createReservationReconciler({ moysklad, journal: { countApplied: () => 0 } }),
    });

    await assert.rejects(() => wrapped.createCustomerOrderReservation(ARGS), /timed out/);
    assert.equal(client.createCalls, 1, "при неразрешимом исходе повтор запрещён");
    assert.equal(journal.lookup("lot-1::42::7").status, "unknown");
  });
});

test("без готового контрагента сверка честно отвечает «не знаю»", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([timeoutError()]);
    let searched = false;
    const moysklad = {
      async findCustomerOrderByCommentMarker() { searched = true; return null; },
      async resolveFirstOrderPositionId() { return null; },
    };
    const { wrapped } = await buildWrapped(filePath, client, {
      reconciler: createReservationReconciler({ moysklad, journal: { countApplied: () => 0 } }),
    });

    // counterparty отсутствует — разрешать его через ensureCounterparty нельзя,
    // это запись.
    const argsWithoutCounterparty = { activeLot: LOT, reservation: { viewerId: 42, commentId: 7 } };
    await assert.rejects(() => wrapped.createCustomerOrderReservation(argsWithoutCounterparty), /timed out/);

    assert.equal(searched, false, "без контрагента поиск заказа не имеет смысла");
    assert.equal(client.createCalls, 1);
  });
});

test("append: позиций на одну больше, чем подтвердил журнал — потерянная запись доехала", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([timeoutError()]);
    const moysklad = {
      async countPositionsForProduct() { return 2; },
    };
    const { wrapped } = await buildWrapped(filePath, client, {
      reconciler: createReservationReconciler({ moysklad, journal: { countApplied: () => 1 } }),
    });

    const result = await wrapped.appendPositionToCustomerOrder({ ...ARGS, orderId: "order-9" });

    assert.equal(client.appendCalls, 1, "позиция уже в заказе — повтор создал бы дубль");
    assert.equal(result.orderId, "order-9");
  });
});

test("append: позиций столько же, сколько подтвердил журнал — запись не дошла, повторяем", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([timeoutError()]);
    const moysklad = {
      async countPositionsForProduct() { return 1; },
    };
    const { wrapped } = await buildWrapped(filePath, client, {
      reconciler: createReservationReconciler({ moysklad, journal: { countApplied: () => 1 } }),
    });

    const result = await wrapped.appendPositionToCustomerOrder({ ...ARGS, orderId: "order-9" });

    assert.equal(client.appendCalls, 2);
    assert.equal(result.positionId, "pos-2");
  });
});

test("append: расхождение больше чем на одну позицию — не угадываем", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([timeoutError()]);
    // В заказ писал кто-то ещё (оператор руками) — вывод был бы догадкой.
    const moysklad = {
      async countPositionsForProduct() { return 5; },
    };
    const { wrapped } = await buildWrapped(filePath, client, {
      reconciler: createReservationReconciler({ moysklad, journal: { countApplied: () => 1 } }),
    });

    await assert.rejects(
      () => wrapped.appendPositionToCustomerOrder({ ...ARGS, orderId: "order-9" }),
      /timed out/,
    );
    assert.equal(client.appendCalls, 1);
  });
});

test("countApplied считает и создание заказа, и дописанные позиции", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([]);
    const { journal, wrapped } = await buildWrapped(filePath, client);

    // create кладёт в заказ первую позицию товара; orderId известен из ответа.
    await wrapped.createCustomerOrderReservation(ARGS);
    const orderId = "order-1";
    await wrapped.appendPositionToCustomerOrder({
      ...ARGS,
      orderId,
      reservation: { viewerId: 42, commentId: 8 },
    });

    assert.equal(
      journal.countApplied({ orderId, productId: "prod-1" }),
      2,
      "создание заказа тоже добавило позицию этого товара",
    );
  });
});
