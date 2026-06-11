// Канонические словари русских числительных. Раньше эти карты были скопированы
// в article-extractor.js, price-detector.js и discount-detector.js — правка в
// одном месте легко забывалась в остальных. Здесь — единственный источник.
//
// Важно: все ключи в нижнем регистре, ё уже заменена на е вызывающей стороной
// (normalizeWord/normalizeText). UNIT_WORDS НЕ содержит «ноль» — детекторы цены
// и скидки обрабатывают ноль отдельно (ZERO_WORDS), а article-extractor строит
// свой расширенный UNIT_WORDS поверх этого базового (см. там).

export const UNIT_WORDS = new Map([
  ["один", 1], ["одну", 1], ["одна", 1],
  ["два", 2], ["две", 2],
  ["три", 3], ["четыре", 4], ["пять", 5],
  ["шесть", 6], ["семь", 7], ["восемь", 8],
  ["девять", 9],
]);

export const TEEN_WORDS = new Map([
  ["десять", 10], ["одиннадцать", 11], ["двенадцать", 12],
  ["тринадцать", 13], ["четырнадцать", 14], ["пятнадцать", 15],
  ["шестнадцать", 16], ["семнадцать", 17], ["восемнадцать", 18],
  ["девятнадцать", 19],
]);

export const TENS_WORDS = new Map([
  ["двадцать", 20], ["тридцать", 30], ["сорок", 40],
  ["пятьдесят", 50], ["шестьдесят", 60], ["семьдесят", 70],
  ["восемьдесят", 80], ["девяносто", 90],
]);

export const HUNDREDS_WORDS = new Map([
  ["сто", 100], ["двести", 200], ["триста", 300], ["четыреста", 400],
  ["пятьсот", 500], ["шестьсот", 600], ["семьсот", 700],
  ["восемьсот", 800], ["девятьсот", 900],
]);

// Множители тысяч: «две тысячи» = 2×1000. Используются price/discount.
export const THOUSANDS_MULTIPLIERS = new Map([
  ["одна", 1], ["один", 1], ["две", 2], ["два", 2],
  ["три", 3], ["четыре", 4], ["пять", 5], ["шесть", 6],
  ["семь", 7], ["восемь", 8], ["девять", 9], ["десять", 10],
]);

// «полторы тысячи» = 1500. Отдельно от THOUSANDS_MULTIPLIERS, потому что
// множитель дробный и «полторы» без «тысячи» числом не является.
const SESQUI_WORDS = new Set(["полторы", "полтора"]);

const THOUSAND_RE = /^тысяч[ауи]?$/;

function normalizeWord(word) {
  return word.toLowerCase().replace(/ё/g, "е");
}

// Денежное числительное из последовательности слов: «две тысячи пятьсот
// пятьдесят» → 2550. Требует, чтобы СЛОВА были израсходованы целиком
// (i === norm.length), иначе null — вызывающие стороны подбирают окно сами.
// Раньше функция была скопирована в price-detector.js и discount-detector.js;
// здесь — единственный источник. Понимает «полторы тысячи» (1500) и
// «две с половиной тысячи» (2500) — до этого «полторы тысячи» молча
// схлопывалось в 1000, а «две с половиной тысячи» — в 2 (цена 2 ₽ в эфире).
export function parseMonetaryWords(words) {
  const norm = words.map(normalizeWord);
  let value = 0;
  let i = 0;

  if (
    norm.length === 2
    && UNIT_WORDS.has(norm[0])
    && HUNDREDS_WORDS.has(norm[1])
  ) {
    return UNIT_WORDS.get(norm[0]) * 1000 + HUNDREDS_WORDS.get(norm[1]);
  }

  if (norm.length >= 2 && SESQUI_WORDS.has(norm[0]) && THOUSAND_RE.test(norm[1])) {
    value += 1500;
    i += 2;
  } else if (
    norm.length >= 4
    && THOUSANDS_MULTIPLIERS.has(norm[0])
    && norm[1] === "с"
    && norm[2] === "половиной"
    && THOUSAND_RE.test(norm[3])
  ) {
    value += THOUSANDS_MULTIPLIERS.get(norm[0]) * 1000 + 500;
    i += 4;
  } else if (i < norm.length && THOUSAND_RE.test(norm[i])) {
    value += 1000;
    i += 1;
  } else if (i + 1 < norm.length && THOUSAND_RE.test(norm[i + 1])) {
    const mult = THOUSANDS_MULTIPLIERS.get(norm[i]);
    if (mult !== undefined) {
      value += mult * 1000;
      i += 2;
    }
  }

  if (i < norm.length && HUNDREDS_WORDS.has(norm[i])) {
    value += HUNDREDS_WORDS.get(norm[i]);
    i += 1;
  }

  if (i < norm.length && TEEN_WORDS.has(norm[i])) {
    value += TEEN_WORDS.get(norm[i]);
    i += 1;
  } else {
    if (i < norm.length && TENS_WORDS.has(norm[i])) {
      value += TENS_WORDS.get(norm[i]);
      i += 1;
    }
    if (i < norm.length && UNIT_WORDS.has(norm[i])) {
      value += UNIT_WORDS.get(norm[i]);
      i += 1;
    }
  }

  return value > 0 && i === norm.length ? value : null;
}
