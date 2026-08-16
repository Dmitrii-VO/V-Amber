import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/ws-harness.js";

// Окно голосовой правки. Эфир 2026-08-15, лот 03048: первая цена (8800 ₽)
// верная, дальше девять минут посторонних чисел переписывали её одна за
// другой — «жара стоит двадцать восемь», «крем тысяча двести», цены Озона.
// Теперь после первой применённой цены голос только предлагает.
//
// Карточка без цены в МойСкладе — иначе голосовую цену отсекает более
// ранний guard hasUsableSalePrice.
const CARD = {
  id: "p-03048", name: "Бусы «Галька»", code: "03048",
  pathName: "Украшения/Бусы", salePrice: 0, availableStock: 5,
};

async function openLot(harness, client) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code: "03048" });
  return client.waitFor((m) => m.type === "state" && m.activeLot);
}

function say(harness, text) {
  harness.getLastSpeechKitSession().handlers.onFinal({ text, latencyMs: 10 });
}

test("первая цена применяется, вторая становится подсказкой", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);

    say(harness, "стоимость восемь тысяч восемьсот");
    await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.voicePrice === 8800,
      { timeoutMs: 6000 },
    );

    say(harness, "озон поставил сейчас цену шестьсот сорок четыре рубля а нам возмещает разницу");
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.voiceSuggestions?.length === 1,
      { timeoutMs: 6000 },
    );

    assert.equal(state.activeLot.product.voicePrice, 8800, "цена лота меняться не должна");
    const suggestion = state.activeLot.voiceSuggestions[0];
    assert.equal(suggestion.kind, "price");
    assert.equal(suggestion.value, 644);
    assert.equal(suggestion.lotSessionId, state.activeLot.lotSessionId);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("скидка после первой цены применяется — у неё отдельный гейт", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);

    say(harness, "стоимость восемь тысяч восемьсот");
    await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.voicePrice === 8800,
      { timeoutMs: 6000 },
    );

    // 5 % от 8800 = 440 ₽. Закрытый ценовой гейт скидку блокировать не должен.
    say(harness, "скидка пять процентов");
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.discountAmount > 0,
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.discountAmount, 440);
    assert.equal(state.activeLot.voiceSuggestions.length, 0);

    // А вот вторая скидка — уже подсказка.
    say(harness, "скидка десять процентов");
    const next = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.voiceSuggestions?.length === 1,
      { timeoutMs: 6000 },
    );
    assert.equal(next.activeLot.discountAmount, 440);
    assert.equal(next.activeLot.voiceSuggestions[0].kind, "discount");
  } finally {
    await client.close();
    await harness.close();
  }
});

test("оператор принимает подсказку — цена меняется, подсказка исчезает", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);
    say(harness, "стоимость восемь тысяч восемьсот");
    await client.waitFor((m) => m.type === "state" && m.activeLot?.product?.voicePrice === 8800, { timeoutMs: 6000 });
    say(harness, "цена шестьсот пятьдесят рублей");
    const withSuggestion = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.voiceSuggestions?.length === 1,
      { timeoutMs: 6000 },
    );

    client.send({
      type: "applyVoiceSuggestion",
      suggestionId: withSuggestion.activeLot.voiceSuggestions[0].id,
    });
    const applied = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.voicePrice === 650,
      { timeoutMs: 6000 },
    );
    assert.equal(applied.activeLot.voiceSuggestions.length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("подсказку можно отклонить, лот при этом не меняется", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);
    say(harness, "стоимость восемь тысяч восемьсот");
    await client.waitFor((m) => m.type === "state" && m.activeLot?.product?.voicePrice === 8800, { timeoutMs: 6000 });
    say(harness, "цена шестьсот пятьдесят рублей");
    const withSuggestion = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.voiceSuggestions?.length === 1,
      { timeoutMs: 6000 },
    );

    client.send({
      type: "dismissVoiceSuggestion",
      suggestionId: withSuggestion.activeLot.voiceSuggestions[0].id,
    });
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.voiceSuggestions?.length === 0,
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.product.voicePrice, 8800);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("повторный артикул того же лота окно не открывает", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    await openLot(harness, client);
    say(harness, "стоимость восемь тысяч восемьсот");
    const first = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.voicePrice === 8800,
      { timeoutMs: 6000 },
    );
    const lotSessionId = first.activeLot.lotSessionId;

    // Тот же код + другая цена в одном транскрипте: sticky-лот сохраняется,
    // а цена обязана уйти в подсказку.
    say(harness, "код товара 03048 цена шестьсот пятьдесят рублей");
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.voiceSuggestions?.length === 1,
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.lotSessionId, lotSessionId, "лот должен остаться тем же");
    assert.equal(state.activeLot.product.voicePrice, 8800);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("повторный артикул с первой ценой проигрывает ожидающую бронь", async () => {
  const harness = await startHarness({ cardsByCode: { "03048": CARD }, knownCodes: ["03048"] });
  const client = await harness.connect();
  try {
    const opened = await openLot(harness, client);
    const lotSessionId = opened.activeLot.lotSessionId;
    harness.vk.pushComment({ id: 101, fromId: 5001, text: "03048", firstName: "Аня" });
    await client.waitFor(
      (m) => m.type === "state"
        && m.activeLot?.reservations?.events?.some((event) => event.status === "pending_reservation"),
      { timeoutMs: 6000 },
    );

    say(harness, "код товара 03048 цена восемь тысяч восемьсот рублей");
    const state = await client.waitFor(
      (m) => m.type === "state"
        && m.activeLot?.product?.voicePrice === 8800
        && m.activeLot?.reservations?.events?.some((event) => event.status === "reserved"),
      { timeoutMs: 6000 },
    );

    assert.equal(state.activeLot.lotSessionId, lotSessionId);
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 1);
    assert.equal(harness.moysklad.callsTo("updateCustomerOrderPositionPricing").length, 0);
    assert.equal(harness.vk.callsTo("publishPriceUpdate").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("окно закрывается по TTL, даже если цену так и не назвали", async () => {
  // Реальный TTL — 90 секунд; в тесте окно сжато через конфиг.
  const harness = await startHarness({
    cardsByCode: { "03048": CARD },
    knownCodes: ["03048"],
    config: { voiceChangeWindowMs: 40 },
  });
  const client = await harness.connect();
  try {
    await openLot(harness, client);
    await new Promise((resolve) => setTimeout(resolve, 80));

    say(harness, "стоимость восемь тысяч восемьсот");
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.voiceSuggestions?.length === 1,
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.product.voicePrice, null, "по истечении TTL цена не применяется");
    assert.equal(state.activeLot.voiceSuggestions[0].value, 8800);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("новый лот открывает окно заново", async () => {
  const harness = await startHarness({
    cardsByCode: { "03048": CARD, "03050": { ...CARD, id: "p-03050", code: "03050" } },
    knownCodes: ["03048", "03050"],
  });
  const client = await harness.connect();
  try {
    await openLot(harness, client);
    say(harness, "стоимость восемь тысяч восемьсот");
    await client.waitFor((m) => m.type === "state" && m.activeLot?.product?.voicePrice === 8800, { timeoutMs: 6000 });

    client.send({ type: "manualCode", code: "03050" });
    await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03050", { timeoutMs: 6000 });

    say(harness, "стоимость тысяча пятьсот");
    const state = await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.product?.voicePrice === 1500,
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.voiceSuggestions.length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});
