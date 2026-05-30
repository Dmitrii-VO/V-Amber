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

test("empty / null input is safe", () => {
  assert.equal(parseCancelCommand("").matched, false);
  assert.equal(parseCancelCommand(null).matched, false);
});
