import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startHarness, createChatClientMock } from "./helpers/ws-harness.js";

// Список write-методов VK, которые server/index.js оборачивает safe-mode.
const SAFE_MODE_WRAPPED_VK_METHODS = readFileSync(new URL("../server/index.js", import.meta.url), "utf8")
  .match(/\["publishLotCard"[^\]]*\]/)[0]
  .match(/"([a-zA-Z]+)"/g)
  .map((s) => s.replaceAll('"', ""));

// Периодическая инструкция зрителям: как бронировать и как отменять. Зрители
// подключаются к эфиру в разное время, и половина зала формат брони не видела.
// Идёт одновременно в VK-комментарии и в чат /efir/ — это разные аудитории.

const VARIANTS = ["инструкция раз", "инструкция два", "инструкция три"];

// Интервалы в минутах — в тестах доли минуты, чтобы не ждать полчаса.
const fastConfig = (overrides = {}) => ({
  viewerInstructions: {
    enabled: true,
    firstDelayMinutes: 0,
    intervalMinutes: 0.005, // 300 мс
    variants: VARIANTS,
    ...overrides,
  },
});

async function startStream(harness, client) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
}

test("инструкция уходит и в VK, и в чат /efir/", async () => {
  const chatClient = createChatClientMock();
  const harness = await startHarness({ chatClient, config: fastConfig() });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    await new Promise((r) => setTimeout(r, 200));

    const posted = harness.vk.callsTo("publishViewerInstruction");
    assert.ok(posted.length >= 1, "инструкция должна уйти в VK");
    assert.equal(posted[0].args[0], VARIANTS[0]);
    assert.ok(chatClient.serviceMessages.includes(VARIANTS[0]), "инструкция должна уйти в чат");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("тексты чередуются — VK режет одинаковые комментарии подряд", async () => {
  const harness = await startHarness({ config: fastConfig() });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    await new Promise((r) => setTimeout(r, 1000));

    const texts = harness.vk.callsTo("publishViewerInstruction").map((c) => c.args[0]);
    assert.ok(texts.length >= 2, `ожидали минимум две публикации, было ${texts.length}`);
    assert.notEqual(texts[0], texts[1], "два подряд одинаковых текста VK сочтёт спамом");
    assert.equal(texts[1], VARIANTS[1]);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("выключенная настройка не публикует ничего", async () => {
  const harness = await startHarness({ config: fastConfig({ enabled: false }) });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(harness.vk.callsTo("publishViewerInstruction").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("после конца эфира инструкции прекращаются", async () => {
  const harness = await startHarness({ config: fastConfig() });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    await new Promise((r) => setTimeout(r, 400));
    const before = harness.vk.callsTo("publishViewerInstruction").length;
    assert.ok(before >= 1);

    client.send({ type: "stop" });
    await new Promise((r) => setTimeout(r, 800));

    const after = harness.vk.callsTo("publishViewerInstruction").length;
    assert.equal(after, before, "после остановки эфира публиковать нечего");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("публикация идёт через vk.publishViewerInstruction — метод из safe-mode списка", () => {
  // Сам safe-mode проверять здесь нечем: vk в харнессе не обёрнут
  // wrapWithSafeMode. Тест фиксирует имя метода, по которому обёртка в
  // server/index.js и находит эту публикацию: переименуют метод там — упадёт тут.
  assert.ok(SAFE_MODE_WRAPPED_VK_METHODS.includes("publishViewerInstruction"));
});
