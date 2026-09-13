import test from "node:test";
import assert from "node:assert/strict";

import { isOwnInstanceOnPort, looksLikeVAmber, nextPortCandidates } from "../server/port-fallback.js";

// Занятый порт: своя вторая копия и чужое приложение требуют противоположных
// действий. Рядом со своей копией подниматься нельзя (два эфира, двойные
// публикации в ВК), чужому приложению порт надо уступить — 13.09.2026 8080
// занял веб-интерфейс qBittorrent, и оператор получил бы чужую страницу
// вместо дашборда.

test("свою страницу узнаём и по входу, и по дашборду", () => {
  assert.equal(looksLikeVAmber("<title>Вход — V-Amber</title>"), true);
  assert.equal(looksLikeVAmber("<title>Amberry Voice — Operator Console</title>"), true);
});

test("чужое приложение своим не считаем", () => {
  assert.equal(looksLikeVAmber("<title>qBittorrent v5.2.3 Веб-интерфейс</title>"), false);
  assert.equal(looksLikeVAmber(""), false);
  assert.equal(looksLikeVAmber(null), false);
});

test("кандидаты идут подряд — адрес остаётся предсказуемым", () => {
  assert.deepEqual(nextPortCandidates(8080, 3), [8081, 8082, 8083]);
  assert.deepEqual(nextPortCandidates(65534, 5), [65535]);
  assert.deepEqual(nextPortCandidates(0), []);
  assert.deepEqual(nextPortCandidates("нет порта"), []);
});

test("порт отвечает нашей страницей — это своя копия", async () => {
  const own = await isOwnInstanceOnPort(8080, {
    fetchImpl: async () => ({ async text() { return "<title>Вход — V-Amber</title>"; } }),
  });
  assert.equal(own, true);
});

test("порт отвечает чужим — уступаем", async () => {
  const own = await isOwnInstanceOnPort(8080, {
    fetchImpl: async () => ({ async text() { return "qBittorrent"; } }),
  });
  assert.equal(own, false);
});

test("порт молчит — считаем чужим: своя копия ответила бы", async () => {
  const own = await isOwnInstanceOnPort(8080, {
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(own, false);
});
