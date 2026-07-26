import test from "node:test";
import assert from "node:assert/strict";

import { resolveKnownCode, resolveKnownCodePrefix } from "../server/product-code-resolver.js";

const catalog = new Set(["02", "03172", "00212", "00266", "01042"]);

test("resolveKnownCode: точное совпадение", () => {
  const result = resolveKnownCode("03172", catalog);
  assert.equal(result.status, "matched");
  assert.equal(result.code, "03172");
  assert.equal(result.reason, "exact");
});

test("resolveKnownCode: недобранный ведущий ноль дописывается", () => {
  // Оператор говорит «три один семь два» — в каталоге код с ведущим нулём.
  const result = resolveKnownCode("3172", catalog);
  assert.equal(result.status, "matched");
  assert.equal(result.code, "03172");
  assert.equal(result.reason, "leading_zeros");
  assert.equal(result.originalCode, "3172");
});

test("resolveKnownCode: обрывок не дотягивается до постороннего короткого кода", () => {
  // Инцидент 2026-07-26: «002» из оговорки сматчился с реальным товаром «02»
  // (Заколка Янтарная) и его карточка ушла в VK вместо нужного 00266.
  // Направление «у кандидата нулей БОЛЬШЕ, чем в каталоге» разрешено только
  // для кодов с 3+ значимыми цифрами.
  const result = resolveKnownCode("002", catalog);
  assert.equal(result.status, "not_found");
});

test("resolveKnownCode: лишние нули у длинного кода по-прежнему нормализуются", () => {
  // «000212» → 00212: значимая часть 212 достаточно длинная, чтобы не быть
  // случайной оговоркой.
  const result = resolveKnownCode("000212", catalog);
  assert.equal(result.status, "matched");
  assert.equal(result.code, "00212");
  assert.equal(result.reason, "leading_zeros");
});

test("resolveKnownCode: короткий каталожный код всё ещё доступен как есть", () => {
  const result = resolveKnownCode("02", catalog);
  assert.equal(result.status, "matched");
  assert.equal(result.code, "02");
  assert.equal(result.reason, "exact");
});

test("resolveKnownCode: неизвестный код не выдумывается", () => {
  assert.equal(resolveKnownCode("99999", catalog).status, "not_found");
});

test("resolveKnownCodePrefix: хвостовой мусор обрезается до каталожного кода", () => {
  // «031725» — приклеилась лишняя цифра; префиксный резолвер снимает её.
  const result = resolveKnownCodePrefix("031725", catalog, { minLength: 1 });
  assert.equal(result.status, "matched");
  assert.equal(result.code, "03172");
});

test("resolveKnownCodePrefix: обрывок не обрезается до постороннего «02»", () => {
  // Тот же предохранитель, что в resolveKnownCode: иначе «002» → «02».
  const result = resolveKnownCodePrefix("002", catalog, { minLength: 1 });
  assert.equal(result.status, "not_found");
});
