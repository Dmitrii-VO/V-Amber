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

// Эфир 2026-07-25: лоты 03116 и 03119 ушли в МойСклад с ценой 0 ₽, хотя
// оператор цену назвал — но в форме «<сумма> рублей ПО СТОИМОСТИ», где сумма
// стоит СЛЕВА от триггера. Прямой проход сканирует только вперёд (j = i + 1)
// и такую фразу не видит; все 24 удачных lot_price_changed того же эфира имели
// обратный порядок («по стоимости тысяча четыреста»). Обе фразы — дословно из
// транскрипта.
test("detectPrice reads the amount stated BEFORE the trigger («… рублей по стоимости»)", () => {
  assert.deepEqual(
    detectPrice(
      "так они получаются сорок сантиметров прямо идут как чокер тысяча двести двадцать рублей по стоимости",
    ),
    { value: 1220, trigger: "стоимости" },
  );
  assert.deepEqual(
    detectPrice("тут они уже подобраны один к одному тысяча четыреста рублей по стоимости"),
    { value: 1400, trigger: "стоимости" },
  );
});

test("detectPrice backward scan keeps the whole amount, not its tail", () => {
  // «тысяча двести двадцать» не должно схлопнуться в «двадцать» (20 ₽):
  // окна перебираются от длинных к коротким.
  assert.deepEqual(detectPrice("тысяча двести двадцать рублей по стоимости"), {
    value: 1220,
    trigger: "стоимости",
  });
  assert.deepEqual(detectPrice("две тысячи сто пятьдесят рублей цена"), {
    value: 2150,
    trigger: "цена",
  });
});

test("detectPrice backward scan does not turn measurements into prices", () => {
  // «сорок сантиметров по стоимости» без суммы — не цена 40 ₽.
  assert.equal(detectPrice("они сорок сантиметров по стоимости"), null);
  assert.equal(detectPrice("длина пятьдесят сантиметров цена"), null);
});

test("detectPrice backward scan does not turn an артикул into a price", () => {
  // Голый цифровой токен слева принимается только при денежном слове между
  // суммой и триггером, иначе «артикул 03116 по стоимости» дало бы 3116 ₽.
  assert.equal(detectPrice("артикул 03116 по стоимости"), null);
  assert.equal(detectPrice("код товара 12345 стоимость"), null);
  assert.deepEqual(detectPrice("1220 рублей по стоимости"), {
    value: 1220,
    trigger: "стоимости",
  });
});

// THOUSANDS_MULTIPLIERS покрывал только 1–10, поэтому «четырнадцать тысяч
// семьсот рублей» молча схлопывалось в 14 ₽ — и такая цена ушла бы в заказ.
// В эфире 2026-07-25 такие лоты (03028 — 12 950 ₽, 03029 — 14 700 ₽) были
// открыты, но их никто не забронировал, иначе позиция стоила бы 12 ₽ и 14 ₽.
test("detectPrice handles teen/tens thousands multipliers", () => {
  assert.deepEqual(detectPrice("по стоимости четырнадцать тысяч семьсот рублей черненькие"), {
    value: 14700,
    trigger: "стоимости",
  });
  assert.deepEqual(detectPrice("по стоимости двенадцать тысяч девятьсот пятьдесят рублей"), {
    value: 12950,
    trigger: "стоимости",
  });
  assert.deepEqual(detectPrice("по стоимости двадцать пять тысяч"), {
    value: 25000,
    trigger: "стоимости",
  });
  assert.deepEqual(detectPrice("по стоимости сто тысяч"), {
    value: 100000,
    trigger: "стоимости",
  });
  // И та же форма слева от триггера, через обратный проход.
  assert.deepEqual(detectPrice("двадцать тысяч пятьсот рублей по стоимости"), {
    value: 20500,
    trigger: "стоимости",
  });
});

test("detectPrice prefers a forward amount over a backward one", () => {
  // Обратный проход — строго фолбэк: если прямой что-то нашёл, он и выигрывает.
  assert.deepEqual(detectPrice("сорок восемь сантиметров по стоимости пять тысяч"), {
    value: 5000,
    trigger: "стоимости",
  });
});

// «N с половиной тысяч» проверяло тот же узкий словарь множителей, что и
// основной путь до его перевода на readSmallNumber, поэтому «двенадцать с
// половиной тысяч» продолжало давать 12 ₽ — идентичный механизм отказа.
test("detectPrice: «N с половиной тысяч» для любого множителя", () => {
  for (const [text, expected] of [
    ["по стоимости двенадцать с половиной тысяч рублей", 12500],
    ["стоимость пятнадцать с половиной тысяч рублей", 15500],
    ["стоимость двадцать с половиной тысяч", 20500],
    ["цена две с половиной тысячи", 2500],
    ["цена полторы тысячи", 1500],
  ]) {
    assert.equal(detectPrice(text)?.value, expected, text);
  }
});

// Разговорная форма без слова «тысяч»: «две сто» = 2100 работала, но только с
// однословным множителем-единицей. «стоимость тринадцать двести» (эфир
// 2026-06-28 19:11:46) читалась как 13 ₽, «девять двести пятьдесят» — как 9200.
test("detectPrice: разговорная форма «N сотни» без слова «тысяч»", () => {
  for (const [text, expected] of [
    ["стоимость тринадцать двести", 13200],
    ["сейчас попозже посмотрим по стоимости стоимость тринадцать двести", 13200],
    ["двадцатый размер стоимость девять двести пятьдесят", 9250],
    ["по стоимости всего две сто", 2100],
  ]) {
    assert.equal(detectPrice(text)?.value, expected, text);
  }
});

test("detectPrice: разговорная форма не срабатывает из середины фразы", () => {
  // Множитель в этой форме допускается только однословный: окно берётся из
  // середины реплики, и «двадцать пять сто из них» дало бы 25100 вместо 25.
  assert.equal(detectPrice("цена двадцать пять сто из них")?.value, 25);
  assert.equal(detectPrice("цена двадцать пять")?.value, 25);
  // Сотни множителем быть не могут — иначе «двести пятьдесят» стало бы 200250.
  assert.equal(detectPrice("стоимость двести пятьдесят")?.value, 250);
  assert.equal(detectPrice("стоимость сто пятьдесят")?.value, 150);
});
