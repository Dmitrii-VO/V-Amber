import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNameCacheStore } from "../server/name-cache-store.js";

async function withTempFile(fn) {
  const dir = await mkdtemp(join(tmpdir(), "name-cache-"));
  const filePath = join(dir, "viewer-names.jsonl");
  try {
    await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("remember + getName round-trips in memory", async () => {
  await withTempFile(async (filePath) => {
    const store = createNameCacheStore({ filePath });
    store.remember(123, "Галина Прокофьева");
    assert.equal(store.getName(123), "Галина Прокофьева");
    assert.equal(store.getName("123"), "Галина Прокофьева"); // string key works
    await store.flush();
  });
});

test("persists across restarts (load folds JSONL)", async () => {
  await withTempFile(async (filePath) => {
    const a = createNameCacheStore({ filePath });
    a.remember(1, "Иван Петров");
    a.remember(2, "Анна Сидорова");
    await a.flush();

    const b = createNameCacheStore({ filePath });
    await b.load();
    assert.equal(b.getName(1), "Иван Петров");
    assert.equal(b.getName(2), "Анна Сидорова");
    assert.equal(b.size(), 2);
  });
});

test("latest name wins on reload", async () => {
  await withTempFile(async (filePath) => {
    const a = createNameCacheStore({ filePath });
    a.remember(1, "Старое Имя");
    a.remember(1, "Новое Имя");
    await a.flush();

    const b = createNameCacheStore({ filePath });
    await b.load();
    assert.equal(b.getName(1), "Новое Имя");
    assert.equal(b.size(), 1);
  });
});

test("remember is a no-op for unchanged name (no duplicate lines)", async () => {
  await withTempFile(async (filePath) => {
    const store = createNameCacheStore({ filePath });
    store.remember(1, "Иван Петров");
    store.remember(1, "Иван Петров");
    store.remember(1, "Иван Петров");
    await store.flush();
    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
  });
});

test("remember ignores empty name / null viewerId", async () => {
  await withTempFile(async (filePath) => {
    const store = createNameCacheStore({ filePath });
    store.remember(1, "");
    store.remember(null, "Имя");
    await store.flush();
    assert.equal(store.size(), 0);
  });
});

test("list() returns all or a filtered subset", async () => {
  await withTempFile(async (filePath) => {
    const store = createNameCacheStore({ filePath });
    store.remember(1, "Иван Петров");
    store.remember(2, "Анна Сидорова");
    store.remember(3, "Галина Прокофьева");
    assert.equal(store.list().length, 3);
    const subset = store.list([1, 3]);
    assert.deepEqual(subset.map((e) => e.viewerId).sort(), [1, 3]);
    // Без flush фоновые append-ы гонятся с rm() темп-папки в withTempFile
    // и роняют тест ENOTEMPTY (файл пересоздаётся между unlink и rmdir).
    await store.flush();
  });
});

test("getName returns null for unknown viewer", async () => {
  await withTempFile(async (filePath) => {
    const store = createNameCacheStore({ filePath });
    assert.equal(store.getName(999), null);
  });
});

test("load on a missing file is safe", async () => {
  await withTempFile(async (filePath) => {
    const store = createNameCacheStore({ filePath });
    await store.load();
    assert.equal(store.size(), 0);
  });
});
