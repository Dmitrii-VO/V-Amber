// Распознавание голосовой команды «добавить N штук покупателю».
//
// Формат: «<Имя Фамилия> добавь N шт/пар #<код>».
// Допускаем: «добавь/добавьте/добавить/запиши/плюс», «штук/штуки/шт/пара/пары»,
// цифровой код или словесный («ноль три два ноль четыре»), словесное или
// цифровое количество («две», «5»). Имя — до триггера, как в cancel-парсере.
//
// Контракт: { matched: true, name, quantity, code } или { matched: false }.
// САМ парсер денег не двигает — вызывающий код подсвечивает строку в UI и
// ждёт явного подтверждения оператора. Это сознательно: ошибка
// распознавания → лишняя позиция в МойСкладе = реальные деньги.

import { UNIT_WORDS as UNIT_WORDS_BASE } from "./ru-numerals.js";

const CYR = "а-яё";

// Словари совпадают с cancel-command-parser.js, чтобы поведение по коду
// и количеству оставалось согласованным.
const DIGIT_WORDS = new Map(
  [
    ...UNIT_WORDS_BASE,
    ["ноль", 0], ["ноля", 0], ["нуль", 0],
  ].map(([word, value]) => [word, String(value)]),
);

const QUANTITY_WORDS = new Map([
  ["один", 1], ["одну", 1], ["одна", 1],
  ["два", 2], ["две", 2], ["двое", 2],
  ["три", 3], ["трое", 3],
  ["четыре", 4], ["четверо", 4],
  ["пять", 5], ["пятеро", 5],
  ["шесть", 6], ["шестеро", 6],
  ["семь", 7], ["семеро", 7],
  ["восемь", 8], ["восьмеро", 8],
  ["девять", 9], ["девятеро", 9],
  ["десять", 10], ["десятеро", 10],
]);

const QUANTITY_HARD_CAP = 10;

// Глагол явного намерения. Без него фраза «Анна две штуки 03204» — это
// просто описание (буквенный пересказ комментария покупателя), а не команда
// оператора. Намеренно НЕ кладём сюда «бронь» — этот глагол уже триггерит
// reservation parser на стороне покупателя.
const VERB_RE = new RegExp(
  `(?:добав[${CYR}]*|запиш[${CYR}]*|поставь[${CYR}]*|поменя[${CYR}]*|измен[${CYR}]*|плюс)`,
);

// Единица измерения. Те же варианты, что в reservation-parser.js
// (шт/штук/штуки/штука/пара/пары), плюс «штуки» в косвенных падежах.
const UNIT_RE = new RegExp(`(?:шт(?:ук[${CYR}]*)?|пар[${CYR}]*)`);

const CODE_RE = /#?\s*(\d{2,6})/;

const MIN_CODE_LEN = 2;
const MAX_CODE_LEN = 6;

const PRE_CODE_FILLER = new Set([
  "код", "кода", "коду", "товара", "номер", "номера", "это", "вот", "пожалуйста",
]);

function normalize(text) {
  return String(text || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

export function parseQuantityCommand(text) {
  const normalized = normalize(text);
  if (!normalized) return { matched: false };

  const verbMatch = VERB_RE.exec(normalized);
  if (!verbMatch) return { matched: false };

  // После глагола обязательно ищем количество + единицу измерения. Без
  // единицы цифра/слово может быть кодом, не количеством, — мы НЕ хотим
  // угадывать.
  const tailAfterVerb = normalized.slice(verbMatch.index + verbMatch[0].length);
  const quantity = extractQuantityWithUnit(tailAfterVerb);
  if (!quantity) return { matched: false };

  // Код ищем там, где он естественно стоит — обычно после количества.
  const tailAfterQty = tailAfterVerb.slice(quantity.consumed);
  const code = extractCode(tailAfterQty);
  if (!code) return { matched: false };

  const beforeVerb = normalized.slice(0, verbMatch.index).trim();
  const name = extractName(beforeVerb);
  if (!name) return { matched: false };

  return { matched: true, name, quantity: quantity.value, code };
}

function extractQuantityWithUnit(tail) {
  // `\b` в JS regex без флага `u` не работает с кириллицей (нет word↔
  // non-word перехода между «и» и пробелом). Используем явный «конец
  // токена» — пробел, конец строки или знак препинания.
  const END = `(?=$|[^${CYR}])`;
  // Сначала пробуем словесный формат («две штуки», «пять штук»). Цифра
  // («2 шт») идёт следом — реже в речи, но возможна при наговоре чисел.
  const wordRe = new RegExp(
    `^\\s*(${[...QUANTITY_WORDS.keys()].join("|")})\\s+(${UNIT_RE.source})${END}`,
  );
  const wordMatch = wordRe.exec(tail);
  if (wordMatch) {
    const base = QUANTITY_WORDS.get(wordMatch[1]) || 1;
    const multiplier = /^пар/.test(wordMatch[2]) ? 2 : 1;
    return {
      value: Math.min(QUANTITY_HARD_CAP, base * multiplier),
      consumed: wordMatch[0].length,
    };
  }

  const digitRe = new RegExp(`^\\s*(\\d{1,2})\\s*(${UNIT_RE.source})${END}`);
  const digitMatch = digitRe.exec(tail);
  if (digitMatch) {
    const n = Number.parseInt(digitMatch[1], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    const multiplier = /^пар/.test(digitMatch[2]) ? 2 : 1;
    return {
      value: Math.min(QUANTITY_HARD_CAP, n * multiplier),
      consumed: digitMatch[0].length,
    };
  }

  return null;
}

function extractCode(tail) {
  const codeMatch = CODE_RE.exec(tail);
  if (codeMatch) return codeMatch[1];

  const tokens = String(tail || "")
    .split(" ")
    .map((t) => t.replace(new RegExp(`[^${CYR}]`, "g"), ""))
    .filter(Boolean);

  let i = 0;
  while (i < tokens.length && PRE_CODE_FILLER.has(tokens[i])) i += 1;

  const chunks = [];
  while (i < tokens.length && DIGIT_WORDS.has(tokens[i])) {
    chunks.push(DIGIT_WORDS.get(tokens[i]));
    i += 1;
  }

  if (chunks.length < MIN_CODE_LEN || chunks.length > MAX_CODE_LEN) return null;
  return chunks.join("");
}

const FILLER = new Set([
  "так", "давай", "давайте", "значит", "ну", "вот", "это", "так-то",
  "пожалуйста", "итак", "и", "а",
]);

function extractName(prefix) {
  const tokens = String(prefix || "")
    .split(" ")
    .map((t) => t.replace(new RegExp(`[^${CYR}-]`, "g"), ""))
    .filter(Boolean);
  if (tokens.length === 0) return "";

  let start = 0;
  while (start < tokens.length && FILLER.has(tokens[start])) start += 1;
  const nameTokens = tokens.slice(start);
  if (nameTokens.length === 0) return "";

  return nameTokens.slice(-3).join(" ");
}
