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

// Анализ 2026-06-11: SpeechKit нормализует слова-цифры в цифровые токены,
// и посимвольная форма бага «два пять пять ноль → 2 ₽» воспроизводилась
// в цифровом виде: одиночный токен «2» побеждал до склейки.
test("detectPrice joins bare digit tokens («2 5 5 0» = 2550)", () => {
  assert.deepEqual(detectPrice("цена 2 5 5 0"), {
    value: 2550,
    trigger: "цена",
  });
});

test("detectPrice joins thousands-separated digit groups («1 500», «2 500 рублей»)", () => {
  assert.deepEqual(detectPrice("цена 1 500"), {
    value: 1500,
    trigger: "цена",
  });
  assert.deepEqual(detectPrice("стоимость 2 500 рублей"), {
    value: 2500,
    trigger: "стоимость",
  });
});

// «полторы тысячи» раньше схлопывалось в 1000 (слово «полторы» молча
// пропускалось), «две с половиной тысячи» — в 2 ₽. Обе формы — живая
// операторская речь, и обе ошибки тихие: в эфир уходила неверная цена.
test("detectPrice handles «полторы тысячи» and «N с половиной тысячи»", () => {
  assert.deepEqual(detectPrice("цена полторы тысячи"), {
    value: 1500,
    trigger: "цена",
  });
  assert.deepEqual(detectPrice("цена две с половиной тысячи"), {
    value: 2500,
    trigger: "цена",
  });
});

// «по цене 990» — триггер в дательном падеже; раньше null.
test("detectPrice accepts declined trigger forms («по цене», «стоимостью»)", () => {
  assert.deepEqual(detectPrice("по цене 990"), {
    value: 990,
    trigger: "цене",
  });
  assert.deepEqual(detectPrice("стоимостью 1200"), {
    value: 1200,
    trigger: "стоимостью",
  });
});

// «стоит посмотреть на 5 минут» давало цену 5 ₽: слабый триггер «стоит»
// плюс любое число в окне. Число с не-денежной единицей сразу после —
// не цена.
test("detectPrice ignores numbers followed by non-money units", () => {
  assert.equal(detectPrice("это стоит посмотреть на 5 минут"), null);
  assert.equal(detectPrice("цена упала на 30 процентов"), null);
});
