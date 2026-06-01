import test from "node:test";
import assert from "node:assert/strict";

import { detectPrice } from "../server/price-detector.js";

test("detectPrice extracts numeric стоимость", () => {
  assert.deepEqual(detectPrice("код товара 12345 стоимость 1500"), {
    value: 1500,
    trigger: "стоимость",
  });
});

test("detectPrice extracts spoken price with fillers", () => {
  assert.deepEqual(detectPrice("стоимость такая то тысяча пятьсот"), {
    value: 1500,
    trigger: "стоимость",
  });
});

test("detectPrice extracts spoken digits sequence", () => {
  assert.deepEqual(detectPrice("цена два пять пять ноль"), {
    value: 2550,
    trigger: "цена",
  });
});

test("detectPrice ignores text without price trigger", () => {
  assert.equal(detectPrice("код товара 12345"), null);
});

test("detectPrice survives mid-phrase placement around code + filler tail", () => {
  // Regression из лога 2026-05-24 18:52:11: лот 03219 открылся с
  // voicePrice:null, хотя оператор сказал «цена тысяча восемьсот шестьдесят»
  // в той же фразе. Хвост «вот такое вот колечко» сидит в FILLER_WORDS, и
  // окно из 4–6 слов их пропускает, но 3-словное окно после «цена» должно
  // отдать 1860.
  assert.deepEqual(
    detectPrice(
      "кольцо код товара ноль три два один девять цена тысяча восемьсот шестьдесят вот такое вот колечко",
    ),
    { value: 1860, trigger: "цена" },
  );
});

test("detectPrice keeps the trailing unit («две тысячи двести девяносто пять» = 2295)", () => {
  // Регрессия из лога 2026-05-24 19:37: парсер съедал только 4 слова и
  // отдавал 2290 вместо 2295; оператор отдельно заметил «пятёрку почему-то
  // не распознаёт на конце».
  assert.deepEqual(detectPrice("стоимость две тысячи двести девяносто пять"), {
    value: 2295,
    trigger: "стоимость",
  });
});

test("detectPrice handles цена + 5-word price form", () => {
  assert.deepEqual(detectPrice("цена одна тысяча восемьсот шестьдесят пять"), {
    value: 1865,
    trigger: "цена",
  });
});

// Этап 6: «тысячу» (винительный падеж) — частая операторская форма,
// до этого падала к «пятьсот», потому что regex принимал только
// «тысяча»/«тысячи».
test("detectPrice handles «тысячу» (accusative form)", () => {
  assert.deepEqual(detectPrice("цена тысячу пятьсот"), {
    value: 1500,
    trigger: "цена",
  });
  assert.deepEqual(detectPrice("стоимость тысячу"), {
    value: 1000,
    trigger: "стоимость",
  });
});
