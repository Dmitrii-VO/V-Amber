// Карточка лота на странице зрителя /efir/.
//
// В VK лот показывается комментарием-карточкой (vk.publishLotCard), а на своей
// площадке до этого не показывался вообще: зритель слышал «артикул 03204», но
// на экране не было ни названия, ни цены, ни фото (замечание Романа).
// Здесь тот же лот уезжает в chat-service (POST /chat/lot), который держит
// ОДНУ текущую карточку и отдаёт её вместе с лентой чата.
//
// Отличие от VK-канала: там каждое изменение — новый комментарий, здесь
// карточка одна и переписывается на месте. Поэтому публикатор дедупит по
// сигнатуре — эфир зовёт emitState() десятки раз в минуту (транскрипты,
// брони), а слать в облако нужно только реальные изменения лота.
//
// Канал строго best-effort: любая ошибка чата — WARN в лог и ничего больше,
// эфир и МойСклад от неё не зависят.

import { getLotEffectivePrice } from "./ws-helpers.js";

// Фото приходит из МойСклада байтами (публичной ссылки на картинку нет —
// только href под авторизацией). Ограничение зеркалит MAX_LOT_PHOTO_BYTES
// в deploy/chat-service/server.js: больше — шлём карточку без фото, а не
// ловим 400 на той стороне.
export const MAX_LOT_PHOTO_BYTES = 1_500_000;

// Как часто подтверждаем карточку, пока она висит без изменений. Карточка на
// той стороне персистится, но показывается зрителям только пока подтверждается
// (LOT_TTL_MS в deploy/chat-service/server.js, 20 минут — четыре такта): если
// V-Amber упал или ноутбук закрыли, не остановив эфир, зритель не должен до
// следующего эфира смотреть на лот со старой ценой. Дедуп по сигнатуре тут не
// поможет — он как раз про «ничего не изменилось».
export const LOT_HEARTBEAT_MS = 5 * 60_000;

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// Снимок лота в том виде, в каком его видит зритель.
export function buildViewerLot(lot, { status = "open" } = {}) {
  if (!lot?.code) {
    return null;
  }
  const product = lot.product || {};
  const basePrice = positiveNumber(getLotEffectivePrice(lot));
  const discount = positiveNumber(lot.discountAmount);
  const price = discount > 0 && basePrice > 0 ? Math.max(0, basePrice - discount) : basePrice;
  // Строго typeof: Number(null) === 0, и «остаток неизвестен» превратился бы
  // в «0 шт» на странице зрителя.
  const availableStock = typeof product.availableStock === "number"
    ? product.availableStock
    : NaN;

  return {
    code: String(lot.code),
    name: product.name || "",
    category: product.pathName || "",
    price,
    basePrice,
    discount,
    // null — «остаток неизвестен» (МойСклад не ответил): страница просто не
    // покажет строку, а не напишет зрителю «0 шт».
    availableStock: Number.isFinite(availableStock) ? Math.max(0, Math.floor(availableStock)) : null,
    status,
  };
}

export function viewerLotSignature(snapshot) {
  return snapshot ? JSON.stringify(snapshot) : "";
}

function buildPhotoPayload(lot) {
  const photo = lot?.product?.photo;
  const buffer = photo?.buffer;
  if (!buffer || typeof buffer.length !== "number") {
    return null;
  }
  if (buffer.length === 0 || buffer.length > MAX_LOT_PHOTO_BYTES) {
    return null;
  }
  return {
    base64: buffer.toString("base64"),
    contentType: photo.contentType || "image/jpeg",
  };
}

export function createViewerLotPublisher({
  chatClient,
  logger,
  connectionId = null,
  heartbeatMs = LOT_HEARTBEAT_MS,
} = {}) {
  const enabled = Boolean(chatClient?.enabled && chatClient.publishLot);
  let lastSignature = null;
  let publishedPhotoCode = null;
  let lastOpenLot = null;
  let inFlight = false;
  let pendingLot;
  let heartbeatTimer = null;
  let heartbeatOn = false;

  function stopHeartbeat() {
    heartbeatOn = false;
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // setTimeout цепочкой, а не setInterval: такт делает сетевой запрос, и пауза
  // должна отсчитываться от его конца — тот же приём, что в cross-promo.js.
  function scheduleHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(async () => {
      heartbeatTimer = null;
      if (!heartbeatOn) return;
      const result = await chatClient.confirmLot()
        .catch((error) => ({ ok: false, error: error?.message || String(error) }));
      if (!result?.ok) {
        logger?.warn?.("chat", "lot_card_keepalive_failed", {
          connectionId,
          error: result?.error || "unknown",
        });
      }
      // Промах такта цикл не рвёт: TTL на той стороне с запасом в несколько
      // тактов, и одна сетевая ошибка не должна гасить карточку в эфире.
      if (heartbeatOn) scheduleHeartbeat();
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  function startHeartbeat() {
    if (typeof chatClient?.confirmLot !== "function") return;
    heartbeatOn = true;
    scheduleHeartbeat();
  }

  async function send(lot) {
    // Лот закрылся, а следующий ещё не назван: показываем ту же карточку со
    // статусом «закрыт» — зритель должен понимать, что именно закрылось (в VK
    // эту роль играет отдельный комментарий publishLotClosed). Совсем убираем
    // карточку только по clear() — на остановке эфира.
    const snapshot = lot
      ? buildViewerLot(lot)
      : (lastOpenLot ? buildViewerLot(lastOpenLot, { status: "closed" }) : null);
    if (lot) {
      lastOpenLot = lot;
    }
    const signature = viewerLotSignature(snapshot);
    if (signature === lastSignature) {
      return;
    }
    lastSignature = signature;

    const payload = { lot: snapshot };
    // Фото весит сотни килобайт и не меняется, пока лот тот же: шлём его
    // только при смене артикула. Явный null при этом обязателен — иначе на
    // карточке лота без фото осталась бы картинка предыдущего.
    if (snapshot?.code !== publishedPhotoCode) {
      payload.photo = snapshot ? buildPhotoPayload(lot) : null;
      publishedPhotoCode = snapshot?.code ?? null;
    }

    const result = await chatClient.publishLot(payload);
    if (!result?.ok) {
      logger?.warn?.("chat", "lot_card_publish_failed", {
        connectionId,
        code: snapshot?.code || null,
        lotSessionId: lot?.lotSessionId || null,
        error: result?.error || "unknown",
      });
      // Сигнатуру откатываем: следующее изменение состояния должно
      // попробовать снова, иначе один сетевой сбой оставил бы зрителей без
      // карточки до конца лота.
      lastSignature = null;
      publishedPhotoCode = null;
      return;
    }
    logger?.info?.("chat", "lot_card_published", {
      connectionId,
      code: snapshot?.code || null,
      lotSessionId: lot?.lotSessionId || null,
      price: snapshot?.price ?? null,
      discount: snapshot?.discount ?? null,
      withPhoto: Boolean(payload.photo),
      cleared: snapshot === null,
    });
    // Пока карточка висит (в том числе закрытая), её надо подтверждать; после
    // снятия подтверждать нечего. Отсчёт идёт от последней публикации —
    // она сама по себе и есть подтверждение.
    if (snapshot) startHeartbeat();
    else stopHeartbeat();
  }

  async function drain() {
    if (inFlight) return;
    inFlight = true;
    try {
      while (pendingLot !== undefined) {
        const lot = pendingLot;
        pendingLot = undefined;
        await send(lot);
      }
    } catch (error) {
      logger?.warn?.("chat", "lot_card_publish_failed", {
        connectionId,
        error: error?.message || String(error),
      });
      lastSignature = null;
      publishedPhotoCode = null;
    } finally {
      inFlight = false;
    }
  }

  return {
    enabled,
    // Вызывается из emitState() — синхронно и часто. Сеть уходит в фон, а
    // медленный ответ чата не копит очередь: держим только последнее
    // состояние (промежуточные лоту всё равно неактуальны).
    sync(lot) {
      if (!enabled) return;
      pendingLot = lot || null;
      void drain();
    },
    // Эфир закончился/перезапущен — снять карточку и забыть память дедупа.
    clear() {
      if (!enabled) return;
      stopHeartbeat();
      lastSignature = null;
      lastOpenLot = null;
      pendingLot = null;
      void drain();
    },
  };
}
