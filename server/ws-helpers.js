// Pure helpers extracted from ws-server.js — no closure state, no I/O.
// Easy to unit-test and reuse without spinning up a WebSocket session.

export const RESERVATION_HISTORY_LIMIT = 200;

export function sendJson(socket, payload) {
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify(payload));
  }
}

export function getVkPublicationCommentId(publication) {
  const rawValue = typeof publication === "number"
    ? publication
    : publication?.comment_id ?? publication?.commentId ?? null;

  if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue > 0) {
    return rawValue;
  }

  const parsed = Number.parseInt(String(rawValue || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getVkApiErrorCode(error) {
  if (typeof error?.vkErrorCode === "number" && Number.isFinite(error.vkErrorCode)) {
    return error.vkErrorCode;
  }

  const message = error instanceof Error ? error.message : String(error);
  const match = /VK API\s+(\d+):/i.exec(message);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatBroadcastDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function normalizeReservationCode(code) {
  return String(code || "").trim();
}

// Bounded FIFO-on-insert Set: re-inserting an id moves it to the most-recent
// position, and the oldest entries are dropped at the cap. Used to track
// seen-comment-ids / accepted-user-ids without unbounded memory growth on
// long live streams.
export function createBoundedIdSet(initial) {
  const set = new Set(Array.isArray(initial) ? initial : []);
  while (set.size > RESERVATION_HISTORY_LIMIT) {
    set.delete(set.values().next().value);
  }
  return set;
}

export function addBoundedId(set, id) {
  if (set.has(id)) {
    set.delete(id);
  }
  set.add(id);
  while (set.size > RESERVATION_HISTORY_LIMIT) {
    set.delete(set.values().next().value);
  }
}

export function hasUsableSalePrice(product) {
  const salePrice = product?.salePrice;
  return typeof salePrice === "number" && Number.isFinite(salePrice) && salePrice > 0;
}

export function getLotEffectivePrice(lot) {
  if (hasUsableSalePrice(lot?.product)) {
    return lot.product.salePrice;
  }
  const voicePrice = lot?.product?.voicePrice;
  return typeof voicePrice === "number" && Number.isFinite(voicePrice) && voicePrice > 0
    ? voicePrice
    : lot?.product?.salePrice;
}

export function getReservationReplyMessage(event) {
  // W6 — ручной режим: переполнение по остатку тихо уходит в лист ожидания
  // на стороне сервера (addWishlistFromComment), но покупателю публично
  // НИЧЕГО не пишем. Оператор работает со списком вручную. См.
  // knowledge/wiki/operator-feedback.md (W6).
  if (event.status === "out_of_stock") {
    return "";
  }

  if (event.status === "product_not_found") {
    return "Товар не найден. Бронь не создана.";
  }

  if (event.status === "waitlist_pending") {
    return "Бронь принята. Вы в очереди, подтвердим следующим сообщением.";
  }

  if (event.status === "reserved") {
    return `${event.viewerName}, бронь подтверждена.`;
  }

  if (event.status === "reserved_appended") {
    return `${event.viewerName}, бронь подтверждена. Товар добавлен в ваш заказ.`;
  }

  if (event.status === "order_failed") {
    return "Не удалось обработать бронь. Напишите код товара ещё раз — можно так: \"03204\", \"бр 03204\", \"беру 03204\" или \"+03204\".";
  }

  return "";
}

export function getCommittedReservationCount(state) {
  return Math.max(0, state?.committedReservationCount || 0);
}

// Genuinely unrecoverable for THIS video: access denied (15), bad params
// (100), video missing / comments closed (801). Auth errors (code 5) are
// LOUD but recoverable on token refresh.
export function isFatalCommentReadError(error) {
  const errorCode = getVkApiErrorCode(error);
  if (errorCode !== null) {
    return [15, 100, 801].includes(errorCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /video not found/i.test(message);
}
