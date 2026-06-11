import test from "node:test";
import assert from "node:assert/strict";

import { parseCancelCommand } from "../server/cancel-command-parser.js";

test("parses the canonical phrase «Имя Фамилия отмена лота #код»", () => {
  const r = parseCancelCommand("Галина Прокофьева отмена лота #033322");
  assert.equal(r.matched, true);
  assert.equal(r.name, "галина прокофьева");
  assert.equal(r.code, "033322");
});

test("works without # before the code", () => {
  const r = parseCancelCommand("Иван Петров отмена лота 03204");
  assert.equal(r.matched, true);
  assert.equal(r.name, "иван петров");
  assert.equal(r.code, "03204");
});

test("accepts «снять бронь» phrasing", () => {
  const r = parseCancelCommand("Анна Сидорова снять бронь 12345");
  assert.equal(r.matched, true);
  assert.equal(r.name, "анна сидорова");
  assert.equal(r.code, "12345");
});

test("accepts «отмена брони» phrasing", () => {
  const r = parseCancelCommand("Пётр Смирнов отмена брони #00588");
  assert.equal(r.matched, true);
  assert.equal(r.code, "00588");
  assert.equal(r.name, "петр смирнов");
});

test("strips leading filler words from the name", () => {
  const r = parseCancelCommand("так давай Галина Прокофьева отмена лота #033322");
  assert.equal(r.matched, true);
  assert.equal(r.name, "галина прокофьева");
});

test("keeps at most 3 trailing name tokens", () => {
  const r = parseCancelCommand("Галина Петровна Прокофьева отмена лота 033322");
  assert.equal(r.name, "галина петровна прокофьева");
});

test("no match when cancel trigger is absent", () => {
  assert.equal(parseCancelCommand("Галина Прокофьева бронь 033322").matched, false);
  assert.equal(parseCancelCommand("просто болтовня без команды").matched, false);
});

test("no match when code is missing", () => {
  assert.equal(parseCancelCommand("Галина Прокофьева отмена лота").matched, false);
});

test("no match when name is missing", () => {
  assert.equal(parseCancelCommand("отмена лота #033322").matched, false);
});

test("parses code spoken as digit-words («ноль один ноль пять девять»)", () => {
  const r = parseCancelCommand("Дмитрий Васильев отменил бронь ноль один ноль пять девять");
  assert.equal(r.matched, true);
  assert.equal(r.name, "дмитрий васильев");
  assert.equal(r.code, "01059");
});

test("digit-words: stops at non-digit word (trailing «штук» is dropped)", () => {
  const r = parseCancelCommand("Анна Сидорова снять бронь ноль три два семь шесть штук");
  assert.equal(r.matched, true);
  assert.equal(r.code, "03276");
});

test("digit-words: «код товара» before the spoken code is allowed", () => {
  const r = parseCancelCommand(
    "Дмитрий Васильев отменил бронь код товара ноль три два семь шесть",
  );
  assert.equal(r.matched, true);
  assert.equal(r.code, "03276");
});

test("digit-words: needs at least 2 consecutive digits to count", () => {
  assert.equal(
    parseCancelCommand("Иван Петров отмена лота семь штук").matched,
    false,
  );
});

test("digit-words: refuses runs longer than 6 (likely captured price/qty)", () => {
  // 7 digit-words — better refuse than silently truncate to a 6-digit code
  // that points at a different open lot (real-money risk).
  assert.equal(
    parseCancelCommand(
      "Иван Петров отмена лота ноль один два три четыре пять шесть",
    ).matched,
    false,
  );
});

test("digit-words: ignores stray digit-words not adjacent to the trigger", () => {
  // After «отмена лота» the next words are unrelated chatter; the lone
  // «один два» much later should not be glued into a fake code.
  assert.equal(
    parseCancelCommand(
      "Иван Петров отмена лота смотри потом скажу один два",
    ).matched,
    false,
  );
});

test("empty / null input is safe", () => {
  assert.equal(parseCancelCommand("").matched, false);
  assert.equal(parseCancelCommand(null).matched, false);
});

// Анализ 2026-06-11: цифровой поиск кода шёл по всему тексту, и цена,
// названная ДО команды, перехватывала код брони — подсветилась бы не та
// строка. Код теперь ищется только после триггера.
test("price mentioned before the trigger does not hijack the code", () => {
  assert.deepEqual(
    parseCancelCommand("за 2500 галина прокофьева отмена брони ноль три три три два два"),
    { matched: true, name: "галина прокофьева", code: "033322" },
  );
});

test("no match when the only digits are before the trigger", () => {
  assert.equal(
    parseCancelCommand("за 2500 галина прокофьева отмена брони").matched,
    false,
  );
});
