import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttentionStore } from "../server/attention-store.js";

// Строки «требует внимания» должны переживать эфир: во время трансляции
// оператор держит телефон как камеру и в баннер не смотрит — за 13 эфиров
// таких строк было 6488, а броней из них создано ноль.

async function freshStore(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "attention-"));
  const filePath = join(dir, "attention.jsonl");
  return { filePath, store: createAttentionStore({ filePath, ...options }) };
}

const ROW = {
  code: "03204",
  originalCode: "3204",
  viewerId: 5001,
  viewerName: "Аня",
  commentId: 401,
  text: "бронь 3204",
  quantity: 2,
  source: "vk",
  reason: "no_open_lot",
  bookable: true,
};

test("строка переживает перезапуск приложения", async () => {
  const { filePath, store } = await freshStore();
  await store.load();
  const id = store.add(ROW);
  await store.flush();

  const restarted = createAttentionStore({ filePath });
  await restarted.load();
  const row = restarted.get(id);
  assert.equal(row.code, "03204");
  assert.equal(row.originalCode, "3204");
  assert.equal(row.viewerName, "Аня");
  assert.equal(row.quantity, 2);
  assert.equal(row.bookable, true);
  assert.equal(restarted.openCount(), 1);
});

test("разбор закрывает строку и тоже переживает перезапуск", async () => {
  const { filePath, store } = await freshStore();
  await store.load();
  const id = store.add(ROW);
  assert.equal(store.resolve(id, { status: "reserved", resolution: { orderId: "co-1" } }), true);
  assert.equal(store.get(id), null, "разобранная строка больше не выдаётся");
  assert.equal(store.openCount(), 0);
  await store.flush();

  const restarted = createAttentionStore({ filePath });
  await restarted.load();
  assert.equal(restarted.openCount(), 0);
  const all = restarted.list({ includeResolved: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "reserved");
  assert.equal(all[0].resolution.orderId, "co-1");
});

test("повторный разбор той же строки ничего не ломает", async () => {
  const { store } = await freshStore();
  await store.load();
  const id = store.add(ROW);
  assert.equal(store.resolve(id), true);
  assert.equal(store.resolve(id), false, "второй раз закрывать нечего");
  assert.equal(store.resolve("att-нет-такой"), false);
});

test("строки старше срока хранения из разбора пропадают", async () => {
  const { filePath, store } = await freshStore();
  await store.load();
  store.add(ROW);
  await store.flush();

  // Тот же файл, но хранение — ноль дней: строка мгновенно «протухла».
  const expired = createAttentionStore({ filePath, retentionDays: 0 });
  await expired.load();
  assert.equal(expired.openCount(), 0);
  assert.equal(expired.list().length, 0);
});

test("ambiguous пишется в разбор, но бронировать по нему нельзя", async () => {
  const { store } = await freshStore();
  await store.load();
  const id = store.add({ ...ROW, reason: "ambiguous", bookable: false });
  const row = store.get(id);
  assert.equal(row.reason, "ambiguous");
  assert.equal(row.bookable, false, "выбирать товар за оператора в денежном пути нельзя");
});

test("битая строка в файле не уносит с собой остальную историю", async () => {
  const { filePath, store } = await freshStore();
  await store.load();
  store.add(ROW);
  await store.flush();
  const { appendFile } = await import("node:fs/promises");
  await appendFile(filePath, "{это не json\n", "utf8");
  await appendFile(filePath, JSON.stringify({
    v: 1, kind: "attention", id: "att-2", ts: new Date().toISOString(),
    code: "00777", viewerId: 7, viewerName: "Ира", bookable: true,
  }) + "\n", "utf8");

  const restarted = createAttentionStore({ filePath });
  await restarted.load();
  assert.equal(restarted.openCount(), 2);
  assert.ok((await readFile(filePath, "utf8")).includes("это не json"), "файл не переписываем");
});
