import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/ws-harness.js";

// Каталог подтверждает два прочтения одной фразы — «ноль три» и «ноль три сто
// двадцать четыре». Раньше система молча брала короткое и публиковала в VK
// карточку постороннего товара (15 таких лотов за три месяца). Спецификация
// 4.1 пункт 4 требует показать выбор оператору и не открывать лот самому.
//
// Цена и скидка из того же транскрипта при этом уходят в карантин: применить
// их к предыдущему лоту нельзя — фраза про другой товар.
const CARDS = {
  "03": { id: "p-03", name: "Заколка", code: "03", salePrice: 0, availableStock: 3 },
  "03124": { id: "p-03124", name: "Браслет стальной", code: "03124", salePrice: 0, availableStock: 3 },
  "03900": { id: "p-03900", name: "Бусы", code: "03900", salePrice: 0, availableStock: 3 },
};
const KNOWN = ["03", "03124", "03900"];

async function startStream(harness, client) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
}

function say(harness, text) {
  harness.getLastSpeechKitSession().handlers.onFinal({ text, latencyMs: 10 });
}

test("спорный артикул не открывает лот, а уходит оператору на выбор", async () => {
  const harness = await startHarness({ cardsByCode: CARDS, knownCodes: KNOWN });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    say(harness, "артикул ноль три сто двадцать четыре");

    const message = await client.waitFor((m) => m.type === "articleAmbiguous", { timeoutMs: 6000 });
    assert.deepEqual(message.candidates.map((c) => c.code).sort(), ["03", "03124"]);
    assert.equal(harness.vk.callsTo("publishLotCard").length, 0, "карточка в VK уйти не должна");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("выбор кандидата открывает именно выбранный лот", async () => {
  const harness = await startHarness({ cardsByCode: CARDS, knownCodes: KNOWN });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    say(harness, "артикул ноль три сто двадцать четыре");
    const message = await client.waitFor((m) => m.type === "articleAmbiguous", { timeoutMs: 6000 });

    client.send({ type: "confirmArticleCandidate", detectionId: message.detectionId, code: "03124" });
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.code === "03124",
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.product.name, "Браслет стальной");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("цена из спорной фразы не трогает предыдущий лот, а ждёт выбора", async () => {
  const harness = await startHarness({ cardsByCode: CARDS, knownCodes: KNOWN });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    client.send({ type: "manualCode", code: "03900" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03900");

    say(harness, "артикул ноль три сто двадцать четыре стоимость восемь тысяч восемьсот");
    const message = await client.waitFor((m) => m.type === "articleAmbiguous", { timeoutMs: 6000 });
    assert.equal(message.heldPrice, 8800);

    // Предыдущий лот не тронут: ни цены, ни подсказки на нём быть не должно.
    const held = await client.waitFor((m) => m.type === "state", { timeoutMs: 6000 });
    assert.equal(held.activeLot.code, "03900");
    assert.equal(held.activeLot.product.voicePrice, null);
    assert.equal(held.activeLot.voiceSuggestions.length, 0);
    assert.equal(held.lastDetection.heldPrice, 8800);

    client.send({ type: "confirmArticleCandidate", detectionId: message.detectionId, code: "03124" });
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.code === "03124",
      { timeoutMs: 6000 },
    );
    // Цена привязалась к созданному лоту, а не к тому, что был активным.
    assert.equal(state.activeLot.product.voicePrice, 8800);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("устаревший выбор отвергается и лот не открывает", async () => {
  const harness = await startHarness({ cardsByCode: CARDS, knownCodes: KNOWN });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    say(harness, "артикул ноль три сто двадцать четыре");
    const message = await client.waitFor((m) => m.type === "articleAmbiguous", { timeoutMs: 6000 });

    // Оператор пошёл дальше — ввёл код руками. Кнопка из прошлого
    // распознавания больше не действует.
    client.send({ type: "manualCode", code: "03900" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03900", { timeoutMs: 6000 });

    client.send({ type: "confirmArticleCandidate", detectionId: message.detectionId, code: "03124" });
    const warning = await client.waitFor(
      (m) => m.type === "warning" && /устарел/.test(m.message || ""),
      { timeoutMs: 6000 },
    );
    assert.ok(warning);
    assert.equal(harness.vk.callsTo("publishLotCard").filter((c) => c.args[0]?.code === "03124").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("код вне списка кандидатов не принимается", async () => {
  const harness = await startHarness({ cardsByCode: CARDS, knownCodes: KNOWN });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    say(harness, "артикул ноль три сто двадцать четыре");
    const message = await client.waitFor((m) => m.type === "articleAmbiguous", { timeoutMs: 6000 });

    client.send({ type: "confirmArticleCandidate", detectionId: message.detectionId, code: "03900" });
    await client.waitFor((m) => m.type === "warning" && /устарел/.test(m.message || ""), { timeoutMs: 6000 });
    assert.equal(harness.vk.callsTo("publishLotCard").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("выбор уже активного кандидата применяет удержанную скидку", async () => {
  const cards = {
    ...CARDS,
    "03": { ...CARDS["03"], salePrice: 1000 },
  };
  const harness = await startHarness({ cardsByCode: cards, knownCodes: KNOWN });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    client.send({ type: "manualCode", code: "03" });
    const opened = await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03");
    say(harness, "скидка пять процентов");
    await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.discountAmount === 50,
      { timeoutMs: 6000 },
    );

    say(harness, "артикул ноль три сто двадцать четыре скидка десять процентов");
    const message = await client.waitFor((m) => m.type === "articleAmbiguous", { timeoutMs: 6000 });
    client.send({ type: "confirmArticleCandidate", detectionId: message.detectionId, code: "03" });

    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.code === "03" && m.activeLot?.discountAmount === 100,
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.lotSessionId, opened.activeLot.lotSessionId);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("без каталога кнопки выбора остаются рабочими", async () => {
  // Каталог не поднялся (ночь 15.08 — девять подряд ENOTFOUND
  // api.moysklad.ru). Подтверждённых кандидатов нет ни одного, и фильтр
  // «только knownCode» оставлял пустой список принимаемых кодов, хотя кнопки
  // в панели рисовались. Клик отвечал «Выбор устарел» — неправда.
  const harness = await startHarness({ cardsByCode: CARDS, knownCodes: [] });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    say(harness, "код товара 03124 03900");

    const message = await client.waitFor((m) => m.type === "articleAmbiguous", { timeoutMs: 6000 });
    assert.deepEqual(message.candidates.map((c) => c.code).sort(), ["03124", "03900"]);

    client.send({ type: "confirmArticleCandidate", detectionId: message.detectionId, code: "03124" });
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.code === "03124",
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.code, "03124");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("с каталогом в панель не попадает код, который сервер не примет", async () => {
  const harness = await startHarness({ cardsByCode: CARDS, knownCodes: KNOWN });
  const client = await harness.connect();
  try {
    await startStream(harness, client);
    say(harness, "артикул ноль три сто двадцать четыре");
    const message = await client.waitFor((m) => m.type === "articleAmbiguous", { timeoutMs: 6000 });

    const state = await client.waitFor(
      (m) => m.type === "state" && m.lastDetection?.status === "ambiguous",
      { timeoutMs: 6000 },
    );
    // Список для отрисовки и список принимаемых сервером кодов — один и тот же.
    assert.deepEqual(
      (state.lastDetection.candidates || []).map((c) => c.code).sort(),
      message.candidates.map((c) => c.code).sort(),
    );
  } finally {
    await client.close();
    await harness.close();
  }
});
