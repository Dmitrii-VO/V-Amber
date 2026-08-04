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
  createCustomerOrderReservation: (args) => ({
    productId: args?.activeLot?.product?.id || null,
    orderId: null,
    counterpartyId: args?.counterparty?.id || null,
    commentId: args?.reservation?.commentId || null,
    lotSessionId: args?.activeLot?.lotSessionId || null,
  }),
  appendPositionToCustomerOrder: (args) => ({
    productId: args?.activeLot?.product?.id || null,
    orderId: args?.orderId || null,
    commentId: args?.reservation?.commentId || null,
    lotSessionId: args?.activeLot?.lotSessionId || null,
  }),
};

function timeoutError() {
  return Object.assign(new Error("MoySklad POST timed out"), { code: "MOYSKLAD_TIMEOUT" });
}

function connectionError() {
  return Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
}

function connectionResetError() {
  return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
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

async function buildWrapped(filePath, client, { reconciler = null, moysklad = null, retryAttempts = 2 } = {}) {
  const journal = createWriteJournal({ filePath });
  await journal.load();
  const activeReconciler = reconciler || (moysklad
    ? createReservationReconciler({ moysklad, journal })
    : null);
  const wrapped = wrapWithWriteJournal(client, journal, keyBuilders, {
    metaBuilders,
    reconciler: activeReconciler,
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

test("ECONNRESET сверяется, а не повторяется вслепую", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([connectionResetError()]);
    const moysklad = {
      async findCustomerOrderByCommentMarker() { return { id: "order-applied", name: "00042" }; },
      async resolveFirstOrderPositionId() { return "pos-applied"; },
    };
    const { wrapped } = await buildWrapped(filePath, client, { moysklad });

    const result = await wrapped.createCustomerOrderReservation(ARGS);

    assert.equal(client.createCalls, 1, "reset после POST мог произойти уже после применения записи");
    assert.equal(result.id, "order-applied");
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
    const { journal, wrapped } = await buildWrapped(filePath, client, { moysklad });

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
    const { wrapped } = await buildWrapped(filePath, client, { moysklad });

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
    const { journal, wrapped } = await buildWrapped(filePath, client, { moysklad });

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
    const { wrapped } = await buildWrapped(filePath, client, { moysklad });

    // counterparty отсутствует — разрешать его через ensureCounterparty нельзя,
    // это запись.
    const argsWithoutCounterparty = { activeLot: LOT, reservation: { viewerId: 42, commentId: 7 } };
    await assert.rejects(() => wrapped.createCustomerOrderReservation(argsWithoutCounterparty), /timed out/);

    assert.equal(searched, false, "без контрагента поиск заказа не имеет смысла");
    assert.equal(client.createCalls, 1);
  });
});

test("pending после рестарта сверяется до нового POST", async () => {
  await withTempJournal(async (filePath) => {
    const key = "lot-1::42::7";
    const firstJournal = createWriteJournal({ filePath });
    await firstJournal.load();
    await firstJournal.begin(key, "createCustomerOrderReservation", { productId: "prod-1", orderId: null });

    const client = makeClient([]);
    const moysklad = {
      async findCustomerOrderByCommentMarker() { return { id: "order-before-crash", name: "00042" }; },
      async resolveFirstOrderPositionId() { return "pos-before-crash"; },
    };
    const { journal, wrapped } = await buildWrapped(filePath, client, { moysklad });

    const result = await wrapped.createCustomerOrderReservation(ARGS);

    assert.equal(client.createCalls, 0, "незавершённый journal entry нельзя повторять до сверки");
    assert.equal(result.id, "order-before-crash");
    assert.equal(journal.lookup(key).status, "done");
  });
});

test("pending без убедительной сверки блокирует новый POST", async () => {
  await withTempJournal(async (filePath) => {
    const key = "lot-1::42::7";
    const firstJournal = createWriteJournal({ filePath });
    await firstJournal.load();
    await firstJournal.begin(key, "createCustomerOrderReservation");

    const client = makeClient([]);
    const { wrapped } = await buildWrapped(filePath, client);

    await assert.rejects(
      () => wrapped.createCustomerOrderReservation(ARGS),
      /Previous MoySklad write outcome is unknown/,
    );
    assert.equal(client.createCalls, 0);
  });
});

test("pending сверяется по сохранённому методу, если маршрут после рестарта изменился", async () => {
  await withTempJournal(async (filePath) => {
    const key = "lot-1::42::7";
    const firstJournal = createWriteJournal({ filePath });
    await firstJournal.load();
    await firstJournal.begin(key, "appendPositionToCustomerOrder", {
      productId: "prod-1",
      orderId: "order-before-crash",
      positionCountBefore: 1,
      commentId: 7,
      lotSessionId: "lot-1",
    });

    const client = makeClient([]);
    const moysklad = {
      async countPositionsForProduct(orderId) {
        assert.equal(orderId, "order-before-crash");
        return 2;
      },
    };
    const { wrapped } = await buildWrapped(filePath, client, { moysklad });

    // Текущий роут выбрал create, но журнал знает, что до падения шёл append.
    const result = await wrapped.createCustomerOrderReservation(ARGS);

    assert.equal(client.createCalls, 0);
    assert.equal(result.id, "order-before-crash");
  });
});

test("done append нормализуется для create-маршрута после рестарта", async () => {
  await withTempJournal(async (filePath) => {
    const key = "lot-1::42::7";
    const firstJournal = createWriteJournal({ filePath });
    await firstJournal.load();
    await firstJournal.begin(key, "appendPositionToCustomerOrder", { orderId: "order-existing" });
    await firstJournal.complete(
      key,
      "appendPositionToCustomerOrder",
      { orderId: "order-existing", positionId: "pos-existing", positionsAdded: 1 },
      { orderId: "order-existing" },
    );

    const client = makeClient([]);
    const { wrapped } = await buildWrapped(filePath, client);
    const result = await wrapped.createCustomerOrderReservation(ARGS);

    assert.equal(client.createCalls, 0);
    assert.equal(result.id, "order-existing");
    assert.equal(result.positionId, "pos-existing");
  });
});

test("pending create возвращает фактический заказ новому append-маршруту", async () => {
  await withTempJournal(async (filePath) => {
    const key = "lot-1::42::7";
    const firstJournal = createWriteJournal({ filePath });
    await firstJournal.load();
    await firstJournal.begin(key, "createCustomerOrderReservation", {
      productId: "prod-1",
      counterpartyId: "cp-1",
      commentId: 7,
      lotSessionId: "lot-1",
    });

    const client = makeClient([]);
    const moysklad = {
      async findCustomerOrderByCommentMarker() { return { id: "order-before-crash", name: "00042" }; },
      async resolveFirstOrderPositionId() { return "pos-before-crash"; },
      async countPositionsForProduct() { throw new Error("current append must not prepare"); },
    };
    const { wrapped } = await buildWrapped(filePath, client, { moysklad });
    const result = await wrapped.appendPositionToCustomerOrder({ ...ARGS, orderId: "order-current-cache" });

    assert.equal(client.appendCalls, 0);
    assert.equal(result.id, "order-before-crash");
    assert.equal(result.orderId, "order-before-crash");
  });
});

test("append: позиция появилась относительно pre-write baseline — потерянная запись доехала", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([timeoutError()]);
    const counts = [1, 2];
    const moysklad = {
      async countPositionsForProduct() { return counts.shift(); },
    };
    const { wrapped } = await buildWrapped(filePath, client, { moysklad });

    const result = await wrapped.appendPositionToCustomerOrder({ ...ARGS, orderId: "order-9" });

    assert.equal(client.appendCalls, 1, "позиция уже в заказе — повтор создал бы дубль");
    assert.equal(result.orderId, "order-9");
  });
});

test("append: число позиций не изменилось относительно baseline — повторяем", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([timeoutError()]);
    const counts = [1, 1];
    const moysklad = {
      async countPositionsForProduct() { return counts.shift(); },
    };
    const { wrapped } = await buildWrapped(filePath, client, { moysklad });

    const result = await wrapped.appendPositionToCustomerOrder({ ...ARGS, orderId: "order-9" });

    assert.equal(client.appendCalls, 2);
    assert.equal(result.positionId, "pos-2");
  });
});

test("append: расхождение больше чем на одну позицию — не угадываем", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([timeoutError()]);
    // В заказ писал кто-то ещё (оператор руками) — вывод был бы догадкой.
    const counts = [1, 5];
    const moysklad = {
      async countPositionsForProduct() { return counts.shift(); },
    };
    const { wrapped } = await buildWrapped(filePath, client, { moysklad });

    await assert.rejects(
      () => wrapped.appendPositionToCustomerOrder({ ...ARGS, orderId: "order-9" }),
      /timed out/,
    );
    assert.equal(client.appendCalls, 1);
  });
});

test("append: без pre-write baseline внешний POST не запускается", async () => {
  await withTempJournal(async (filePath) => {
    const client = makeClient([]);
    const moysklad = {
      async countPositionsForProduct() { throw new Error("baseline unavailable"); },
    };
    const { wrapped } = await buildWrapped(filePath, client, { moysklad });

    await assert.rejects(
      () => wrapped.appendPositionToCustomerOrder({ ...ARGS, orderId: "order-9" }),
      /Cannot persist a safe append baseline/,
    );
    assert.equal(client.appendCalls, 0);
  });
});

test("одинаковые ключи выполняются одним внешним вызовом", async () => {
  await withTempJournal(async (filePath) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const client = makeClient(async function waitForRelease() {
      await gate;
      return { id: "order-one", positionId: "pos-one" };
    });
    const { wrapped } = await buildWrapped(filePath, client);

    const first = wrapped.createCustomerOrderReservation(ARGS);
    const second = wrapped.createCustomerOrderReservation(ARGS);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(client.createCalls, 1);
    assert.deepEqual(secondResult, firstResult);
  });
});
