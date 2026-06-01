// Парсер VK-комментариев под бронь и wishlist.
//
// Исторически бот принимал только строгий формат `бронь <код>`. По эфирам
// 24.05.2026 и до — клиенты регулярно теряли броню из-за того, что писали
// «беру 03204», «+03204», «хочу 03204», «забронируй 03204» и т.п., а парсер
// их игнорировал. Здесь — расширенный набор ключевых слов; код товара
// остаётся обязательным условием срабатывания.
//
// Контракт прежний: возвращаем `{ hasReservationKeyword, code }`. `code`
// нормализован (только цифры), `null` если код не нашли. Wishlist-намерение
// («список <код>») возвращает hasReservationKeyword=false, чтобы downstream
// прогнал текст через parseWishlistComment без двойной интерпретации.

// Используем явный кирилличный класс — \w в JS regex без флага `u` не
// захватывает кириллицу, из-за чего «бронь» не матчился /^брон\w*$/.
const CYR = "а-я";
const RESERVATION_TOKEN_PATTERNS = [
  /^бр$/,                              // короткий префикс «бр <код>»
  /^брн$/,                             // частая опечатка/сокращение
  /^брнь$/,
  new RegExp(`^брон[${CYR}]*$`),       // бронь, броню, бронируй, бронируйте, бронирую, бронируем, бронируется
  new RegExp(`^забронир[${CYR}]*$`),    // забронируй, забронируйте, забронирую
  /^беру$/,
  /^возьму$/,
  /^купл[ю]?$/,
  new RegExp(`^держ[${CYR}]*$`),        // держи, держите, держу, держат
  new RegExp(`^удерж[${CYR}]*$`),       // удержите, удержи
  /^хоч(?:у|ется)$/,
  /^мо[еяй]$/,                          // мое (ё уже нормализован → е), моя, мой
  new RegExp(`^забер[${CYR}]*$`),       // заберу, забери, заберите, заберем
  new RegExp(`^отлож[${CYR}]*$`),       // отложи, отложите, отложу
  /^плюс$/,
  /^беремся$/,
];

const PLUS_BEFORE_DIGIT = /\+\s*\d/;
const WISHLIST_INTENT = /(^|\s)список(\s|$|[:.,;!?-])/;
const DIGIT_RUN = /\d{2,6}/g;

function normalize(text) {
  return String(text || "").trim().toLowerCase().replace(/ё/g, "е");
}

function tokenize(normalized) {
  // Разрезаем по любому не-кириллическо-латинскому символу. Сохраняем «+»
  // как отдельный псевдо-токен только если он стоит рядом с цифрами —
  // это типичный livestream-сокращение «+ <код>».
  return normalized.split(/[^a-zа-я+]+/i).filter(Boolean);
}

function pickBestCode(normalized, preferredCode) {
  const matches = normalized.match(DIGIT_RUN);
  if (!matches || matches.length === 0) return null;
  // Если активный лот известен и его код встречается среди групп — выбираем
  // его. Спасает от «бронь 12, мой 89991234567» и «возьму 12 за 2500», где
  // самая длинная цифровая группа — это телефон или цена, а не код товара.
  if (preferredCode) {
    const trimmed = String(preferredCode).trim();
    if (trimmed && matches.includes(trimmed)) return trimmed;
  }
  // Иначе — самая длинная группа; при равной длине — последняя (обычно код
  // идёт после ключевого слова).
  let best = matches[0];
  for (const candidate of matches.slice(1)) {
    if (candidate.length >= best.length) best = candidate;
  }
  return best;
}

function hasReservationKeyword(normalized) {
  if (!normalized) return false;
  const tokens = tokenize(normalized);
  for (const token of tokens) {
    for (const pattern of RESERVATION_TOKEN_PATTERNS) {
      if (pattern.test(token)) return true;
    }
  }
  if (PLUS_BEFORE_DIGIT.test(normalized)) return true;
  return false;
}

// Голый код («03204») трактуется как бронь: в комментарии нет ничего, кроме
// цифр и пунктуации. Этого требовали клиенты — формат «бронь <код>» им был
// тяжёл. Любые буквы → нужен явный ключевой токен из RESERVATION_TOKEN_PATTERNS.
const BARE_CODE_ONLY = new RegExp(`^[^${CYR}a-z]*\\d{2,6}[^${CYR}a-z]*$`);

// Кап на quantity. Защита от опечаток («беру 100 03204») и от того, чтобы
// случайный шум вроде «250» не выкупил весь склад. Дашборд-настройки нет —
// если 10 окажется мало, поднимем по запросу.
const QUANTITY_HARD_CAP = 10;

// Маркеры количества. Кириллическая «х» (U+0445) и латинская «x» (U+0078)
// визуально неотличимы — поддерживаем обе.
// `\b` в JS regex без флага `u` не работает с кириллицей (нет word↔non-word
// перехода между «т» и пробелом), поэтому используем явные lookahead'ы
// `(?![${CYR}a-z])` / `(?<![${CYR}a-z])`.
const NOT_LETTER_AHEAD = `(?![${CYR}a-z])`;
const NOT_LETTER_BEHIND = `(?<![${CYR}a-z])`;
const QUANTITY_PATTERNS = [
  new RegExp(`(\\d+)\\s*шт(?:ук[аеиуов]?|уки)?${NOT_LETTER_AHEAD}`),   // «2 шт», «2шт», «2 штуки», «2 штук»
  new RegExp(`${NOT_LETTER_BEHIND}[xх]\\s*(\\d+)`),                     // «x2», «х 2», «03204 x2»
  /\*\s*(\d+)/,                                                          // «*2»
];

// Словесные количества: «две штуки», «три пары», «пять штук». Покупатели в
// VK-комментариях пишут именно так чаще, чем цифрой; до этого парсер ловил
// только «2 шт» и «*2». Покрываем 2..10 в типовых падежах. Коды — это
// всегда цифры, так что пересечений с DIGIT_RUN нет.
const WORD_QUANTITIES = new Map([
  ["две", 2], ["два", 2], ["двое", 2], ["двух", 2],
  ["три", 3], ["трое", 3], ["трёх", 3], ["трех", 3],
  ["четыре", 4], ["четверо", 4], ["четырех", 4], ["четырёх", 4],
  ["пять", 5], ["пятеро", 5], ["пяти", 5],
  ["шесть", 6], ["шестеро", 6], ["шести", 6],
  ["семь", 7], ["семеро", 7], ["семи", 7],
  ["восемь", 8], ["восьмеро", 8], ["восьми", 8],
  ["девять", 9], ["девятеро", 9], ["девяти", 9],
  ["десять", 10], ["десятеро", 10], ["десяти", 10],
]);
const WORD_QUANTITY_KEYS = [...WORD_QUANTITIES.keys()].join("|");
const PAIRS_MULTIPLIER = 2;
const WORD_QUANTITY_RE = new RegExp(
  `${NOT_LETTER_BEHIND}(${WORD_QUANTITY_KEYS})\\s+(шт(?:ук[аеиуов]?|уки)?|пар[ыуов]?|пара)${NOT_LETTER_AHEAD}`,
);
// Максимальное расстояние между словесным количеством и кодом товара (в
// токенах). 1 покрывает «бронь 03204 две штуки», «беру пять штук 03204»,
// «бронь 03204 пожалуйста две штуки», но блокирует «бронь 03204 а можно две
// пары серёг показать» (2+ слов между кодом и «две пары» — это описание
// желаемого, а не количество брони).
const MAX_QTY_TOKEN_DISTANCE = 1;

function isCloseToCode(normalized, match, code) {
  if (!code) return true; // без кода в результате — нет ориентира, доверяем
  const codeIdx = normalized.indexOf(code);
  if (codeIdx < 0) return true;
  const matchStart = match.index;
  const matchEnd = matchStart + match[0].length;
  // Берём промежуток МЕЖДУ совпадениями (qty…code или code…qty), не включая
  // сами куски — иначе слова из «пять штук» сами учитывались бы как
  // «расстояние».
  const between = matchEnd <= codeIdx
    ? normalized.slice(matchEnd, codeIdx)
    : normalized.slice(codeIdx + code.length, matchStart);
  const tokensBetween = between.split(/[^a-zа-я0-9]+/i).filter(Boolean);
  return tokensBetween.length <= MAX_QTY_TOKEN_DISTANCE;
}

function extractQuantity(normalized, code) {
  if (!normalized) return 1;
  // Словесное количество с единицей измерения: «две штуки», «три пары»,
  // «пять штук». Проверяем РАНЬШЕ одиночной «пары», иначе «три пары»
  // схлопывалось бы в 2 вместо 6.
  //
  // Требуем близости к коду (≤ MAX_QTY_TOKEN_DISTANCE токенов), иначе
  // «бронь 03204 а можно две пары серёг показать» давало бы 4 — покупатель
  // просто описывает желаемое, а не бронирует пары.
  const wordMatch = WORD_QUANTITY_RE.exec(normalized);
  if (wordMatch && isCloseToCode(normalized, wordMatch, code)) {
    const base = WORD_QUANTITIES.get(wordMatch[1]) || 1;
    const unit = wordMatch[2];
    const multiplier = /^пар/.test(unit) ? PAIRS_MULTIPLIER : 1;
    return Math.min(QUANTITY_HARD_CAP, base * multiplier);
  }
  // Одиночная «пара» = 2. Без захвата числа — самостоятельный лексический
  // маркер. Для «3 пары» используем цифру + регексп ниже или WORD_QUANTITY_RE
  // («три пары») выше.
  if (new RegExp(`${NOT_LETTER_BEHIND}пара${NOT_LETTER_AHEAD}`).test(normalized)) {
    return Math.min(QUANTITY_HARD_CAP, 2);
  }
  for (const pattern of QUANTITY_PATTERNS) {
    const match = pattern.exec(normalized);
    if (match) {
      const n = parseInt(match[1], 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      // Защита от случая, когда наш «маркер» захватил сам код:
      // «беру 03204 шт» теоретически дал бы quantity=03204. На практике
      // код 5 цифр без шт рядом, но защищаемся явно.
      if (code && match[1] === code) continue;
      return Math.min(QUANTITY_HARD_CAP, Math.max(1, n));
    }
  }
  return 1;
}

export function parseReservationComment(text, options = {}) {
  const { preferredCode = null } = options;
  const normalized = normalize(text);
  if (!normalized) return { hasReservationKeyword: false, code: null, quantity: 1 };
  // Wishlist имеет приоритет: «список 03220» не должен считаться бронью,
  // даже если позже мы добавим «список» в список синонимов брони.
  if (WISHLIST_INTENT.test(normalized) || normalized === "список") {
    return { hasReservationKeyword: false, code: null, quantity: 1 };
  }
  if (BARE_CODE_ONLY.test(normalized)) {
    const code = pickBestCode(normalized, preferredCode);
    // Голый код — букв нет, маркеров шт/x/пара тоже не будет; quantity=1.
    return { hasReservationKeyword: true, code, quantity: 1 };
  }
  if (!hasReservationKeyword(normalized)) {
    return { hasReservationKeyword: false, code: null, quantity: 1 };
  }
  const code = pickBestCode(normalized, preferredCode);
  return {
    hasReservationKeyword: true,
    code,
    quantity: extractQuantity(normalized, code),
  };
}

export function parseWishlistComment(text) {
  const normalized = normalize(text);
  if (!normalized) return { hasWishlistKeyword: false, code: null };
  const match = /^список[\s:.,;!?-]+(\d+)\s*[.,;!?]*$/.exec(normalized);
  if (!match) {
    return {
      hasWishlistKeyword: normalized === "список" || normalized.startsWith("список "),
      code: null,
    };
  }
  return { hasWishlistKeyword: true, code: match[1] };
}
