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

function extractQuantity(normalized, code) {
  if (!normalized) return 1;
  // «пара» = 2. Без отдельного захвата чисел — самостоятельный лексический
  // маркер. Если оператор хотел «3 пары», пусть напишет цифрой.
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
