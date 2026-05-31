import test from "node:test";
import assert from "node:assert/strict";

import { detectDiscount } from "../server/discount-detector.js";

const TRIGGERS = ["скидка", "скидку", "скидки", "скидочка"];

test("detectDiscount handles percent in word form", () => {
  assert.deepEqual(
    detectDiscount("скидка тридцать процентов", TRIGGERS),
    { kind: "percent", value: 30 },
  );
});

test("detectDiscount handles percent-before-number word order", () => {
  assert.deepEqual(
    detectDiscount("скидка процентов тридцать", TRIGGERS),
    { kind: "percent", value: 30 },
  );
});

// Этап 6: токен вида «30%» (без пробела) часто приходит из транскриптов
// и из ручного ввода. До этого склеенный токен не распознавался, потому
// что isPercentToken ожидал ровно «%» или префикс «процент».
test("detectDiscount handles digits glued to percent sign («30%»)", () => {
  assert.deepEqual(
    detectDiscount("скидка 30%", TRIGGERS),
    { kind: "percent", value: 30 },
  );
  assert.deepEqual(
    detectDiscount("20% скидки", TRIGGERS),
    { kind: "percent", value: 20 },
  );
});

test("detectDiscount handles absolute amount in rubles", () => {
  assert.deepEqual(
    detectDiscount("скидка двести рублей", TRIGGERS),
    { kind: "absolute", value: 200 },
  );
  assert.deepEqual(
    detectDiscount("скидка 500", TRIGGERS),
    { kind: "absolute", value: 500 },
  );
});

test("detectDiscount returns null for «без скидки»", () => {
  assert.equal(detectDiscount("без скидки", TRIGGERS), null);
});

test("detectDiscount returns null without a trigger word", () => {
  assert.equal(detectDiscount("просто двести рублей", TRIGGERS), null);
});
