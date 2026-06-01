import test from "node:test";
import assert from "node:assert/strict";

import { parseQuantityCommand } from "../server/quantity-command-parser.js";

test("canonical «<Имя> добавь N штук <код>»", () => {
  const r = parseQuantityCommand("Анна Сидорова добавь две штуки 03204");
  assert.equal(r.matched, true);
  assert.equal(r.name, "анна сидорова");
  assert.equal(r.quantity, 2);
  assert.equal(r.code, "03204");
});

test("accepts «запиши» / «поставь» / «плюс» / «измени»", () => {
  for (const verb of ["запиши", "поставь", "плюс", "измени"]) {
    const r = parseQuantityCommand(`Иван Петров ${verb} три штуки 12345`);
    assert.equal(r.matched, true, `verb: ${verb}`);
    assert.equal(r.quantity, 3, `verb: ${verb}`);
    assert.equal(r.code, "12345", `verb: ${verb}`);
  }
});

test("digit quantity «2 шт»", () => {
  const r = parseQuantityCommand("Пётр Смирнов добавь 2 шт 00588");
  assert.equal(r.matched, true);
  assert.equal(r.quantity, 2);
  assert.equal(r.code, "00588");
});

test("«пара» удваивает («две пары» = 4)", () => {
  const r = parseQuantityCommand("Анна Иванова добавь две пары 03204");
  assert.equal(r.matched, true);
  assert.equal(r.quantity, 4);
});

test("digit-word code («ноль три два ноль четыре»)", () => {
  const r = parseQuantityCommand("Иван Петров добавь две штуки код товара ноль три два ноль четыре");
  assert.equal(r.matched, true);
  assert.equal(r.quantity, 2);
  assert.equal(r.code, "03204");
});

test("«#» перед кодом не мешает", () => {
  const r = parseQuantityCommand("Галина Прокофьева добавь две штуки #033322");
  assert.equal(r.matched, true);
  assert.equal(r.code, "033322");
});

test("filler «так давай» в начале режется", () => {
  const r = parseQuantityCommand("так давай Анна Сидорова добавь две штуки 03204");
  assert.equal(r.matched, true);
  assert.equal(r.name, "анна сидорова");
});

test("no match without verb («Анна две штуки 03204» — это пересказ комментария)", () => {
  assert.equal(parseQuantityCommand("Анна две штуки 03204").matched, false);
});

test("no match without quantity unit («добавь два» без шт/пар — двусмысленно)", () => {
  assert.equal(parseQuantityCommand("Анна добавь два 03204").matched, false);
});

test("no match without code", () => {
  assert.equal(parseQuantityCommand("Анна добавь две штуки").matched, false);
});

test("no match without name", () => {
  assert.equal(parseQuantityCommand("добавь две штуки 03204").matched, false);
});

test("quantity is capped at 10", () => {
  // «десять» — последнее поддерживаемое слово, всё что выше — через цифру и
  // обрезается капом.
  const r = parseQuantityCommand("Анна Сидорова добавь 20 шт 03204");
  assert.equal(r.matched, true);
  assert.equal(r.quantity, 10);
});

test("empty / null input is safe", () => {
  assert.equal(parseQuantityCommand("").matched, false);
  assert.equal(parseQuantityCommand(null).matched, false);
});
