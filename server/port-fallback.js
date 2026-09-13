// Что делать, когда порт занят.
//
// Раньше ответ был один: «V-Amber уже запущен» и выход. 13.09.2026 выяснилось,
// что занять 8080 может кто угодно — на машине разработчика это сделал
// веб-интерфейс qBittorrent, и оператор в такой ситуации увидел бы чужую
// страницу вместо дашборда (или на macOS — стек-трейс EADDRINUSE в Terminal).
//
// Различать эти два случая обязательно: поднять вторую копию V-Amber рядом
// нельзя (два эфира, двойные публикации в ВК), а уступить порт чужому
// приложению — наоборот, единственно верное поведение.

// Узнаём себя по разметке: и страница входа, и дашборд несут эти строки.
// Чужое приложение на том же порту их не содержит.
export function looksLikeVAmber(body) {
  return /V-Amber|Amberry Voice/i.test(String(body || ""));
}

// Кандидаты на замену занятого порта: следующие по порядку, чтобы адрес
// оставался предсказуемым (8080 → 8081 → 8082…), а не случайным.
export function nextPortCandidates(port, count = 10) {
  const base = Number(port);
  if (!Number.isInteger(base) || base < 1 || base > 65535) {
    return [];
  }
  const candidates = [];
  for (let offset = 1; offset <= count && base + offset <= 65535; offset += 1) {
    candidates.push(base + offset);
  }
  return candidates;
}

// Кто занял порт: наша вторая копия или чужое приложение. Сетевая ошибка и
// таймаут — это «не мы»: если бы там был V-Amber, он бы ответил.
export async function isOwnInstanceOnPort(port, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    return looksLikeVAmber(body);
  } catch {
    return false;
  }
}
