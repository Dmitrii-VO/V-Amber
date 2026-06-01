import test from "node:test";
import assert from "node:assert/strict";

import { parseReservationComment, parseWishlistComment } from "../server/reservation-parser.js";

test("canonical 'бронь <код>' still matches", () => {
  assert.deepEqual(parseReservationComment("бронь 03204"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
  assert.deepEqual(parseReservationComment("Бронь  03204"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
  assert.deepEqual(parseReservationComment("бронь, 03204."), { hasReservationKeyword: true, code: "03204", quantity: 1 });
});

test("relaxed Russian variations are accepted", () => {
  for (const text of [
    "забронируй 03204",
    "забронируйте, пожалуйста 03204",
    "бронирую 03204",
    "беру 03204",
    "возьму 03204",
    "куплю 03204",
    "хочу 03204",
    "держите 03204",
    "удержите 03204",
    "заберу 03204",
    "отложите 03204",
    "моё 03204",
    "мое 03204",
    "плюс 03204",
  ]) {
    const result = parseReservationComment(text);
    assert.equal(result.hasReservationKeyword, true, `keyword in: ${text}`);
    assert.equal(result.code, "03204", `code in: ${text}`);
    assert.equal(result.quantity, 1, `default quantity in: ${text}`);
  }
});

test("'+'-shorthand counts as a reservation", () => {
  assert.deepEqual(parseReservationComment("+03204"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
  assert.deepEqual(parseReservationComment("+ 03204"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
  assert.deepEqual(parseReservationComment("++ 03204"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
});

test("keyword anywhere in the text still works", () => {
  assert.deepEqual(parseReservationComment("03204 беру"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
  assert.deepEqual(parseReservationComment("ой какая прелесть, хочу 03204!"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
});

test("multiple numbers — pick the longest digit run", () => {
  assert.deepEqual(parseReservationComment("беру 2 штуки 03204"), { hasReservationKeyword: true, code: "03204", quantity: 2 });
  assert.deepEqual(parseReservationComment("хочу 03204 за 1500"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
});

test("word-form quantity («две штуки», «три пары», «пять штук»)", () => {
  // Покупатели в эфире пишут количество словом чаще, чем цифрой; до этого
  // парсер ловил только «2 шт» / «*2» — словесная форма тихо схлопывалась
  // в quantity=1 и оператор узнавал о двух желаемых штуках только из текста
  // комментария.
  assert.deepEqual(
    parseReservationComment("бронь 03204 две штуки"),
    { hasReservationKeyword: true, code: "03204", quantity: 2 },
  );
  assert.deepEqual(
    parseReservationComment("хочу 03204 три штуки"),
    { hasReservationKeyword: true, code: "03204", quantity: 3 },
  );
  assert.deepEqual(
    parseReservationComment("беру пять штук 03204"),
    { hasReservationKeyword: true, code: "03204", quantity: 5 },
  );
  // «три пары» = 6 (множитель «пара» = 2). До фикса было бы 2.
  assert.deepEqual(
    parseReservationComment("бронь 03204 три пары"),
    { hasReservationKeyword: true, code: "03204", quantity: 6 },
  );
  // Кап на 10 — «двадцать штук» (через цифру) обрежется; для словесной
  // формы проверяем верхнюю поддерживаемую цифру.
  assert.deepEqual(
    parseReservationComment("бронь 03204 десять штук"),
    { hasReservationKeyword: true, code: "03204", quantity: 10 },
  );
});

test("word-form quantity ignores words that are not quantity-units", () => {
  // «две» без шт/пар — не количество. «бронь две тысячи» (вдруг покупатель
  // имел в виду цену) должно остаться quantity=1, чтобы случайное «две»
  // в свободной речи не превращало 1 шт в 2.
  assert.deepEqual(
    parseReservationComment("бронь 03204 две"),
    { hasReservationKeyword: true, code: "03204", quantity: 1 },
  );
});

test("word-form quantity needs to be close to the code (≤2 tokens)", () => {
  // Покупатель говорит «бронь 03204, а можно две пары серёг показать» —
  // «две пары» это описание желаемого, не количество. До локального
  // гарда давало quantity=4 (opencode review 2026-06-01).
  assert.deepEqual(
    parseReservationComment("бронь 03204 а можно две пары серег показать"),
    { hasReservationKeyword: true, code: "03204", quantity: 1 },
  );
  // А «бронь 03204 две штуки на двух подружек» (3 токена между кодом и
  // количеством разрешено НЕ должно быть — пограничный случай).
  assert.equal(
    parseReservationComment("бронь 03204 потом подскажите две штуки").quantity,
    1,
  );
});

test("keyword without code returns hasReservationKeyword=true, code=null", () => {
  assert.deepEqual(parseReservationComment("бронь"), { hasReservationKeyword: true, code: null, quantity: 1 });
  assert.deepEqual(parseReservationComment("беру"), { hasReservationKeyword: true, code: null, quantity: 1 });
});

test("free text without any reservation intent is ignored", () => {
  assert.deepEqual(parseReservationComment("красивая брошечка"), { hasReservationKeyword: false, code: null, quantity: 1 });
  assert.deepEqual(parseReservationComment("привет всем"), { hasReservationKeyword: false, code: null, quantity: 1 });
  assert.deepEqual(parseReservationComment(""), { hasReservationKeyword: false, code: null, quantity: 1 });
  assert.deepEqual(parseReservationComment(null), { hasReservationKeyword: false, code: null, quantity: 1 });
});

test("wishlist intent never resolves to a reservation", () => {
  assert.deepEqual(parseReservationComment("список 03220"), { hasReservationKeyword: false, code: null, quantity: 1 });
  assert.deepEqual(parseReservationComment("список"), { hasReservationKeyword: false, code: null, quantity: 1 });
});

test("plain '+' without a digit is NOT a reservation (could be a +1 reaction)", () => {
  assert.deepEqual(parseReservationComment("+"), { hasReservationKeyword: false, code: null, quantity: 1 });
  assert.deepEqual(parseReservationComment("+++"), { hasReservationKeyword: false, code: null, quantity: 1 });
});

test("short 'бр <код>' shortcut is accepted", () => {
  assert.deepEqual(parseReservationComment("бр 03204"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
  assert.deepEqual(parseReservationComment("Бр 03204"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
  assert.deepEqual(parseReservationComment("брн 03204"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
  assert.deepEqual(parseReservationComment("брнь 03204"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
});

test("bare code is treated as a reservation", () => {
  assert.deepEqual(parseReservationComment("03204"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
  assert.deepEqual(parseReservationComment(" 03204 "), { hasReservationKeyword: true, code: "03204", quantity: 1 });
  assert.deepEqual(parseReservationComment("03204."), { hasReservationKeyword: true, code: "03204", quantity: 1 });
  assert.deepEqual(parseReservationComment("03204!"), { hasReservationKeyword: true, code: "03204", quantity: 1 });
});

test("bare code with surrounding letters still needs a keyword", () => {
  assert.deepEqual(parseReservationComment("стоит 03204 рублей?"), { hasReservationKeyword: false, code: null, quantity: 1 });
  assert.deepEqual(parseReservationComment("спасибо 03204"), { hasReservationKeyword: false, code: null, quantity: 1 });
});

test("preferredCode wins over the longest digit run", () => {
  assert.deepEqual(
    parseReservationComment("возьму 12 за 2500", { preferredCode: "12" }),
    { hasReservationKeyword: true, code: "12", quantity: 1 },
  );
  assert.deepEqual(
    parseReservationComment("бронь 12, мой номер 89991234567", { preferredCode: "12" }),
    { hasReservationKeyword: true, code: "12", quantity: 1 },
  );
  assert.deepEqual(
    parseReservationComment("беру 03204", { preferredCode: "99999" }),
    { hasReservationKeyword: true, code: "03204", quantity: 1 },
  );
  assert.deepEqual(
    parseReservationComment("сколько стоит 03204", { preferredCode: "03204" }),
    { hasReservationKeyword: false, code: null, quantity: 1 },
  );
});

test("quantity: 'шт' marker extracts the number", () => {
  assert.deepEqual(
    parseReservationComment("беру 2 шт 03204"),
    { hasReservationKeyword: true, code: "03204", quantity: 2 },
  );
  assert.deepEqual(
    parseReservationComment("бронь 03204 3шт"),
    { hasReservationKeyword: true, code: "03204", quantity: 3 },
  );
  assert.deepEqual(
    parseReservationComment("хочу 5 штук 03204"),
    { hasReservationKeyword: true, code: "03204", quantity: 5 },
  );
});

test("quantity: 'x'/'*' shorthand extracts the number", () => {
  assert.deepEqual(
    parseReservationComment("беру 03204 x2"),
    { hasReservationKeyword: true, code: "03204", quantity: 2 },
  );
  // Кириллическая «х» (U+0445) — частая опечатка вместо латинской x.
  assert.deepEqual(
    parseReservationComment("беру 03204 х2"),
    { hasReservationKeyword: true, code: "03204", quantity: 2 },
  );
  assert.deepEqual(
    parseReservationComment("беру 03204 *3"),
    { hasReservationKeyword: true, code: "03204", quantity: 3 },
  );
});

test("quantity: 'пара' equals 2", () => {
  assert.deepEqual(
    parseReservationComment("беру пара 03204"),
    { hasReservationKeyword: true, code: "03204", quantity: 2 },
  );
});

test("quantity: clamped to 10 hard cap", () => {
  assert.deepEqual(
    parseReservationComment("беру 100 шт 03204"),
    { hasReservationKeyword: true, code: "03204", quantity: 10 },
  );
  assert.deepEqual(
    parseReservationComment("беру 03204 x999"),
    { hasReservationKeyword: true, code: "03204", quantity: 10 },
  );
});

test("quantity: bare code path stays at 1", () => {
  assert.deepEqual(
    parseReservationComment("03204"),
    { hasReservationKeyword: true, code: "03204", quantity: 1 },
  );
});

test("parseWishlistComment is unchanged", () => {
  assert.deepEqual(parseWishlistComment("список 03220"), { hasWishlistKeyword: true, code: "03220" });
  assert.deepEqual(parseWishlistComment("СПИСОК 03220"), { hasWishlistKeyword: true, code: "03220" });
  assert.deepEqual(parseWishlistComment("список"), { hasWishlistKeyword: true, code: null });
  assert.deepEqual(parseWishlistComment("привет"), { hasWishlistKeyword: false, code: null });
});
