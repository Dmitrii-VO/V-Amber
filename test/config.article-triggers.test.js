import test from "node:test";
import assert from "node:assert/strict";

// config.js резолвит обязательный ключ SpeechKit на этапе импорта — ставим его
// до import, иначе модуль бросит. Значение для теста не важно.
process.env.YANDEX_SPEECHKIT_API_KEY = process.env.YANDEX_SPEECHKIT_API_KEY || "test-key";

const { config } = await import("../server/config.js");

test("default article triggers include the short «код» form", () => {
  const triggers = config.articleExtraction.triggers;
  // Стандартный набор: «код товара 01234», «артикул 01234» и сокращённое
  // «код 01234» — все открывают лот из коробки.
  for (const expected of ["код товара", "артикул", "код"]) {
    assert.ok(triggers.includes(expected), `ожидался триггер «${expected}», получили ${JSON.stringify(triggers)}`);
  }
});
