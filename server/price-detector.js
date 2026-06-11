import { UNIT_WORDS, parseMonetaryWords } from "./ru-numerals.js";

// Ноль обрабатывается отдельно от UNIT_WORDS: при посимвольном чтении цифр
// «ноль» даёт «0», но в parseMonetaryWords нулём числительное не наращивают.
const ZERO_WORDS = new Set(["ноль", "нуль"]);

// Триггеры — с падежными формами: «по цене 990» и «стоимостью 1500» раньше
// молча давали null, потому что принимались только именительные формы.
const PRICE_TRIGGERS = new Set([
  "стоимость", "стоимости", "стоимостью",
  "цена", "цены", "цене", "цену", "ценой", "ценник",
  "стоит",
]);
const FILLER_WORDS = new Set(["такая", "такой", "такое", "то", "вот", "будет", "рублей", "рубля", "рубль", "руб"]);

// Не-денежные единицы измерения сразу после числа: «стоит посмотреть на
// 5 минут» — это НЕ цена 5 ₽. Точные токены, а не префиксы, чтобы случайно
// не зарезать легитимную цену перед началом новой фразы («1500 штука
// классная» не должна пострадать — «штука» здесь не в списке).
const NON_MONEY_UNITS = new Set([
  "минут", "минуты", "минуту", "минутки", "секунд", "секунды",
  "час", "часа", "часов", "дня", "дней", "день",
  "недели", "недель", "месяц", "месяца", "месяцев",
  "лет", "год", "года", "раз", "раза",
  "процент", "процента", "процентов",
  "штук", "штуки", "пар", "пары",
  "грамм", "граммов", "карат", "каратов",
  "сантиметра", "сантиметров", "миллиметра", "миллиметров",
]);

function normalizeWord(word) {
  return word.toLowerCase().replace(/ё/g, "е");
}

function tokenize(text) {
  return String(text || "").toLowerCase().replace(/ё/g, "е").match(/[a-zа-я0-9]+/gi) || [];
}

function isNonMoneyUnit(token) {
  return token !== undefined && NON_MONEY_UNITS.has(token);
}

// Посимвольное чтение цифр: «два пять пять ноль» → 2550. Принимает и
// цифровые токены вперемешку со словами («2 пять 5 0»), потому что SpeechKit
// нормализует часть слов в цифры. Требуем минимум 3 токена, чтобы «два пять»
// не превращалось в 25 (оператор сказал бы «двадцать пять»). Верхняя граница
// 6 — артикулы и длинные последовательности в цены не пускаем.
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

// Цифровая запись с пробелом-разделителем тысяч: SpeechKit отдаёт «1 500» /
// «2 500 рублей» отдельными токенами, и раньше цена схлопывалась в первый
// токен (1 ₽ вместо 1500 ₽ — реальные кейсы из транскриптов). Голова — 1-3
// цифры без ведущего нуля, дальше одна-две группы ровно по 3 цифры.
function parseGroupedDigits(tokens, start) {
  if (!/^[1-9]\d{0,2}$/.test(tokens[start] || "")) return null;
  let raw = tokens[start];
  let consumed = 1;
  while (consumed <= 2 && /^\d{3}$/.test(tokens[start + consumed] || "")) {
    raw += tokens[start + consumed];
    consumed += 1;
  }
  if (consumed === 1) return null;
  return { value: Number.parseInt(raw, 10), consumed };
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

      // Сначала «цифровой» разбор (два пять пять ноль / 2 5 5 0): он жаднее
      // и точнее для длинных последовательностей. Идёт ДО одиночного
      // цифрового токена, иначе «цена 2 5 5 0» вернула бы 2 ₽ — словесная
      // форма этого бага была закрыта раньше, а цифровая (SpeechKit
      // нормализует слова в цифры) воспроизводилась до этого фикса.
      for (let len = Math.min(6, tokens.length - j); len >= 3; len -= 1) {
        const words = tokens.slice(j, j + len);
        if (words.some((word) => FILLER_WORDS.has(word))) continue;
        const value = parseSpokenDigits(words);
        if (value && value > 0 && !isNonMoneyUnit(tokens[j + len])) {
          return { value, trigger: tokens[i] };
        }
      }

      const grouped = parseGroupedDigits(tokens, j);
      if (grouped && !isNonMoneyUnit(tokens[j + grouped.consumed])) {
        return { value: grouped.value, trigger: tokens[i] };
      }

      const digitValue = parseNumericToken(tokens[j]);
      if (digitValue && digitValue > 0 && !isNonMoneyUnit(tokens[j + 1])) {
        return { value: digitValue, trigger: tokens[i] };
      }

      // Стандартный разбор (тысяча пятьсот пятьдесят).
      // Окно до 6 слов, чтобы «две тысячи двести девяносто пять» (5 слов)
      // и аналогичные полные формы не теряли последнее слово — до этого
      // лимит 4 срезал «пять» из 2295 и отдавал 2290 (см. транскрипт
      // 2026-05-24 19:37:29 «пятёрку почему-то не распознаёт на конце»).
      // parseMonetaryWords требует полного потребления окна, так что окно
      // нельзя расширить «случайным» хвостом — оно либо съест всё, либо
      // вернёт null.
      for (let len = Math.min(6, tokens.length - j); len >= 1; len -= 1) {
        const words = tokens.slice(j, j + len);
        if (words.some((word) => FILLER_WORDS.has(word))) continue;
        const value = parseMonetaryWords(words);
        if (value && value > 0 && !isNonMoneyUnit(tokens[j + len])) {
          return { value, trigger: tokens[i] };
        }
      }
    }
  }

  return null;
}
