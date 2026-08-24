import { test } from "node:test";
import assert from "node:assert/strict";
import { codesEquivalent, BUYER_MAX_ZERO_PAD } from "../server/product-code-resolver.js";
import { deriveAmbiguousCodes } from "../server/product-code-cache.js";
import { startHarness, createVkMock } from "./helpers/ws-harness.js";

// Корпус — не выдуманный: это все 44 случая из logs/ за 13 эфиров, где код в
// комментарии не совпал с кодом лота буквально. Разделение оказалось чистым:
// настоящий покупатель роняет максимум ОДИН ноль (возраст лота 2–36 с), а все
// обрезки на два нуля пришли внутрь потока комментариев розыгрыша «угадай
// число»: все 34 до одного — внутрь всплеска комментариев, ключевого слова нет
// ни у одного. Эфир 12.07.2026: пятеро «забронировали» 00321, написав «321».

const BUYER = { maxZeroPad: BUYER_MAX_ZERO_PAD };

test("точный код принимается всегда — это 93.8 % всех броней", () => {
  for (const code of ["03204", "00321", "015", "001605"]) {
    assert.equal(codesEquivalent(code, code, { maxZeroPad: 0 }), true, code);
  }
});

test("настоящие обрезки покупателей (не хватает одного нуля) проходят", () => {
  // Реальные комментарии из логов: 27.06 «3466», 12.07 «0019», «0024», «0020 2».
  assert.equal(codesEquivalent("3466", "03466", BUYER), true);
  assert.equal(codesEquivalent("0019", "00019", BUYER), true);
  assert.equal(codesEquivalent("0024", "00024", BUYER), true);
  assert.equal(codesEquivalent("0020", "00020", BUYER), true);
});

test("числа из розыгрыша (не хватает двух и более) не проходят", () => {
  // Реальные ложные брони: 07.06 «345» ×5, 28.06 «545» ×3, 05.07 «178» ×4,
  // 12.07 «321» ×5 и «450», 06.06 «262», 24.07 «#37».
  for (const [buyer, lot] of [
    ["345", "00345"], ["545", "00545"], ["178", "00178"],
    ["321", "00321"], ["450", "00450"], ["262", "00262"],
    ["777", "00777"], ["215", "00215"], ["37", "00037"], ["35", "00035"],
  ]) {
    assert.equal(codesEquivalent(buyer, lot, BUYER), false, `${buyer} → ${lot}`);
  }
});

test("лишние нули безопасны — случайное число из розыгрыша так не выглядит", () => {
  // 12.07 «00015» → лот «015» (три раза), 06.06 «001030» → «01030».
  assert.equal(codesEquivalent("00015", "015", BUYER), true);
  assert.equal(codesEquivalent("001030", "01030", BUYER), true);
  assert.equal(codesEquivalent("000257", "00257", BUYER), true);
});

test("речь оператора сохраняет прежнюю снисходительность", () => {
  // Голосовая отмена и «+N штук»: оператор говорит «два сорок три» при лоте
  // 00243. Цена ошибки — «лот не нашёлся», не чужой заказ.
  assert.equal(codesEquivalent("243", "00243", {}), true);
  assert.equal(codesEquivalent("35", "00035", {}), true);
});

test("без каталога сопоставляем только точно", () => {
  assert.equal(codesEquivalent("3466", "03466", { maxZeroPad: 0 }), false);
  assert.equal(codesEquivalent("03466", "03466", { maxZeroPad: 0 }), true);
});

test("класс коллизии каталога требует точного совпадения в обе стороны", () => {
  const ambiguousCodes = deriveAmbiguousCodes(["019", "00019", "03204", "015"]);
  assert.deepEqual([...ambiguousCodes].sort(), ["00019", "019"]);
  // «19» подходит обоим товарам — не угадываем ни при каком режиме.
  assert.equal(codesEquivalent("19", "00019", { maxZeroPad: Infinity, ambiguousCodes }), false);
  assert.equal(codesEquivalent("019", "00019", { maxZeroPad: Infinity, ambiguousCodes }), false);
  // Точное совпадение с любым из них по-прежнему валидно.
  assert.equal(codesEquivalent("00019", "00019", { maxZeroPad: Infinity, ambiguousCodes }), true);
  // Код вне класса коллизии допуск сохраняет.
  assert.equal(codesEquivalent("3204", "03204", { maxZeroPad: 1, ambiguousCodes }), true);
});

test("deriveAmbiguousCodes не считает коллизией одиночный код", () => {
  assert.equal(deriveAmbiguousCodes(["03204", "00321"]).size, 0);
  assert.equal(deriveAmbiguousCodes([]).size, 0);
});

// ── денежный путь целиком ───────────────────────────────────────────────────

const CARD_00321 = {
  id: "p-00321", name: "Браслет янтарный", code: "00321",
  pathName: "Украшения/Браслеты", salePrice: 1500, availableStock: 5,
};

async function openLot(harness, client, code) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  await harness.waitForSession();
  client.send({ type: "manualCode", code });
  await client.waitFor((m) => m.type === "state" && m.activeLot?.code === code);
}

test("число из розыгрыша не бронирует даже только что открытый лот", async () => {
  // Свежесть лота ничего не доказывает: 05.07 лот 00178 открыли в 12:40, а
  // четверо написали «178» в 12:45–12:46 — ровно тогда, когда в ленту падало
  // 61 и 176 комментариев в минуту против нуля минутой раньше.
  const vk = createVkMock();
  const harness = await startHarness({
    cardsByCode: { "00321": CARD_00321 },
    knownCodes: ["00321"],
    vk,
  });
  const client = await harness.connect();
  try {
    await openLot(harness, client, "00321");
    vk.pushComment({ id: 501, fromId: 5001, text: "321", firstName: "Наталия" });

    // Комментарий доезжает до оператора в ленту — но бронью не становится.
    await client.waitFor((m) => m.type === "viewerComment" && m.commentId === 501, { timeoutMs: 6000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(harness.moysklad.callsTo("createCustomerOrderReservation").length, 0);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("«бронь 321» работает — явное намерение не режем", async () => {
  const vk = createVkMock();
  const harness = await startHarness({
    cardsByCode: { "00321": CARD_00321 },
    knownCodes: ["00321"],
    vk,
  });
  const client = await harness.connect();
  try {
    await openLot(harness, client, "00321");
    vk.pushComment({ id: 504, fromId: 5004, text: "бронь 321", firstName: "Марина" });

    const state = await client.waitFor(
      (m) => m.type === "state" && (m.activeLot?.reservations?.events || []).length > 0,
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.reservations.events[0].viewerId, 5004);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("точный код бронирует и по давно открытому лоту — поздние брони живут", async () => {
  const vk = createVkMock();
  const harness = await startHarness({
    cardsByCode: { "00321": CARD_00321 },
    knownCodes: ["00321"],
    vk,
  });
  const client = await harness.connect();
  try {
    await openLot(harness, client, "00321");
    vk.pushComment({ id: 503, fromId: 5003, text: "00321", firstName: "Ольга" });

    const state = await client.waitFor(
      (m) => m.type === "state" && (m.activeLot?.reservations?.events || []).length > 0,
      { timeoutMs: 6000 },
    );
    assert.equal(state.activeLot.reservations.events[0].viewerId, 5003);
  } finally {
    await client.close();
    await harness.close();
  }
});
