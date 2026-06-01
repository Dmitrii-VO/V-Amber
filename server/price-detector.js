import {
  UNIT_WORDS,
  TEEN_WORDS,
  TENS_WORDS,
  HUNDREDS_WORDS,
  THOUSANDS_MULTIPLIERS,
} from "./ru-numerals.js";

// Ноль обрабатывается отдельно от UNIT_WORDS: при посимвольном чтении цифр
// «ноль» даёт «0», но в parseMonetaryWords нулём числительное не наращивают.
const ZERO_WORDS = new Set(["ноль", "нуль"]);

const PRICE_TRIGGERS = new Set(["стоимость", "цена", "ценник", "стоит"]);
const FILLER_WORDS = new Set(["такая", "такой", "такое", "то", "вот", "будет", "рублей", "рубля", "рубль", "руб"]);

function normalizeWord(word) {
  return word.toLowerCase().replace(/ё/g, "е");
}

function tokenize(text) {
  return String(text || "").toLowerCase().replace(/ё/g, "е").match(/[a-zа-я0-9]+/gi) || [];
}

// Посимвольное чтение цифр: «два пять пять ноль» → 2550.
// Требуем минимум 3 цифр-слова, чтобы «два пять» не превращалось в 25
// (оператор сказал бы «двадцать пять»). Верхняя граница 6 — артикулы и
// длинные последовательности в цены не пускаем.
function parseSpokenDigits(words) {
  const norm = words.map(normalizeWord);
  if (norm.length < 3 || norm.length > 6) return null;
  let result = "";
  for (const w of norm) {
    if (/^\d+$/.test(w)) {
      result += w;
    } else if (UNIT_WORDS.has(w)) {
      result += UNIT_WORDS.get(w);
    } else if (ZERO_WORDS.has(w)) {
      result += "0";
    } else {
      return null;
    }
  }
  const value = Number.parseInt(result, 10);
  return value > 0 ? value : null;
}

function parseMonetaryWords(words) {
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

  if (i < norm.length && /^тысяч[ауи]?$/.test(norm[i])) {
    value += 1000;
    i += 1;
  } else if (i + 1 < norm.length && /^тысяч[ауи]?$/.test(norm[i + 1])) {
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

function parseNumericToken(token) {
  return /^\d+$/.test(token) ? Number.parseInt(token, 10) : null;
}

export function detectPrice(text) {
  const tokens = tokenize(text);

  for (let i = 0; i < tokens.length; i += 1) {
    if (!PRICE_TRIGGERS.has(tokens[i])) continue;

    for (let j = i + 1; j < Math.min(tokens.length, i + 8); j += 1) {
      if (FILLER_WORDS.has(tokens[j])) continue;

      const digitValue = parseNumericToken(tokens[j]);
      if (digitValue && digitValue > 0) {
        return { value: digitValue, trigger: tokens[i] };
      }

      // Пробуем сначала «цифровой» разбор (два пять пять ноль), он жаднее
      // и точнее для длинных последовательностей.
      for (let len = Math.min(6, tokens.length - j); len >= 3; len -= 1) {
        const words = tokens.slice(j, j + len);
        if (words.some((word) => FILLER_WORDS.has(word))) continue;
        const value = parseSpokenDigits(words);
        if (value && value > 0) {
          return { value, trigger: tokens[i] };
        }
      }

      // Стандартный разбор (тысяча пятьсот пятьдесят).
      // Окно до 6 слов, чтобы «две тысячи двести девяносто пять» (5 слов)
      // и аналогичные полные формы не теряли последнее слово — до этого
      // лимит 4 срезал «пять» из 2295 и отдавал 2290 (см. транскрипт
      // 2026-05-24 19:37:29 «пятёрку почему-то не распознаёт на конце»).
      // parseMonetaryWords требует i === norm.length, так что окно нельзя
      // расширить «случайным» хвостом — оно либо съест всё, либо вернёт null.
      for (let len = Math.min(6, tokens.length - j); len >= 1; len -= 1) {
        const words = tokens.slice(j, j + len);
        if (words.some((word) => FILLER_WORDS.has(word))) continue;
        const value = parseMonetaryWords(words);
        if (value && value > 0) {
          return { value, trigger: tokens[i] };
        }
      }
    }
  }

  return null;
}

