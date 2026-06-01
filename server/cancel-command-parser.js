// Распознавание голосовой команды отмены брони из речи оператора.
//
// Формат (W3): «<Имя Фамилия> отмена лота #<код>», например
// «Галина Прокофьева отмена лота #033322». Допускаем вариации:
// «отмена брони», «отменить лот», «снять бронь», «убрать бронь», код с «#»
// или без, имя до или (реже) после команды.
//
// Контракт чистый: возвращаем { matched, name, code } либо
// { matched:false }. Само сопоставление имени с зрителями и отмену делает
// вызывающий код — здесь только разбор фразы. См. knowledge/wiki/
// operator-feedback.md (W3).

import { UNIT_WORDS as UNIT_WORDS_BASE } from "./ru-numerals.js";

const CYR = "а-яё";

// Слова-цифры (тот же словарь, что в article-extractor.js: единицы 1-9 +
// «ноль»/«нуль»). Держим локальную карту word→"digit", чтобы парсер кода
// в фразе отмены принимал словесные коды вроде «ноль один ноль пять девять»
// (≡ 01059). Без этого регулярка #?\s*(\d{2,6}) терпит fail на самой
// естественной речевой форме («Дмитрий Васильев отменил бронь ноль один…»),
// и голосовая отмена молча не срабатывает — оператор лезет искать бронь
// в МойСкладе вручную.
const DIGIT_WORDS = new Map(
  [
    ...UNIT_WORDS_BASE,
    ["ноль", 0], ["ноля", 0], ["нуль", 0],
  ].map(([word, value]) => [word, String(value)]),
);

function normalize(text) {
  return String(text || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

// Триггер команды: «отмен|сним|убер|удал» + «лот|брон». Порядок этих двух
// слов может быть любым («отмена лота», «лот отменить», «снять бронь»).
const CANCEL_VERB = `(?:отмен[${CYR}]*|снят[${CYR}]*|сним[${CYR}]*|убер[${CYR}]*|убра[${CYR}]*|удал[${CYR}]*)`;
const CANCEL_NOUN = `(?:лот[${CYR}]*|брон[${CYR}]*)`;

const TRIGGER_RE = new RegExp(
  `(?:${CANCEL_VERB}\\s+${CANCEL_NOUN}|${CANCEL_NOUN}\\s+${CANCEL_VERB})`,
);

const CODE_RE = /#?\s*(\d{2,6})/;

export function parseCancelCommand(text) {
  const normalized = normalize(text);
  if (!normalized) return { matched: false };

  const triggerMatch = TRIGGER_RE.exec(normalized);
  if (!triggerMatch) return { matched: false };

  // Код ищем во всём тексте (обычно после команды: «...лота #033322»).
  // Сначала пробуем цифровую запись, затем — словесную («ноль один ноль…»),
  // которую оператор произносит чаще всего, когда диктует код вслух.
  const codeMatch = CODE_RE.exec(normalized);
  const code = codeMatch
    ? codeMatch[1]
    : extractDigitWordsCode(normalized.slice(triggerMatch.index + triggerMatch[0].length));
  if (!code) return { matched: false };

  // Имя — то, что стоит ДО триггера. Это самый надёжный кусок: оператор
  // называет покупателя, затем команду. Из хвоста после триггера имя не
  // берём, чтобы не захватить «лота» / номер кода как имя.
  const beforeTrigger = normalized.slice(0, triggerMatch.index).trim();
  const name = extractName(beforeTrigger);
  if (!name) return { matched: false };

  return { matched: true, name, code };
}

// Берём из префикса последние 1-3 кириллических слова как имя. Чистим
// вводные («так», «давай», «значит» и т.п.) с начала, оставляя хвост,
// который и есть «Имя [Отчество] Фамилия».
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

  // Срезаем вводные слова с начала.
  let start = 0;
  while (start < tokens.length && FILLER.has(tokens[start])) start += 1;
  const nameTokens = tokens.slice(start);
  if (nameTokens.length === 0) return "";

  // Имя — не более 3 последних токенов (Имя Отчество Фамилия).
  return nameTokens.slice(-3).join(" ");
}

// Склеиваем последовательные слова-цифры в код («ноль один ноль пять девять»
// → «01059»). Берём ПЕРВЫЙ непрерывный отрезок длиной 2..6 — это совпадает
// с CODE_RE и с реальной длиной артикулов V-Amber.
//
// Защиты от ложных срабатываний (отмена — это списание реальных денег):
// - перед первой цифрой допустимо лишь несколько служебных слов
//   («код», «товара», «номер»), иначе пропускаем; иначе случайное
//   «...пожалуйста один два...» собралось бы в код «12»;
// - длиннее 6 цифр — не усекаем молча, а отказываемся: лишние цифры значат,
//   что распознавание захватило цену/количество, и подсветка попала бы не
//   в тот лот.
const PRE_CODE_FILLER = new Set([
  "код", "кода", "коду", "товара", "номер", "номера", "это", "вот", "пожалуйста",
]);
const MIN_CODE_LEN = 2;
const MAX_CODE_LEN = 6;

function extractDigitWordsCode(tail) {
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
