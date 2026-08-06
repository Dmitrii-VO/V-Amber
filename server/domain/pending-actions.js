// Однократные токены действий оператора.
//
// Клиенту нельзя верить: appendReservationQuantity и «забронировать из строки
// внимания» — это прямая запись позиции в МойСклад, и WS-сообщение с
// произвольными viewerId/commentId/quantity создало бы чужую позицию (HIGH из
// opencode review 2026-06-01). Поэтому сервер выдаёт actionId, а проверенные
// значения держит у себя; клиент возвращает только токен.
//
// Токен намеренно НЕ тратится на чтении (peek, а не take): при сбое МойСклада
// оператор должен повторить тем же кликом. От двойного клика это не защищает —
// обработчик сообщений не сериализован; защита от повторной записи живёт в
// журнале идемпотентности, а не здесь.
//
// Две копии этой машинерии (у «+N штук» и у строки внимания) отличались только
// TTL и наличием подрезки по размеру, а логика протухания совпадала слово в
// слово.

import { randomUUID } from "node:crypto";

// max — потолок числа живых токенов. Нужен там, где токены копятся весь эфир
// (баннер внимания): без него map растёт до конца сессии. Где токен живёт
// минуту и тратится сразу, потолок не нужен.
export function createPendingActions({ ttlMs, max = Infinity, now = Date.now } = {}) {
  const entries = new Map();

  function trim() {
    if (entries.size <= max) return;
    // Сначала просроченные, затем самые старые: Map хранит порядок вставки.
    const ts = now();
    for (const [key, value] of entries) {
      if (value.expiresAt < ts) entries.delete(key);
    }
    while (entries.size > max) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    issue(payload) {
      const actionId = randomUUID();
      entries.set(actionId, { ...payload, expiresAt: now() + ttlMs });
      trim();
      return actionId;
    },

    // Читает без траты токена. Протухший подчищает здесь же.
    peek(actionId) {
      if (!actionId) return null;
      const pending = entries.get(actionId);
      if (!pending) return null;
      if (pending.expiresAt < now()) {
        entries.delete(actionId);
        return null;
      }
      return pending;
    },

    delete(actionId) {
      return entries.delete(actionId);
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}
