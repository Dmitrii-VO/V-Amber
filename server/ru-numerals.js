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

// Словаря множителей тысяч здесь больше нет: он перечислял только однословные
// один..десять и был причиной «двенадцать тысяч девятьсот пятьдесят» → 12 ₽.
// Любой множитель 1..999 читает readSmallNumber ниже.

// «полторы тысячи» = 1500. Отдельным случаем, потому что
const SESQUI_WORDS = new Set(["полторы", "полтора"]);

const THOUSAND_RE = /^тысяч[ауи]?$/;

// Множитель тысяч может быть составным: «четырнадцать тысяч», «двадцать тысяч»,
// «двадцать пять тысяч», «сто тысяч». THOUSANDS_MULTIPLIERS покрывает только
// 1–10, поэтому «четырнадцать тысяч семьсот рублей» отдавало 14 ₽ вместо 14700 —
// молча, и такая цена ушла бы в заказ (эфир 2026-07-25, лоты 03028/03029).
// Читает число 1–999 из слов, начиная с i; возвращает null, если числа нет.
function readSmallNumber(norm, i) {
  let value = 0;
  let j = i;

  if (j < norm.length && HUNDREDS_WORDS.has(norm[j])) {
    value += HUNDREDS_WORDS.get(norm[j]);
    j += 1;
  }

  if (j < norm.length && TEEN_WORDS.has(norm[j])) {
    value += TEEN_WORDS.get(norm[j]);
    j += 1;
  } else {
    if (j < norm.length && TENS_WORDS.has(norm[j])) {
      value += TENS_WORDS.get(norm[j]);
      j += 1;
    }
    if (j < norm.length && UNIT_WORDS.has(norm[j])) {
      value += UNIT_WORDS.get(norm[j]);
      j += 1;
    }
  }

  return value > 0 ? { value, next: j } : null;
}

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

  // Разговорная форма без слова «тысяч»: «две сто» = 2100, «тринадцать двести»
  // = 13200, «девять двести пятьдесят» = 9250. Множитель — РОВНО одно слово:
  // окно берётся из середины реплики, и составной множитель превращал бы
  // «цена двадцать пять сто из них» в 25100 вместо 25. Форма реальная:
  // «стоимость тринадцать двести» (эфир 2026-06-28 19:11:46) читалась как 13 ₽.
  const colloquialHead = norm.length >= 2 && HUNDREDS_WORDS.has(norm[1])
    ? (UNIT_WORDS.get(norm[0]) ?? TEEN_WORDS.get(norm[0]) ?? TENS_WORDS.get(norm[0]))
    : undefined;
  if (typeof colloquialHead === "number") {
    let colloquialValue = colloquialHead * 1000 + HUNDREDS_WORDS.get(norm[1]);
    let cursor = 2;
    const colloquialRemainder = readSmallNumber(norm, cursor);
    if (colloquialRemainder && colloquialRemainder.value < 100) {
      colloquialValue += colloquialRemainder.value;
      cursor = colloquialRemainder.next;
    }
    if (cursor === norm.length) {
      return colloquialValue;
    }
  }

  // «N с половиной тысяч» — множитель здесь тоже любой. Ветка оставалась на
  // узком THOUSANDS_MULTIPLIERS (1..10) даже после того, как основной путь
  // перевели на readSmallNumber, поэтому «двенадцать с половиной тысяч»
  // по-прежнему давало 12 ₽ — тот же механизм отказа, та же цена ошибки.
  const half = readSmallNumber(norm, 0);
  const isHalfThousands = Boolean(half)
    && norm[half.next] === "с"
    && norm[half.next + 1] === "половиной"
    && THOUSAND_RE.test(norm[half.next + 2]);

  if (norm.length >= 2 && SESQUI_WORDS.has(norm[0]) && THOUSAND_RE.test(norm[1])) {
    value += 1500;
    i += 2;
  } else if (isHalfThousands) {
    value += half.value * 1000 + 500;
    i = half.next + 3;
  } else if (i < norm.length && THOUSAND_RE.test(norm[i])) {
    value += 1000;
    i += 1;
  } else {
    // Составной множитель: «две», «четырнадцать», «двадцать пять», «сто
    // двадцать» — всё, что читается как 1–999 и упирается в «тысяч*».
    const mult = readSmallNumber(norm, i);
    if (mult && THOUSAND_RE.test(norm[mult.next] || "")) {
      value += mult.value * 1000;
      i = mult.next + 1;
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
