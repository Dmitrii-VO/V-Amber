import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBlockedViewersStore } from "../server/blocked-viewers-store.js";

async function withTempStore(run) {
  const dir = await mkdtemp(join(tmpdir(), "blocked-viewers-"));
  const filePath = join(dir, "blocked-viewers.jsonl");
  try {
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("блокировка переживает рестарт процесса", async () => {
  await withTempStore(async (filePath) => {
    const first = createBlockedViewersStore({ filePath });
    await first.load();
    first.block(5001, { name: "Спамер", reason: "реклама" });
    await first.flush();

    const second = createBlockedViewersStore({ filePath });
    await second.load();
    assert.equal(second.isBlocked(5001), true);
    assert.equal(second.get(5001).name, "Спамер");
    assert.equal(second.get(5001).reason, "реклама");
  });
});

test("разблокировка снимает блокировку и тоже переживает рестарт", async () => {
  await withTempStore(async (filePath) => {
    const first = createBlockedViewersStore({ filePath });
    await first.load();
    first.block(5001, { name: "Спамер" });
    assert.equal(first.unblock(5001), true);
    assert.equal(first.isBlocked(5001), false);
    await first.flush();

    const second = createBlockedViewersStore({ filePath });
    await second.load();
    assert.equal(second.isBlocked(5001), false);
    assert.equal(second.size(), 0);
  });
});

test("viewerId сравнивается по строке: число и строка — один зритель", async () => {
  await withTempStore(async (filePath) => {
    const store = createBlockedViewersStore({ filePath });
    await store.load();
    store.block("5001", { name: "Спамер" });
    // VK отдаёт from_id числом, чат — строкой; путать их нельзя.
    assert.equal(store.isBlocked(5001), true);
    assert.equal(store.unblock(5001), true);
    assert.equal(store.isBlocked("5001"), false);
    // Дожидаемся записи до удаления temp-каталога — иначе отложенный append
    // падает с ENOENT (гонка cleanup'а).
    await store.flush();
  });
});

test("повторная блокировка не сдвигает blockedAt, но обновляет причину", async () => {
  await withTempStore(async (filePath) => {
    const store = createBlockedViewersStore({ filePath });
    await store.load();
    const first = store.block(5001, { name: "Спамер", reason: "реклама" });
    const second = store.block(5001, { reason: "мат" });
    assert.equal(second.blockedAt, first.blockedAt);
    assert.equal(second.reason, "мат");
    // Имя не теряется, если во второй раз его не передали.
    assert.equal(second.name, "Спамер");
    assert.equal(store.size(), 1);
    await store.flush();
  });
});

test("unblock несуществующего зрителя возвращает false и не пишет в файл", async () => {
  await withTempStore(async (filePath) => {
    const store = createBlockedViewersStore({ filePath });
    await store.load();
    assert.equal(store.unblock(9999), false);
    await store.flush();
    const written = await readFile(filePath, "utf8").catch(() => "");
    assert.equal(written, "");
  });
});

test("битая строка в файле не роняет load", async () => {
  await withTempStore(async (filePath) => {
    const store = createBlockedViewersStore({ filePath });
    await store.load();
    store.block(5001, { name: "Спамер" });
    await store.flush();

    const { appendFile } = await import("node:fs/promises");
    await appendFile(filePath, "{ это не json\n", "utf8");

    const reloaded = createBlockedViewersStore({ filePath });
    await reloaded.load();
    assert.equal(reloaded.isBlocked(5001), true);
  });
});
