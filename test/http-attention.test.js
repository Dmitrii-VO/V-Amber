import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttentionStore } from "../server/attention-store.js";

// http-server тянет server/config.js, а тот падает без YANDEX_SPEECHKIT_API_KEY.
// В CI (ci.yml) эта переменная задаётся только докер-шагу, у `npm test` её нет,
// поэтому обычный статический импорт зелен локально (.env) и красен на CI.
// Ставим фиктивное значение и импортируем динамически — статические импорты
// поднимаются наверх и выполнились бы РАНЬШЕ присваивания.
process.env.YANDEX_SPEECHKIT_API_KEY ||= "test";
const { createStaticServer } = await import("../server/http-server.js");

// HTTP-поверхность разбора после эфира: список строк и снятие строки без
// брони. Саму бронь этот путь не создаёт — она идёт по WS тем же денежным
// путём, что и живой баннер (reserveFromAttention), чтобы не заводить вторую
// точку записи в МойСклад.

// Тот же config.js через dotenv вливает .env — если у разработчика задан
// API_TOKEN, все /api/* ответят 401. Поэтому подставляем тот же токен в
// заголовок; на CI он не задан и заголовка просто не будет.
const AUTH_HEADERS = process.env.API_TOKEN?.trim()
  ? { "x-api-token": process.env.API_TOKEN.trim() }
  : {};

async function startServer(attentionStore) {
  const server = createStaticServer({ attentionStore, config: {}, packageVersion: "test" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "attention-http-"));
  const store = createAttentionStore({ filePath: join(dir, "attention.jsonl") });
  await store.load();
  return store;
}

const ROW = {
  code: "00777", viewerId: 5001, viewerName: "Аня", commentId: 401,
  text: "бронь 777", quantity: 1, source: "vk", reason: "no_open_lot", bookable: true,
};

test("GET /api/attention отдаёт открытые строки и их число", async () => {
  const store = await freshStore();
  store.add(ROW);
  const server = await startServer(store);
  try {
    const response = await fetch(server.url("/api/attention"), { headers: AUTH_HEADERS });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.openCount, 1);
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].code, "00777");
    assert.equal(data.rows[0].bookable, true);
  } finally {
    await server.close();
  }
});

test("POST /api/attention/dismiss снимает строку без брони", async () => {
  const store = await freshStore();
  const id = store.add(ROW);
  const server = await startServer(store);
  try {
    const response = await fetch(server.url("/api/attention/dismiss"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ id }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).openCount, 0);
    assert.equal(store.get(id), null);

    // Повтор — строка уже разобрана, а не «ошибка сервера».
    const again = await fetch(server.url("/api/attention/dismiss"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ id }),
    });
    assert.equal(again.status, 404);
  } finally {
    await server.close();
  }
});

test("dismiss без id — 400, а не молчаливое ничего", async () => {
  const server = await startServer(await freshStore());
  try {
    const response = await fetch(server.url("/api/attention/dismiss"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "id_required");
  } finally {
    await server.close();
  }
});

test("разобранные строки видны только по запросу all=1", async () => {
  const store = await freshStore();
  const id = store.add(ROW);
  store.resolve(id, { status: "reserved" });
  const server = await startServer(store);
  try {
    assert.equal((await (await fetch(server.url("/api/attention"), { headers: AUTH_HEADERS })).json()).rows.length, 0);
    const all = await (await fetch(server.url("/api/attention?all=1"), { headers: AUTH_HEADERS })).json();
    assert.equal(all.rows.length, 1);
    assert.equal(all.rows[0].status, "reserved");
  } finally {
    await server.close();
  }
});
