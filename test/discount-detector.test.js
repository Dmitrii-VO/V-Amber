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

// #5 (log review 2026-06-05): оператор произносит скидку как «скидка N%» и
// «минус N%» (и цифрами, и словами). Эти формы обязаны давать процент.
test("detectDiscount handles «скидка 50%» (digits)", () => {
  assert.deepEqual(detectDiscount("скидка 50%", TRIGGERS), { kind: "percent", value: 50 });
});

test("detectDiscount handles «скидка пятьдесят процентов» (words)", () => {
  assert.deepEqual(detectDiscount("скидка пятьдесят процентов", TRIGGERS), { kind: "percent", value: 50 });
});

test("detectDiscount handles «минус N%» without the word «скидка» (digits)", () => {
  assert.deepEqual(detectDiscount("минус 10%", TRIGGERS), { kind: "percent", value: 10 });
  assert.deepEqual(detectDiscount("минус 20 процентов", TRIGGERS), { kind: "percent", value: 20 });
});

test("detectDiscount handles «минус двадцать процентов» (words)", () => {
  assert.deepEqual(detectDiscount("минус двадцать процентов", TRIGGERS), { kind: "percent", value: 20 });
});

// #5 anti-false-trigger: пока система не знает условий, «максимальная скидка» и
// «есть скидка» НЕ должны применять скидку (нет числа → ничего не меняем).
test("detectDiscount does NOT apply vague «максимальная скидка»", () => {
  assert.equal(detectDiscount("максимальная скидка", TRIGGERS), null);
  assert.equal(detectDiscount("у нас есть скидка", TRIGGERS), null);
  assert.equal(detectDiscount("будет хорошая скидка", TRIGGERS), null);
});
