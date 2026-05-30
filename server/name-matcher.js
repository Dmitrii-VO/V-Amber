// Сопоставление произнесённого оператором имени с именами зрителей из VK.
//
// Зачем: оператор голосом отменяет бронь конкретного покупателя — например
// «Галина Прокофьева отмена лота #033322». SpeechKit отдаёт имя в свободной
// форме (склонение «Галину Прокофьеву», обратный порядок «Прокофьева
// Галина», только имя «Галина»). VK же хранит «Имя Фамилия» в именительном.
// Строгое равенство тут не работает — матчим по основам токенов.
//
// Контракт чистый: никакого I/O и состояния. См. knowledge/wiki/
// operator-feedback.md (W3).

const CYR = "а-яё";

// Кириллические окончания, которые стоит срезать перед сравнением основ,
// чтобы «галину» ~ «галина», «прокофьеву» ~ «прокофьева». Список намеренно
// консервативный: режем только однозначные падежные хвосты, иначе короткие
// имена схлопнутся друг в друга. Длина основы после среза не опускается
// ниже STEM_MIN_LENGTH.
const CASE_ENDINGS = [
  "ою", "ею", "ой", "ей", "ом", "ем", "ых", "ами", "ями",
  "ва", "ву", "ве", "вой", "вы", // -ов/-ев фамилии в косвенных (прокофьев-)
  "а", "у", "е", "ы", "и", "о", "ю", "я", "й",
];

const STEM_MIN_LENGTH = 3;

export function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(new RegExp(`[^${CYR}\\s-]`, "g"), " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeName(value) {
  const normalized = normalizeName(value);
  if (!normalized) return [];
  return normalized.split(" ").filter(Boolean);
}

// Срезаем самое длинное подходящее падежное окончание, не уводя основу
// короче STEM_MIN_LENGTH. «прокофьева» → «прокофь», «галину» → «галин».
export function stemToken(token) {
  const t = String(token || "");
  if (t.length <= STEM_MIN_LENGTH) return t;
  let best = t;
  for (const ending of CASE_ENDINGS) {
    if (t.length - ending.length >= STEM_MIN_LENGTH && t.endsWith(ending)) {
      const candidate = t.slice(0, t.length - ending.length);
      if (candidate.length < best.length) best = candidate;
    }
  }
  return best;
}

// Два токена «совпадают», если основа одного — префикс основы другого.
// Префиксность (а не равенство) ловит и склонения, которые наш список
// окончаний не покрыл, и усечения SpeechKit.
function tokensMatch(a, b) {
  const sa = stemToken(a);
  const sb = stemToken(b);
  if (!sa || !sb) return false;
  const shorter = sa.length <= sb.length ? sa : sb;
  const longer = sa.length <= sb.length ? sb : sa;
  if (shorter.length < STEM_MIN_LENGTH) return sa === sb;
  return longer.startsWith(shorter);
}

// Доля токенов произнесённого имени (spoken), нашедших пару в имени
// кандидата (candidate). Порядок слов не важен; каждый токен кандидата
// расходуется не более одного раза. Возвращаем [0..1].
export function scoreNameMatch(spoken, candidate) {
  const spokenTokens = tokenizeName(spoken);
  const candidateTokens = tokenizeName(candidate);
  if (spokenTokens.length === 0 || candidateTokens.length === 0) return 0;

  const used = new Array(candidateTokens.length).fill(false);
  let matched = 0;
  for (const st of spokenTokens) {
    for (let i = 0; i < candidateTokens.length; i += 1) {
      if (used[i]) continue;
      if (tokensMatch(st, candidateTokens[i])) {
        used[i] = true;
        matched += 1;
        break;
      }
    }
  }
  return matched / spokenTokens.length;
}

const DEFAULT_MIN_SCORE = 0.5;

// Ищем кандидатов по списку { id, name }. Возвращаем отсортированный по
// убыванию score список совпадений. НИКОГДА не выбираем «самого похожего»
// автоматически — это решает вызывающий код, потому что неоднозначность тут =
// риск отменить чужую бронь (реальные деньги).
//
// Порог: для имени из ОДНОГО токена допускаем minScore (короткое «Галина»).
// Для имени из 2+ токенов требуем ПОЛНОЕ совпадение всех токенов (score=1):
// иначе «Галина Прокофьева» матчила бы «Галина Сидорова» со score 0.5 по
// одному общему имени — и при отсутствии лучшего кандидата отменилась бы
// чужая бронь. Чем больше оператор сказал, тем строже сверяем.
export function matchNameAgainst(spoken, candidates, { minScore = DEFAULT_MIN_SCORE } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const spokenTokenCount = tokenizeName(spoken).length;
  const requiredScore = spokenTokenCount >= 2 ? 1 : minScore;
  const scored = [];
  for (const candidate of list) {
    if (!candidate) continue;
    const name = candidate.name ?? candidate.viewerName ?? "";
    const score = scoreNameMatch(spoken, name);
    if (score >= requiredScore) {
      scored.push({ ...candidate, name, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
