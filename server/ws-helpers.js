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

export function getReservationReplyMessage(event, options = {}) {
  const code = options?.code || event?.lotCode || null;
  const codeSuffix = code ? ` (код ${code})` : "";
  const viewerName = String(event?.viewerName || "").trim();
  const namePrefix = viewerName ? `${viewerName}, ` : "";

  if (event.status === "out_of_stock") {
    // Бронь, дожидавшаяся цены, уезжает в хотелки тем же путём, что и «нет в
    // наличии» — но причина у неё другая, и «товара не хватило» покупателя
    // обманывает: товар был, цену не назвали.
    if (event.previousStatus === "pending_reservation") {
      return event.wishlistEntryId
        ? `${namePrefix}цену на этот лот${codeSuffix} в эфире так и не назвали. Добавили вас в список ожидания — свяжемся с вами.`
        : `${namePrefix}цену на этот лот${codeSuffix} в эфире так и не назвали, и добавить вас в список ожидания не удалось — оператор проверит вручную.`;
    }
    return event.wishlistEntryId
      ? `${namePrefix}товара не хватило${codeSuffix}. Добавили вас в список ожидания.`
      : `${namePrefix}товара не хватило${codeSuffix}, и автоматически добавить вас в список ожидания не удалось — оператор проверит вручную.`;
  }

  if (event.status === "product_not_found") {
    return "Товар не найден. Бронь не создана.";
  }

  if (event.status === "waitlist_pending") {
    return "Бронь принята. Вы в очереди, подтвердим следующим сообщением.";
  }

  // Цена лота ещё не прозвучала — позицию в заказ не пишем (иначе уйдёт по
  // 0 ₽), но и молчать нельзя: покупатель написал код и до этой правки не
  // получал ничего вообще, пока лот не закроется. По логам 13 эфиров 177 лотов
  // из 305 с нулевой ценой так и не дождались её, а на них 116 броней.
  if (event.status === "pending_reservation") {
    return `${namePrefix}бронь принята${codeSuffix}, ждём цену — подтвердим следующим сообщением.`;
  }

  // Этап 5: явно указываем код лота, чтобы покупатель видел, какой
  // именно артикул мы за ним закрепили — иначе при нескольких открытых
  // лотах непонятно, к чему относится reply.
  if (event.status === "reserved") {
    return `${event.viewerName}, бронь подтверждена${codeSuffix}.`;
  }

  if (event.status === "reserved_appended") {
    return `${event.viewerName}, бронь подтверждена${codeSuffix}. Товар добавлен в ваш заказ.`;
  }

  if (event.status === "order_failed") {
    if (event.wishlistEntryId) {
      return `${namePrefix}бронь создать не удалось${codeSuffix}. Добавили вас в список ожидания.`;
    }
    return "Не удалось обработать бронь. Напишите код товара ещё раз — можно так: \"03204\", \"бр 03204\", \"беру 03204\" или \"+03204\".";
  }

  return "";
}

// Ответ покупателю на его комментарий-отмену («отмена 03204»). Инструкция
// зрителям сама зовёт этот формат, но до 2026-08-04 отмена отвечала ТОЛЬКО
// оператору в дашборд: покупатель не видел ни успеха, ни отказа, и «заказ уже
// проведён» выглядел для него ровно как успешно снятая бронь.
//
// Три исхода намеренно разведены по текстам — обещать «снято», когда позиция
// осталась в заказе, хуже, чем молчать:
// - cancelled  — позиция реально удалена;
// - not_found  — брони за этим покупателем нет (чужой код, опечатка, уже сняли);
// - failed     — снять не удалось (проведённый заказ, safe-mode, сбой МойСклада),
//                разбирает оператор.
export function getCancelReplyMessage(outcome, options = {}) {
  const code = options?.code || null;
  const codeSuffix = code ? ` (код ${code})` : "";
  const viewerName = String(options?.viewerName || "").trim();
  const namePrefix = viewerName ? `${viewerName}, ` : "";

  if (outcome === "cancelled") {
    return `${namePrefix}бронь снята${codeSuffix}.`;
  }

  if (outcome === "not_found") {
    return `${namePrefix}брони${codeSuffix} за вами не нашли. Проверьте артикул.`;
  }

  if (outcome === "failed") {
    return `${namePrefix}не получилось снять бронь${codeSuffix} автоматически — оператор проверит вручную.`;
  }

  // Отмена без артикула: у покупателя может быть несколько броней, и сервер
  // не угадывает. Подсказываем ровно тот формат, что и в инструкции зрителям.
  if (outcome === "no_code") {
    return `${namePrefix}напишите артикул вместе с отменой — например «отмена 03204».`;
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
