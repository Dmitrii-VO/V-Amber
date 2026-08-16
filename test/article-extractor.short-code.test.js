import { test } from "node:test";
import assert from "node:assert/strict";
import { detectArticle } from "../server/article-extractor.js";
import { resolveKnownCodePrefix } from "../server/product-code-resolver.js";

// Проблема 2 из knowledge/wiki/voice-price-window-plan.md: артикул обрезался
// до короткого, но реально существующего кода, и в эфир уходила карточка
// постороннего товара. 15 таких лотов за три месяца.
//
// Границу поставили на РАЗМЫТОМ восстановлении, а не на каталоге: короткие
// коды — законные данные (спецификация использует 402, в каталоге живут 02,
// 03, 017), и точным совпадением они по-прежнему открываются.

// Срез реального каталога: короткие коды и их длинные «однофамильцы».
const CATALOG = new Set([
  "02", "03", "017", "015", "402",
  "00588", "03124", "03630", "03693", "03250", "03172", "01299", "00266",
]);

const config = {
  triggers: ["артикул", "код товара", "код"],
  minLength: 1,
  maxLength: 6,
  knownCodes: CATALOG,
};

const codes = (result) => (result.candidates || []).map((candidate) => candidate.code).sort();

test("точный короткий код по-прежнему открывается", async () => {
  for (const [text, code] of [
    ["артикул ноль три", "03"],
    ["артикул ноль семнадцать", "017"],
    ["код товара ноль один семь", "017"],
  ]) {
    const result = await detectArticle(text, config);
    assert.equal(result.status, "confirmed", text);
    assert.equal(result.chosen?.code, code, text);
  }
});

test("префиксный фолбэк не режет код короче четырёх знаков", () => {
  // «ноль пять восемь восемь»: 0588 → 058 → 05. Именно так в эфир уехала
  // заколка вместо браслета.
  const result = resolveKnownCodePrefix("0588", new Set(["05", "058"]), { minLength: 1 });
  assert.equal(result.status, "not_found");

  // Достаточно длинный префикс — по-прежнему рабочий путь.
  assert.equal(resolveKnownCodePrefix("031725", CATALOG, { minLength: 1 }).code, "03172");
});

test("одна значимая цифра — это угадывание, а не восстановление", () => {
  // «ноль ноль ноль пятнадцать» = 00015, реальный код 015. Значимая часть
  // «15» цеплялась за «00001» со значимой «1» и открывала чужой товар.
  const result = resolveKnownCodePrefix("00015", new Set(["00001", "015"]), { minLength: 1 });
  assert.equal(result.status, "not_found");
});

test("база и сотенный хвост вместе дают ambiguous, а не молчаливый выбор", async () => {
  const result = await detectArticle("стальные покороче артикул ноль три сто двадцать четыре", config);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.chosen, null);
  assert.deepEqual(codes(result), ["03", "03124"]);
});

test("союз внутри цифрового ряда даёт второй кандидат, а не обрезанный код", async () => {
  for (const [text, joined] of [
    ["артикул ноль три и шесть три ноль", "03630"],
    ["артикул ноль три и шесть девять три", "03693"],
    ["следующий артикул ноль три и два пять ноль", "03250"],
  ]) {
    const result = await detectArticle(text, config);
    assert.equal(result.status, "ambiguous", text);
    assert.deepEqual(codes(result), ["03", joined].sort(), text);
  }
});

test("союз перед не-цифрой ничего не склеивает", async () => {
  const result = await detectArticle("артикул ноль три и я вам её забронирую", config);
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "03");
});

test("склейка, которой нет в каталоге, отбрасывается, а не подгоняется", async () => {
  // «артикул ноль три ноль четыре восемь и восемь тысяч восемьсот рублей»:
  // 030488 в каталоге нет — цену приклеивать к коду нельзя.
  const result = await detectArticle(
    "артикул ноль три ноль четыре восемь и восемь тысяч восемьсот рублей",
    { ...config, knownCodes: new Set([...CATALOG, "03048"]) },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "03048");
});

test("единственный законный сотенный хвост из бандла не регрессирует", async () => {
  // 00323 существует, 003 — нет, спорить не с чем: лот открывается сам.
  const result = await detectArticle(
    "артикул ноль ноль триста двадцать три",
    { ...config, knownCodes: new Set(["00323", "00266"]) },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "00323");
});
