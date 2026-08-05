import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProductCodeCache, deriveCodeLengthBounds } from "../server/product-code-cache.js";

async function withTempCache(run) {
  const dir = await mkdtemp(join(tmpdir(), "product-code-cache-"));
  const filePath = join(dir, "product-code-cache.json");
  try {
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Слепок реального каталога: 2407 товаров, коды длиной 2, 3, 5 и 6 знаков.
const CATALOG = new Map([
  ["03", { id: "p1", name: "Заколка", supplierId: "s1" }],
  ["017", { id: "p2", name: "Браслет", supplierId: "s1" }],
  ["03204", { id: "p3", name: "Серьги", supplierId: "s2" }],
  ["034135", { id: "p4", name: "Бусы", supplierId: null }],
]);

function makeMoysklad(result) {
  return {
    calls: 0,
    async getProductsBulk() {
      this.calls += 1;
      if (result instanceof Error) throw result;
      return typeof result === "function" ? result() : result;
    },
  };
}

test("границы длины считаются по каталогу, нижняя — без ведущих нулей", () => {
  assert.deepEqual(deriveCodeLengthBounds(CATALOG.keys()), { min: 1, max: 6 });
  assert.deepEqual(deriveCodeLengthBounds(["00588", "03204"]), { min: 3, max: 5 });
  assert.equal(deriveCodeLengthBounds([]), null);
});

test("каталог сохраняется на диск и поднимается на следующем старте", async () => {
  await withTempCache(async (filePath) => {
    const first = createProductCodeCache({ filePath });
    await first.refresh(makeMoysklad(CATALOG));
    assert.equal(first.getSnapshot().count, 4);

    // Новый процесс, МойСклад лежит.
    const second = createProductCodeCache({ filePath });
    assert.equal(second.getCodes().size, 0, "до loadFromDisk кэш пуст");
    await second.loadFromDisk();

    assert.equal(second.getCodes().size, 4, "каталожный гейт должен работать и без МойСклада");
    assert.equal(second.getSnapshot().fromDisk, true);
    assert.deepEqual(second.getCodeLengthBounds(), { min: 1, max: 6 });
    assert.equal(second.getProductByCode("03204").name, "Серьги");
  });
});

test("живой рефреш вытесняет дисковый каталог", async () => {
  await withTempCache(async (filePath) => {
    await createProductCodeCache({ filePath }).refresh(makeMoysklad(CATALOG));

    const cache = createProductCodeCache({ filePath });
    await cache.loadFromDisk();
    assert.equal(cache.getSnapshot().fromDisk, true);

    await cache.refresh(makeMoysklad(new Map([["00777", { id: "p9", name: "Кулон" }]])));
    assert.equal(cache.getSnapshot().fromDisk, false);
    assert.deepEqual([...cache.getCodes()], ["00777"]);
  });
});

test("пустой ответ МойСклада не затирает уже загруженный каталог", async () => {
  await withTempCache(async (filePath) => {
    const cache = createProductCodeCache({ filePath });
    await cache.refresh(makeMoysklad(CATALOG));

    await cache.refresh(makeMoysklad(new Map()));

    assert.equal(cache.getCodes().size, 4, "пустой каталог открыл бы гейт для любого кода");
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.products.length, 4, "на диск пустота тоже не попадает");
  });
});

test("упавший рефреш оставляет дисковый каталог в силе", async () => {
  await withTempCache(async (filePath) => {
    await createProductCodeCache({ filePath }).refresh(makeMoysklad(CATALOG));

    const cache = createProductCodeCache({ filePath });
    await cache.loadFromDisk();
    await assert.rejects(() => cache.refresh(makeMoysklad(new Error("MoySklad HTTP 500"))));

    assert.equal(cache.getCodes().size, 4);
    assert.match(cache.getSnapshot().lastError, /500/);
  });
});

test("битый файл кэша не роняет старт", async () => {
  await withTempCache(async (filePath) => {
    await writeFile(filePath, "{ не json", "utf8");
    const cache = createProductCodeCache({ filePath });
    const snapshot = await cache.loadFromDisk();
    assert.equal(snapshot.count, 0);
    assert.equal(cache.getCodeLengthBounds(), null, "без каталога границы берутся из .env");
  });
});

test("отсутствующий файл — это не ошибка", async () => {
  await withTempCache(async (filePath) => {
    const cache = createProductCodeCache({ filePath });
    const snapshot = await cache.loadFromDisk();
    assert.equal(snapshot.count, 0);
  });
});
