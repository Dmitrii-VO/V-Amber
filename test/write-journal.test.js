import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWriteJournal,
  wrapWithWriteJournal,
  buildReservationWriteKey,
  classifyWriteOutcome,
} from "../server/write-journal.js";

async function withTempJournal(run) {
  const dir = await mkdtemp(join(tmpdir(), "write-journal-"));
  const filePath = join(dir, "moysklad-writes.jsonl");
  try {
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const LOT = { lotSessionId: "lot-1", code: "03204" };

function makeClient(impl) {
  return {
    calls: 0,
    async createCustomerOrderReservation(args) {
      this.calls += 1;
      return impl ? impl.call(this, args) : { id: `order-${this.calls}`, positionId: `pos-${this.calls}` };
    },
  };
}

const keyBuilders = {
  createCustomerOrderReservation: (args) => buildReservationWriteKey(args || {}),
};

test("ключ строится из лота, покупателя и комментария", () => {
  assert.equal(
    buildReservationWriteKey({ activeLot: LOT, reservation: { viewerId: 42, commentId: 7 } }),
    "lot-1::42::7",
  );
});

test("без commentId ключа нет — ручные брони не дедуплицируются", () => {
  assert.equal(
    buildReservationWriteKey({ activeLot: LOT, reservation: { viewerId: 42, commentId: null } }),
    null,
  );
});

test("повторная запись той же брони не уходит в МойСклад дважды", async () => {
  await withTempJournal(async (filePath) => {
    const journal = createWriteJournal({ filePath });
    await journal.load();
    const client = makeClient();
    const wrapped = wrapWithWriteJournal(client, journal, keyBuilders);

    const args = { activeLot: LOT, reservation: { viewerId: 42, commentId: 7 } };
    const first = await wrapped.createCustomerOrderReservation(args);
    const second = await wrapped.createCustomerOrderReservation(args);

    assert.equal(client.calls, 1, "второй вызов должен быть перехвачен журналом");
    assert.deepEqual(second, first, "повтор возвращает прежний результат");
  });
});

test("дедуп переживает рестарт процесса", async () => {
  await withTempJournal(async (filePath) => {
    const args = { activeLot: LOT, reservation: { viewerId: 42, commentId: 7 } };

    const firstJournal = createWriteJournal({ filePath });
    await firstJournal.load();
    const firstClient = makeClient();
    await wrapWithWriteJournal(firstClient, firstJournal, keyBuilders)
      .createCustomerOrderReservation(args);

    const secondJournal = createWriteJournal({ filePath });
    await secondJournal.load();
    const secondClient = makeClient();
    const replayed = await wrapWithWriteJournal(secondClient, secondJournal, keyBuilders)
      .createCustomerOrderReservation(args);

    assert.equal(secondClient.calls, 0, "после рестарта запись не должна повториться");
    assert.equal(replayed.id, "order-1");
  });
});

test("другой комментарий — другая бронь, дедуп не мешает докупке", async () => {
  await withTempJournal(async (filePath) => {
    const journal = createWriteJournal({ filePath });
    await journal.load();
    const client = makeClient();
    const wrapped = wrapWithWriteJournal(client, journal, keyBuilders);

    await wrapped.createCustomerOrderReservation({ activeLot: LOT, reservation: { viewerId: 42, commentId: 7 } });
    await wrapped.createCustomerOrderReservation({ activeLot: LOT, reservation: { viewerId: 42, commentId: 8 } });

    assert.equal(client.calls, 2, "«ещё 2 шт» отдельным комментарием — законная вторая запись");
  });
});

test("без ключа запись идёт как раньше, дедупа нет", async () => {
  await withTempJournal(async (filePath) => {
    const journal = createWriteJournal({ filePath });
    await journal.load();
    const client = makeClient();
    const wrapped = wrapWithWriteJournal(client, journal, keyBuilders);

    const args = { activeLot: LOT, reservation: { viewerId: 42, commentId: null } };
    await wrapped.createCustomerOrderReservation(args);
    await wrapped.createCustomerOrderReservation(args);

    assert.equal(client.calls, 2);
  });
});

test("упавшая запись не считается выполненной и повтор её пропускает в МойСклад", async () => {
  await withTempJournal(async (filePath) => {
    const journal = createWriteJournal({ filePath });
    await journal.load();

    let shouldFail = true;
    const client = makeClient(function failOnce() {
      if (shouldFail) {
        const error = new Error("MoySklad HTTP 401");
        throw error;
      }
      return { id: "order-recovered", positionId: "pos-recovered" };
    });
    // retryAttempts:1 — проверяем именно отсутствие дедупа упавшей записи,
    // без вмешательства автоповтора (он проверяется отдельно ниже).
    const wrapped = wrapWithWriteJournal(client, journal, keyBuilders, { retryAttempts: 1 });
    const args = { activeLot: LOT, reservation: { viewerId: 42, commentId: 7 } };

    await assert.rejects(() => wrapped.createCustomerOrderReservation(args), /401/);

    shouldFail = false;
    const retried = await wrapped.createCustomerOrderReservation(args);

    assert.equal(client.calls, 2, "неуспешная запись не должна дедуплицироваться");
    assert.equal(retried.id, "order-recovered");
  });
});

test("исход 401 классифицируется как не применённый, таймаут — как неизвестный", () => {
  assert.equal(classifyWriteOutcome(new Error("MoySklad HTTP 401")), "not_applied");
  assert.equal(classifyWriteOutcome(Object.assign(new Error("boom"), { code: "ECONNREFUSED" })), "not_applied");

  const timeout = Object.assign(new Error("timed out"), { code: "MOYSKLAD_TIMEOUT" });
  assert.equal(classifyWriteOutcome(timeout), "unknown", "после таймаута заказ мог создаться");
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  assert.equal(classifyWriteOutcome(reset), "unknown", "reset мог произойти после применения POST");
  assert.equal(classifyWriteOutcome(new Error("MoySklad HTTP 503")), "unknown");
});

test("ошибка durable begin блокирует внешний POST", async () => {
  const client = makeClient();
  const journal = {
    lookup() { return null; },
    async begin() { throw new Error("journal disk full"); },
  };
  const wrapped = wrapWithWriteJournal(client, journal, keyBuilders);

  await assert.rejects(
    () => wrapped.createCustomerOrderReservation({ activeLot: LOT, reservation: { viewerId: 42, commentId: 7 } }),
    /journal disk full/,
  );
  assert.equal(client.calls, 0, "без durable begin идемпотентный POST невозможен");
});

test("журнал хранит все записи, а не последние двадцать", async () => {
  await withTempJournal(async (filePath) => {
    const journal = createWriteJournal({ filePath });
    await journal.load();
    const client = makeClient();
    const wrapped = wrapWithWriteJournal(client, journal, keyBuilders);

    for (let commentId = 1; commentId <= 25; commentId += 1) {
      await wrapped.createCustomerOrderReservation({ activeLot: LOT, reservation: { viewerId: 42, commentId } });
    }

    const reloaded = createWriteJournal({ filePath });
    await reloaded.load();
    assert.equal(reloaded.stats().total, 25);
    assert.ok(reloaded.lookup("lot-1::42::1"), "самая первая бронь эфира должна остаться в журнале");
  });
});
