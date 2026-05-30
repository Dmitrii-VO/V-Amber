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

const CYR = "а-яё";

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
  const codeMatch = CODE_RE.exec(normalized);
  const code = codeMatch ? codeMatch[1] : null;
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
