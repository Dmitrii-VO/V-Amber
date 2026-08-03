import { test } from "node:test";
import assert from "node:assert/strict";
import { createCrossPromoPublisher, renderPromoText } from "../server/cross-promo.js";

// Перекрёстные подсказки между площадками. Главное, что проверяем: НИКОГДА не
// зовём на площадку, которая не в эфире, — мёртвая ссылка хуже молчания.

const silentLog = { info() {}, warn() {}, error() {} };
const VK_URL = "https://vk.com/video-123_456";
const VIEWER_URL = "https://example.test/efir/";

function makeConfig(overrides = {}) {
  return {
    stream: { viewerUrl: VIEWER_URL },
    crossPromo: {
      enabled: true,
      intervalMinutes: 25,
      probeIntervalMinutes: 5,
      firstDelayMinutes: 12,
      vkVariants: ["ВК-1 {url}", "ВК-2 {url}"],
      chatVariants: ["Чат-1", "Чат-2"],
      ...overrides,
    },
  };
}

function makeVk({ live = true, url = VK_URL, throws = false } = {}) {
  const promos = [];
  return {
    promos,
    getLiveVideoUrl: () => url,
    async validateLiveVideoUrl() {
      if (throws) throw new Error("vk down");
      return { ok: true, isLive: live };
    },
    async publishCrossPromo(message) {
      promos.push(message);
      return { ok: true };
    },
  };
}

function makeChat() {
  const states = [];
  const messages = [];
  return {
    enabled: true,
    states,
    messages,
    async publishBroadcastState(state) {
      states.push(state);
      return { ok: true };
    },
    async postServiceMessage(text) {
      messages.push(text);
      return { ok: true };
    },
  };
}

// Такт публикует сообщения, только если с прошлого раза прошёл интервал;
// в тестах интервал обнуляем, чтобы каждый tick был «боевым».
function makePublisher(parts = {}) {
  const config = parts.config || makeConfig();
  const vk = parts.vk || makeVk();
  const chatClient = parts.chatClient || makeChat();
  const publisher = createCrossPromoPublisher({
    config,
    vk,
    chatClient,
    getStreamStatus: parts.getStreamStatus || (async () => ({ live: true })),
    logger: silentLog,
  });
  return { publisher, vk, chatClient };
}

test("renderPromoText подставляет ссылку", () => {
  assert.equal(renderPromoText("Смотрите тут: {url}", "https://x.test"), "Смотрите тут: https://x.test");
  assert.equal(renderPromoText("без ссылки", ""), "без ссылки");
});

test("обе площадки в эфире — сообщения уходят в оба канала с правильными ссылками", async () => {
  const { publisher, vk, chatClient } = makePublisher();
  await publisher.tickForTests();

  assert.equal(vk.promos.length, 1);
  assert.ok(vk.promos[0].includes(VIEWER_URL), "в ВК зовём на свою площадку");
  assert.equal(chatClient.messages.length, 1);
  assert.ok(!chatClient.messages[0].includes("http"), "в чат ссылку текстом не шлём — она в плашке");
  assert.deepEqual(chatClient.states.at(-1), { vkMirrorUrl: VK_URL });
});

test("ВК не в эфире — ни сообщений, ни плашки", async () => {
  const { publisher, vk, chatClient } = makePublisher({ vk: makeVk({ live: false }) });
  await publisher.tickForTests();

  assert.equal(vk.promos.length, 0);
  assert.equal(chatClient.messages.length, 0);
  assert.deepEqual(chatClient.states.at(-1), { vkMirrorUrl: "" });
});

test("своя площадка не в эфире — в ВК не зовём, но плашку про ВК показываем", async () => {
  const { publisher, vk, chatClient } = makePublisher({ getStreamStatus: async () => ({ live: false }) });
  await publisher.tickForTests();

  assert.equal(vk.promos.length, 0, "звать на страницу с чёрным экраном нельзя");
  assert.equal(chatClient.messages.length, 0);
  // Плашка не вредна: если кто-то всё же открыл страницу, ссылка в ВК рабочая.
  assert.deepEqual(chatClient.states.at(-1), { vkMirrorUrl: VK_URL });
});

test("проба ВК упала — считаем, что не в эфире, и молчим", async () => {
  const { publisher, vk, chatClient } = makePublisher({ vk: makeVk({ throws: true }) });
  await publisher.tickForTests();

  assert.equal(vk.promos.length, 0);
  assert.equal(chatClient.messages.length, 0);
  assert.deepEqual(chatClient.states.at(-1), { vkMirrorUrl: "" });
});

test("проба своей площадки упала — в ВК не публикуем", async () => {
  const { publisher, vk } = makePublisher({
    getStreamStatus: async () => { throw new Error("mediamtx down"); },
  });
  await publisher.tickForTests();
  assert.equal(vk.promos.length, 0);
});

test("варианты текста чередуются — ВК режет одинаковые подряд комментарии", async () => {
  const { publisher, vk, chatClient } = makePublisher();
  await publisher.tickForTests({ forceMessages: true });
  await publisher.tickForTests({ forceMessages: true });

  assert.equal(vk.promos.length, 2);
  assert.notEqual(vk.promos[0], vk.promos[1]);
  assert.notEqual(chatClient.messages[0], chatClient.messages[1]);
});

test("сообщения не чаще интервала, а плашка обновляется каждым тактом", async () => {
  const config = makeConfig({ intervalMinutes: 60 });
  const { publisher, vk, chatClient } = makePublisher({ config });

  await publisher.tickForTests();
  await publisher.tickForTests();
  await publisher.tickForTests();

  assert.equal(vk.promos.length, 1, "второй и третий такт — только проба, без спама");
  assert.equal(chatClient.states.length, 3);
});

test("stop снимает плашку у зрителей", async () => {
  const { publisher, chatClient } = makePublisher();
  await publisher.tickForTests();
  publisher.stop();
  await new Promise((r) => setTimeout(r, 5));

  assert.deepEqual(chatClient.states.at(-1), { vkMirrorUrl: "" });
});

test("выключенный CROSS_PROMO не стартует", async () => {
  const config = makeConfig({ enabled: false });
  const { publisher, vk, chatClient } = makePublisher({ config });
  publisher.start();
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(publisher.enabled, false);
  assert.equal(vk.promos.length, 0);
  assert.equal(chatClient.states.length, 0);
});

test("без STREAM_VIEWER_URL в ВК не зовём — звать некуда", async () => {
  const config = makeConfig();
  config.stream.viewerUrl = "";
  const { publisher, vk } = makePublisher({ config });
  await publisher.tickForTests();
  assert.equal(vk.promos.length, 0);
});
