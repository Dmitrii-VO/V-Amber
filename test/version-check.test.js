import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdates, getUpdateStatus, parseAtomVersion } from "../server/version-check.js";

// Проверка версии на старте не была покрыта вовсе — а сравнение там своё, и
// ровно на нём легко ошибиться: «0.1.9» и «0.1.71» строкой сравниваются
// неправильно, а это как раз реальные версии проекта.
//
// Результат проверки теперь уезжает в /health и в шапку дашборда: консольную
// рамку оператор не видит (лаунчер открывает браузер поверх Терминала, логгер
// засыпает её JSON), и в бою из-за этого стояла 0.1.71 против 0.1.103.

function fetchReturning(tag, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ tag_name: tag }),
  });
}

test("свежая версия на GitHub — статус update_available", async () => {
  const result = await checkForUpdates({
    // Кеш на диск в тестах не пишем: иначе соседний тест прочитает его
    // вместо своего мока.
    useCache: false,
    localVersion: "0.1.71",
    fetchImpl: fetchReturning("v0.1.104"),
  });
  assert.equal(result.status, "update_available");
  assert.equal(result.localVersion, "0.1.71");
  assert.equal(result.remoteVersion, "0.1.104");
  assert.ok(result.instructions.length > 0, "оператору нужно сказать, что нажать");
  assert.ok(result.checkedAt, "время проверки нужно, чтобы отличать свежий ответ от старого");
});

test("сравнение числовое, а не строковое: 0.1.9 старее 0.1.71", async () => {
  const behind = await checkForUpdates({
    // Кеш на диск в тестах не пишем: иначе соседний тест прочитает его
    // вместо своего мока.
    useCache: false,
    localVersion: "0.1.9",
    fetchImpl: fetchReturning("v0.1.71"),
  });
  assert.equal(behind.status, "update_available");

  // И наоборот: строковое сравнение сказало бы, что 0.1.71 старее 0.1.9.
  const ahead = await checkForUpdates({
    // Кеш на диск в тестах не пишем: иначе соседний тест прочитает его
    // вместо своего мока.
    useCache: false,
    localVersion: "0.1.71",
    fetchImpl: fetchReturning("v0.1.9"),
  });
  assert.equal(ahead.status, "current");
});

test("та же версия — current, ничего не показываем", async () => {
  const result = await checkForUpdates({
    // Кеш на диск в тестах не пишем: иначе соседний тест прочитает его
    // вместо своего мока.
    useCache: false,
    localVersion: "0.1.104",
    fetchImpl: fetchReturning("v0.1.104"),
  });
  assert.equal(result.status, "current");
});

test("лимит GitHub отличим от «всё свежее»", async () => {
  const result = await checkForUpdates({
    // Кеш на диск в тестах не пишем: иначе соседний тест прочитает его
    // вместо своего мока.
    useCache: false,
    localVersion: "0.1.71",
    fetchImpl: fetchReturning(null, { status: 403 }),
  });
  assert.equal(result.status, "check_failed");
  assert.equal(result.reason, "http_403");
});

test("сеть упала — тоже check_failed, а не молчание", async () => {
  const result = await checkForUpdates({
    // Кеш на диск в тестах не пишем: иначе соседний тест прочитает его
    // вместо своего мока.
    useCache: false,
    localVersion: "0.1.71",
    fetchImpl: async () => { throw new Error("ENOTFOUND api.github.com"); },
  });
  assert.equal(result.status, "check_failed");
  assert.equal(result.reason, "network");
});

test("релизов нет вовсе (404) — это не сбой", async () => {
  const result = await checkForUpdates({
    // Кеш на диск в тестах не пишем: иначе соседний тест прочитает его
    // вместо своего мока.
    useCache: false,
    localVersion: "0.1.71",
    fetchImpl: fetchReturning(null, { status: 404 }),
  });
  assert.equal(result.status, "current");
  assert.equal(result.remoteVersion, null);
});

test("мусор вместо тега не превращается в «обновись»", async () => {
  const result = await checkForUpdates({
    // Кеш на диск в тестах не пишем: иначе соседний тест прочитает его
    // вместо своего мока.
    useCache: false,
    localVersion: "0.1.71",
    fetchImpl: fetchReturning("latest-nightly"),
  });
  assert.equal(result.status, "check_failed");
  assert.equal(result.reason, "remote_version_unparsable");
});

test("DISABLE_UPDATE_CHECK=1 выключает проверку и в сеть не ходит", async () => {
  process.env.DISABLE_UPDATE_CHECK = "1";
  try {
    let called = false;
    const result = await checkForUpdates({
    // Кеш на диск в тестах не пишем: иначе соседний тест прочитает его
    // вместо своего мока.
    useCache: false,
      localVersion: "0.1.71",
      fetchImpl: async () => { called = true; throw new Error("не должно вызываться"); },
    });
    assert.equal(result.status, "disabled");
    assert.equal(called, false);
  } finally {
    delete process.env.DISABLE_UPDATE_CHECK;
  }
});

test("getUpdateStatus отдаёт последний результат — его читает /health", async () => {
  await checkForUpdates({ localVersion: "0.1.71", fetchImpl: fetchReturning("v0.1.104") });
  const status = getUpdateStatus();
  assert.equal(status.status, "update_available");
  assert.equal(status.remoteVersion, "0.1.104");
  assert.ok(status.releasesUrl.includes("releases"), "ссылка нужна: по ней оператор и пойдёт");
});

// Лимит GitHub (403) — не приговор: у релизов есть публичная лента без
// лимита. 13.09.2026 бейдж на дашборде висел «обновления не проверены» на
// общем IP, хотя релиз был: 60 запросов в час на адрес кончались за день.

const ATOM = `<?xml version="1.0"?><feed>
  <entry><title>v0.1.120</title></entry>
  <entry><title>v0.1.119</title></entry>
</feed>`;

test("лента релизов читается: берём самый свежий", () => {
  assert.equal(parseAtomVersion(ATOM), "0.1.120");
  assert.equal(parseAtomVersion("<feed></feed>"), null);
  assert.equal(parseAtomVersion(""), null);
});

test("403 от API — берём версию из ленты, а не сдаёмся", async () => {
  const calls = [];
  const result = await checkForUpdates({
    useCache: false,
    localVersion: "0.1.115",
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("api.github.com")) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      return { ok: true, status: 200, text: async () => ATOM };
    },
  });

  assert.equal(result.status, "update_available");
  assert.equal(result.remoteVersion, "0.1.120");
  assert.match(calls[1], /releases\.atom$/);
});

test("403 и лента недоступна — честное «проверить не удалось»", async () => {
  const result = await checkForUpdates({
    useCache: false,
    localVersion: "0.1.115",
    fetchImpl: async (url) => (String(url).includes("api.github.com")
      ? { ok: false, status: 403, json: async () => ({}) }
      : { ok: false, status: 500, text: async () => "" }),
  });

  assert.equal(result.status, "check_failed");
  assert.equal(result.reason, "http_403");
});
