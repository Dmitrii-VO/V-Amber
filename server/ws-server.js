import { WebSocketServer } from "ws";
import { logger } from "./logger.js";
import { createSessionLog } from "./session-log.js";
import { SpeechKitStreamingSession } from "./speechkit-stream.js";
import { detectArticle, transcriptHasTrigger } from "./article-extractor.js";
import { detectDiscount } from "./discount-detector.js";
import { detectPrice } from "./price-detector.js";
import { createMoySkladClient } from "./moysklad.js";
import { createVkPublisher, isVkStreamFatalError } from "./vk.js";
import { isSafeMode, setSafeMode, onSafeModeChange } from "./safe-mode.js";
import { saveActiveState, clearActiveState } from "./state-store.js";
import { parseReservationComment, parseWishlistComment } from "./reservation-parser.js";
import { parseCancelCommand } from "./cancel-command-parser.js";
import { matchNameAgainst } from "./name-matcher.js";
import { createAuth } from "./auth.js";
import {
  sendJson,
  getVkPublicationCommentId,
  getVkApiErrorCode,
  formatBroadcastDate,
  normalizeReservationCode,
  createBoundedIdSet,
  addBoundedId,
  hasUsableSalePrice,
  getLotEffectivePrice,
  getReservationReplyMessage,
  getCommittedReservationCount,
  isFatalCommentReadError,
  RESERVATION_HISTORY_LIMIT,
} from "./ws-helpers.js";
import { createVoicePipeline } from "./domain/voice-pipeline.js";

let nextConnectionId = 1;
let nextLotSessionId = 1;
let nextDetectionId = 1;

// Сброс модульных счётчиков id между тестами: иначе порядок прогона течёт
// в lotSessionId/detectionId и снапшоты становятся хрупкими. Прод-код это
// не вызывает (счётчики живут весь процесс).
export function __resetIdCountersForTests() {
  nextConnectionId = 1;
  nextLotSessionId = 1;
  nextDetectionId = 1;
}

export function attachWsServer(httpServer, config, services = {}) {
  const wsServer = new WebSocketServer({ noServer: true });
  // moysklad/vk должны быть уже обёрнуты wrapWithSafeMode в server/index.js,
  // чтобы HTTP-flow (POST /api/wishlist/purchase-order) использовал ту же
  // защиту, что и WS-flow. Здесь повторно не оборачиваем.
  const moysklad = services.moysklad || createMoySkladClient(config.moysklad);
  const vk = services.vk || createVkPublisher(config.vk);
  const auth = createAuth();
  const detectionConfig = config.articleExtraction;
  const productCodeCache = services.productCodeCache || null;
  const wishlistStore = services.wishlistStore || null;
  const nameCacheStore = services.nameCacheStore || null;
  const createSessionLogImpl = services.createSessionLog || createSessionLog;
  const saveActiveStateImpl = services.saveActiveState || saveActiveState;
  const clearActiveStateImpl = services.clearActiveState || clearActiveState;
  // Seam для тестов: позволяет подменить реальную gRPC-сессию SpeechKit
  // фейком, который скармливает скриптовые транскрипты через onFinal без
  // сети. Прод всегда идёт дефолтным путём (new SpeechKitStreamingSession).
  const createSpeechKitSession = services.createSpeechKitSession
    || ((speechkitConfig, handlers, meta) =>
      new SpeechKitStreamingSession(speechkitConfig, handlers, meta));

  function broadcastWishlistCount(count) {
    const payload = JSON.stringify({ type: "wishlist_count_changed", count });
    for (const client of wsServer.clients) {
      if (client.readyState === 1) {
        try { client.send(payload); } catch { /* ignore */ }
      }
    }
  }

  if (wishlistStore?.subscribe) {
    wishlistStore.subscribe(({ activeCount }) => broadcastWishlistCount(activeCount));
  }

  function rejectUpgrade(socket, status, reason) {
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    } catch { /* ignore */ }
    socket.destroy();
  }

  httpServer.on("upgrade", (request, socket, head) => {
    let url;

    try {
      url = new URL(request.url, "http://localhost");
    } catch {
      logger.warn("ws", "bad_upgrade_url", { url: request.url });
      socket.destroy();
      return;
    }

    if (url.pathname !== "/ws/stt") {
      socket.destroy();
      return;
    }

    const origin = request.headers.origin;
    if (!auth.isOriginAllowed(origin)) {
      logger.warn("ws", "origin_rejected", { origin });
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    if (auth.enabled && !auth.isRequestAuthenticated(request, url)) {
      logger.warn("ws", "unauthorized_upgrade", { origin });
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    // Single-broadcast guard. The whole app is built around a single live
    // operator console; a second connection would publish duplicate VK
    // cards and run two reservation pollers in parallel. Allow override
    // via ?force=1 in case the previous socket genuinely hung but did not
    // close cleanly (rare — usually `close` fires on tab unload).
    const activeClientCount = [...wsServer.clients].filter((c) => c.readyState === 1).length;
    if (activeClientCount > 0 && url.searchParams.get("force") !== "1") {
      logger.warn("ws", "duplicate_connection_rejected", {
        origin,
        activeClientCount,
      });
      rejectUpgrade(socket, 409, "Conflict");
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (websocket) => {
      wsServer.emit("connection", websocket, request);
    });
  });

  wsServer.on("connection", (websocket) => {
    const connectionId = `ws-${nextConnectionId++}`;
    const sessionLog = createSessionLogImpl();
    let session = null;
    let activeLot = null;
    const openLotsBySessionId = new Map();
    let lastDetection = null;
    const voicePipeline = createVoicePipeline({
      connectionId,
      detectionConfig,
    });
    let nextRunId = 1;
    let activeRunId = null;
    let activeDetectionActionId = null;
    let commentPollingGeneration = 0;
    let commentPollingActive = false;
    let commentPollingLastCommentId = 0;
    const commentPollingSeenIds = createBoundedIdSet();
    let customerOrdersByViewerId = new Map();
    let customerOrderSessionVersion = 1;
    // «Битые» лоты: у видео в VK отключены комментарии (errorCode 801) или
    // другая неустранимая ошибка. Любые публикации/опрос для такого лота —
    // no-op до конца сессии; пользователь увидит уведомление в UI один раз.
    const poisonedLotSessionIds = new Set();

    function isLotPoisoned(lotSessionId) {
      return Boolean(lotSessionId) && poisonedLotSessionIds.has(lotSessionId);
    }

    function markLotPoisoned(lot, reason, error) {
      const lotSessionId = lot?.lotSessionId;
      if (!lotSessionId || poisonedLotSessionIds.has(lotSessionId)) {
        return;
      }
      poisonedLotSessionIds.add(lotSessionId);
      // Останавливаем активный poll-цикл этого лота — следующая итерация
      // увидит увеличенный generation и выйдет.
      commentPollingGeneration += 1;
      commentPollingActive = false;
      logger.warn("vk", "lot_poisoned", {
        connectionId,
        lotSessionId,
        code: lot?.code || null,
        reason,
        vkErrorCode: error?.vkErrorCode ?? null,
        error,
      });
      sendJson(websocket, {
        type: "warning",
        message: reason === "comments_closed"
          ? "У видео отключены комментарии — включите их в VK и откройте лот заново"
          : `Лот ${lot?.code || ""} больше не принимает действия VK: ${error?.message || reason}`,
      });
    }

    function handleVkPublishError(lot, error) {
      if (error?.vkErrorCode === 801) {
        markLotPoisoned(lot, "comments_closed", error);
      }
    }

    function emitState() {
      sendJson(websocket, {
        type: "state",
        activeLot,
        openLots: [...openLotsBySessionId.values()],
        lastDetection,
        safeMode: isSafeMode(),
      });
      // Снимок состояния на диск (logs/active-state.json), чтобы рестарт во
      // время эфира не «терял» очередь брони. Запись атомарна (tmp+rename)
      // и дебаунсится внутри state-store. На graceful shutdown файл удаляется.
      if (activeLot?.lotSessionId) {
        saveActiveStateImpl({
          activeLot,
          openLots: getOpenLots(),
          sessionFilePath: sessionLog.getFilePath(),
          connectionId,
        });
      }
    }

    const unsubscribeSafeMode = onSafeModeChange((enabled, meta) => {
      sessionLog.logSafemodeToggled({ enabled, source: meta?.source });
      emitState();
    });

    // Снимок state раз в 30 секунд (только пока есть активный лот) — даёт
    // мне «реперные точки» в диагностическом jsonl, чтобы реконструировать
    // состояние в любой момент эфира без жадного логирования каждой мутации.
    function emitStateSnapshot() {
      if (!activeLot?.lotSessionId) return;
      const reservations = activeLot.reservations || {};
      const events = Array.isArray(reservations.events) ? reservations.events : [];
      const byStatus = {};
      for (const e of events) {
        const k = e?.status || "unknown";
        byStatus[k] = (byStatus[k] || 0) + 1;
      }
      sessionLog.logStateSnapshot({
        activeLot: {
          code: activeLot.code,
          lotSessionId: activeLot.lotSessionId,
          productId: activeLot.product?.id || null,
          availableStock: activeLot.product?.availableStock ?? null,
          salePrice: activeLot.product?.salePrice ?? null,
          voicePrice: activeLot.product?.voicePrice ?? null,
          effectivePrice: getLotEffectivePrice(activeLot) ?? null,
        },
        eventsByStatus: byStatus,
        committedReservationCount: reservations.committedReservationCount || 0,
        primaryReservation: reservations.primaryReservation || null,
        safeMode: isSafeMode(),
        wishlistActive: services.wishlistStore?.getActiveCount?.() ?? 0,
      });
    }
    const stateSnapshotInterval = setInterval(emitStateSnapshot, 30_000);
    stateSnapshotInterval.unref();

    function resetDetectionState() {
      commentPollingGeneration += 1;
      commentPollingActive = false;
      commentPollingLastCommentId = 0;
      commentPollingSeenIds.clear();
      activeLot = null;
      openLotsBySessionId.clear();
      lastDetection = null;
      activeDetectionActionId = null;
      voicePipeline.resetTriggerWindow("detection_state_reset");
    }

    function registerOpenLot(lot) {
      if (lot?.lotSessionId) {
        openLotsBySessionId.set(lot.lotSessionId, lot);
      }
    }

    function unregisterOpenLot(lot) {
      if (lot?.lotSessionId) {
        openLotsBySessionId.delete(lot.lotSessionId);
      }
      if (activeLot?.lotSessionId === lot?.lotSessionId) {
        const remainingLots = [...openLotsBySessionId.values()];
        activeLot = remainingLots.at(-1) || null;
      }
    }

    function getOpenLots() {
      return [...openLotsBySessionId.values()];
    }

    async function publishAllLotsClosed(reason) {
      const lots = getOpenLots();
      // Последовательно, чтобы при «video not found» на конце эфира можно
      // было записать ровно один warning и пропустить публикацию закрытия
      // оставшихся лотов вместо серии error publish failures в логе.
      let vkStreamUnavailable = false;
      for (const lot of lots) {
        await flushOrphanWaitlist(lot, reason);
        if (isLotPoisoned(lot.lotSessionId) || vkStreamUnavailable) {
          continue;
        }
        try {
          await vk.publishLotClosed(lot);
        } catch (error) {
          // Расширили классификатор: stream-fatal означает «дальше публикация
          // под этим видео не пройдёт» (видео удалено/недоступно/комментарии
          // закрыты/некорректные параметры) — для массового закрытия лотов
          // условия видео-уровневые, поэтому останавливаем дальнейшие попытки.
          if (isVkStreamFatalError(error)) {
            vkStreamUnavailable = true;
            logger.warn("vk", "lot_close_skipped_video_unavailable", {
              connectionId,
              code: lot.code,
              lotSessionId: lot.lotSessionId,
              reason,
              vkErrorCode: error?.vkErrorCode ?? null,
              error,
            });
          } else {
            handleVkPublishError(lot, error);
            logger.error("vk", "lot_close_publish_failed", {
              connectionId,
              code: lot.code,
              lotSessionId: lot.lotSessionId,
              reason,
              error,
            });
          }
        }
      }
      openLotsBySessionId.clear();
      activeLot = null;
    }

    function resetCustomerOrders() {
      customerOrdersByViewerId = new Map();
      customerOrderSessionVersion += 1;
      // Граcеful shutdown — стирать persisted state, чтобы следующий старт
      // не подхватил его как «брошенный после краша». Fire-and-forget:
      // ошибка disk-IO не должна блокировать остановку сессии.
      clearActiveStateImpl().catch(() => {});
    }

    function ensureReservationState(lot) {
      if (!lot) {
        return null;
      }

      if (!lot.reservations) {
        lot.reservations = {
          lastCommentId: 0,
          seenCommentIds: createBoundedIdSet(),
          acceptedUserIds: createBoundedIdSet(),
          events: [],
          // Persistent counter, separate from the trimmed events buffer above.
          // Without this, lots with more than 20 reservations under-report and
          // the stock guard lets extra orders through.
          committedReservationCount: 0,
        };
      } else {
        if (!(lot.reservations.seenCommentIds instanceof Set)) {
          lot.reservations.seenCommentIds = createBoundedIdSet(lot.reservations.seenCommentIds);
        }
        if (!(lot.reservations.acceptedUserIds instanceof Set)) {
          lot.reservations.acceptedUserIds = createBoundedIdSet(lot.reservations.acceptedUserIds);
        }
      }

      return lot.reservations;
    }

    function rememberSeenComment(state, commentId) {
      addBoundedId(state.seenCommentIds, commentId);
    }

    function hasSeenComment(state, commentId) {
      return state.seenCommentIds.has(commentId);
    }

    function addReservationEvent(lot, event) {
      const state = ensureReservationState(lot);
      state.events.push(event);
      state.events = state.events.slice(-20);
    }

    // Голосовая отмена брони (W3). Находит подтверждённую бронь по имени и
    // просит клиента подсветить строку. НИКОГДА не отменяет сама — реальное
    // удаление позиции в МойСкладе делает оператор кнопкой «× отменить»
    // (path cancelReservation, со своей safe-mode защитой). Неоднозначность
    // имени → предупреждение, без подсветки наугад.
    function handleVoiceCancelCommand(command, transcript) {
      const spokenName = command.name;
      const code = command.code;

      const lot = getOpenLots().find((candidate) => String(candidate.code) === String(code)) || null;

      if (!lot) {
        sendJson(websocket, {
          type: "warning",
          message: `Нет открытого лота ${code} для отмены брони (${spokenName})`,
        });
        return;
      }

      const state = ensureReservationState(lot);
      const events = Array.isArray(state?.events) ? state.events : [];
      const confirmable = events.filter(
        (e) => e.status === "reserved" || e.status === "reserved_appended",
      );

      const candidates = confirmable.map((e) => ({
        viewerId: e.viewerId,
        commentId: e.commentId,
        name: e.viewerName || nameCacheStore?.getName?.(e.viewerId) || "",
      }));
      const matches = matchNameAgainst(spokenName, candidates);

      logger.info("ws", "voice_cancel_command", {
        connectionId,
        lotSessionId: lot.lotSessionId,
        spokenCode: code,
        activeLotCode: activeLot?.code || null,
        codeMatchesOpenLot: true,
        spokenName,
        transcript: typeof transcript === "string" ? transcript.slice(0, 200) : "",
        candidateCount: candidates.length,
        matchCount: matches.length,
        topScore: matches[0]?.score ?? null,
      });

      if (confirmable.length === 0) {
        sendJson(websocket, {
          type: "warning",
          message: `Нет подтверждённых броней для отмены (${spokenName})`,
        });
        return;
      }
      if (matches.length === 0) {
        sendJson(websocket, {
          type: "warning",
          message: `Не нашёл бронь по имени «${spokenName}» — отмените вручную`,
        });
        return;
      }
      // Неоднозначность: первые два совпадения с равным счётом — не выбираем
      // наугад, это риск отменить чужую бронь (реальные деньги).
      if (matches.length > 1 && matches[0].score === matches[1].score) {
        sendJson(websocket, {
          type: "warning",
          message: `Несколько броней похожи на «${spokenName}» — отмените нужную кнопкой «× отменить»`,
        });
        return;
      }

      const best = matches[0];
      sendJson(websocket, {
        type: "voiceCancelMatch",
        viewerId: best.viewerId,
        commentId: best.commentId,
        viewerName: best.name,
        spokenName,
        code,
        lotSessionId: lot.lotSessionId,
      });
    }

    async function applyVoicePrice(priceResult, transcript = null) {
      if (!activeLot?.product || !priceResult?.value) {
        return false;
      }

      if (hasUsableSalePrice(activeLot.product)) {
        logger.info("price", "voice_price_ignored", {
          connectionId,
          reason: "sale_price_exists",
          salePrice: activeLot.product.salePrice,
          voicePrice: priceResult.value,
          code: activeLot.code,
          lotSessionId: activeLot.lotSessionId,
        });
        return false;
      }

      activeLot.product.voicePrice = priceResult.value;
      activeLot.product.priceSource = "voice";

      logger.info("price", "voice_price_applied", {
        connectionId,
        voicePrice: priceResult.value,
        trigger: priceResult.trigger || null,
        code: activeLot.code,
        lotSessionId: activeLot.lotSessionId,
        transcript,
      });

      if (activeLot.vkPublication?.commentId && !isLotPoisoned(activeLot.lotSessionId)) {
        await vk.publishPriceUpdate(activeLot).catch((error) => {
          handleVkPublishError(activeLot, error);
          logger.warn("vk", "price_update_publish_failed", {
            connectionId,
            lotSessionId: activeLot?.lotSessionId,
            error,
          });
        });
      }

      emitState();
      return true;
    }


    function getRemainingAvailableStock(lot, state) {
      const availableStock = lot?.product?.availableStock;
      // Operator naming an article on air means at least one unit is in hand:
      // treat unknown / zero stock as a floor of 1, so the first reservation
      // is always allowed. Subsequent reservations on the same lot then bump
      // committedReservationCount and the guard tightens.
      const effectiveStock = (typeof availableStock === "number" && Number.isFinite(availableStock))
        ? Math.max(1, Math.floor(availableStock))
        : 1;
      return Math.max(0, effectiveStock - getCommittedReservationCount(state));
    }

    // Ленивая попытка дотянуть availableStock из MoySklad, если первая бронь
    // приходит на лот, для которого карточка вернула null/non-finite.
    // floor=1 в getRemainingAvailableStock — это страховка от over-sell в
    // эфире, но если МойСклад временно недоступен на старте лота, мы
    // принимаем за «склад > 0» даже когда реально 0. Здесь даём один шанс
    // получить настоящее число.
    async function ensureStockKnownBeforeFirstReservation(lot, state) {
      if (!lot?.code) return;
      if (getCommittedReservationCount(state) > 0) return;
      const current = lot.product?.availableStock;
      if (typeof current === "number" && Number.isFinite(current)) return;
      if (isLotPoisoned(lot.lotSessionId)) return;
      try {
        const productCard = await moysklad.getProductCardByCode(lot.code);
        if (openLotsBySessionId.get(lot.lotSessionId) !== lot) return;
        if (productCard && typeof productCard.availableStock === "number"
            && Number.isFinite(productCard.availableStock)) {
          lot.product = lot.product || {};
          lot.product.availableStock = productCard.availableStock;
          lot.product.stockUnknown = false;
          logger.info("moysklad", "stock_refreshed_before_first_reservation", {
            connectionId,
            code: lot.code,
            lotSessionId: lot.lotSessionId,
            availableStock: productCard.availableStock,
          });
        } else {
          markLotStockUnknown(lot, "card_returned_no_stock");
        }
      } catch (error) {
        markLotStockUnknown(lot, "card_lookup_failed", error);
      }
    }

    // Бизнес-правило (этап 4 PLAN.md): unknown stock → разрешаем один slot
    // (через floor=1 в getRemainingAvailableStock), но обязаны явно показать
    // оператору риск перепродажи. Метим лот флагом stockUnknown, шлём toast
    // и оставляем один greppable warning в логах.
    function markLotStockUnknown(lot, reason, error = null) {
      if (!lot?.code) return;
      lot.product = lot.product || {};
      const alreadyMarked = lot.product.stockUnknown === true;
      lot.product.stockUnknown = true;
      logger.warn("moysklad", "stock_unknown_first_reservation", {
        connectionId,
        code: lot.code,
        lotSessionId: lot.lotSessionId,
        reason,
        ...(error ? { error } : {}),
      });
      if (!alreadyMarked) {
        sendJson(websocket, {
          type: "warning",
          message: `Остаток для лота ${lot.code} неизвестен — разрешён только 1 slot, риск перепродажи`,
        });
      }
    }

    function notifyReservationStatus(lot, event) {
      const message = getReservationReplyMessage(event, { code: lot?.code || null });
      if (!message) {
        return;
      }

      if (isLotPoisoned(lot?.lotSessionId)) {
        return;
      }

      void vk.publishReservationReply({
        commentId: event.commentId,
        message,
        lotSessionId: lot?.lotSessionId || null,
        code: lot?.code || null,
        viewerId: event.viewerId,
        status: event.status,
      }).catch((error) => {
        handleVkPublishError(lot, error);
        logger.warn("vk", "reservation_reply_failed", {
          connectionId,
          lotSessionId: lot?.lotSessionId || null,
          code: lot?.code || null,
          commentId: event.commentId,
          viewerId: event.viewerId,
          status: event.status,
          error,
        });
      });
    }

    async function addWishlistFromComment(lot, event, trigger = "wishlist_confirmed") {
      if (!wishlistStore || !lot || !event?.viewerName) {
        return null;
      }

      const cacheEntry = productCodeCache?.getProductByCode?.(lot.code) || null;
      const entry = await wishlistStore.addFromOutOfStock({
        event,
        lot,
        trigger,
        productMeta: cacheEntry
          ? {
              productId: cacheEntry.id || lot.product?.id || null,
              productName: cacheEntry.name || lot.product?.name || "",
              supplierId: cacheEntry.supplierId,
              supplierName: cacheEntry.supplierName,
              buyPrice: cacheEntry.buyPrice,
            }
          : {
              productId: lot.product?.id || null,
              productName: lot.product?.name || "",
            },
      });

      logger.info("wishlist", "wishlist_confirmed_from_comment", {
        connectionId,
        lotSessionId: lot.lotSessionId,
        code: lot.code,
        commentId: event.commentId,
        viewerId: event.viewerId,
        viewerName: event.viewerName,
        entryId: entry?.id || null,
        trigger,
      });

      return entry;
    }

    function isReservationSessionCurrent(lot, reservationSessionVersion) {
      return reservationSessionVersion === customerOrderSessionVersion
        && openLotsBySessionId.get(lot?.lotSessionId) === lot;
    }

    async function processReservationEvent(lot, event) {
      const state = ensureReservationState(lot);
      const reservationSessionVersion = customerOrderSessionVersion;
      const broadcastDate = formatBroadcastDate(new Date(event.createdAt || Date.now()));
      const customerOrderKey = `${broadcastDate}:${event.viewerId}`;

      if (isSafeMode()) {
        event.status = "safe_mode_logged";
        // Carry enough info that a later replay can reconstruct the order
        // without re-deriving it from MoySklad: product UUID, original
        // sale price, applied discount, comment text. This is the
        // contract behind safe mode = "audit-only" runs.
        const product = lot.product || {};
        const discountAmount = Number(lot.discountAmount || 0);
        const salePrice = Number(getLotEffectivePrice(lot) || 0);
        const effectivePrice = Math.max(0, salePrice - discountAmount);
        logger.warn("safe-mode", "reservation_logged_only", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          code: lot.code,
          commentId: event.commentId,
          commentText: typeof event.text === "string" ? event.text.slice(0, 200) : "",
          createdAt: event.createdAt || new Date().toISOString(),
          viewerId: event.viewerId,
          viewerName: event.viewerName,
          productId: product.id || null,
          productName: product.name || null,
          salePrice: Number.isFinite(salePrice) ? salePrice : null,
          discountAmount,
          effectivePrice: Number.isFinite(effectivePrice) ? effectivePrice : null,
        });
        emitState();
        return;
      }

      if (state.primaryReservation) {
        event.status = "waitlist_pending";
        const waitlistPosition = state.events.filter((candidate) => candidate.status === "waitlist_pending").length;
        logger.info("vk", "reservation_waitlist_pending", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          commentId: event.commentId,
          viewerId: event.viewerId,
          position: waitlistPosition,
        });
        sessionLog.logReservationWaitlist({
          viewerName: event.viewerName,
          viewerId: event.viewerId,
          lotCode: lot.code,
          position: waitlistPosition,
        });
        emitState();
        notifyReservationStatus(lot, event);
        return;
      }

      if (!lot.product?.id) {
        event.status = "product_not_found";
        logger.warn("vk", "reservation_product_not_found", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          code: lot.code,
          commentId: event.commentId,
          viewerId: event.viewerId,
        });
        emitState();
        notifyReservationStatus(lot, event);
        return;
      }

      // На первой брони со «склад=unknown» — однократная попытка дотянуть
      // реальное число из MoySklad. Защищает от молчаливого over-sell в
      // случаях, когда стартовая карточка лота вернула null/0.
      await ensureStockKnownBeforeFirstReservation(lot, state);
      if (openLotsBySessionId.get(lot?.lotSessionId) !== lot) {
        // Лот закрыли, пока мы ждали MoySklad — выходим без побочных
        // эффектов; processReservationEvent вызывался для закрытого лота.
        return;
      }

      const needed = Math.max(1, Number(event.quantity) || 1);
      const remainingStock = getRemainingAvailableStock(lot, state);
      if (remainingStock !== null && remainingStock < needed) {
        event.status = "out_of_stock";
        logger.info("vk", "reservation_out_of_stock", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          code: lot.code,
          commentId: event.commentId,
          viewerId: event.viewerId,
          availableStock: lot.product?.availableStock ?? null,
        });
        sessionLog.logReservationOutOfStock({
          viewerName: event.viewerName,
          viewerId: event.viewerId,
          lotCode: lot.code,
        });
        try {
          const wishlistEntry = await addWishlistFromComment(lot, event, "out_of_stock_reservation");
          if (wishlistEntry?.id) {
            event.wishlistEntryId = wishlistEntry.id;
          }
        } catch (error) {
          logger.warn("wishlist", "add_from_out_of_stock_reservation_failed", {
            connectionId,
            lotSessionId: lot.lotSessionId,
            code: lot.code,
            commentId: event.commentId,
            viewerId: event.viewerId,
            error,
          });
        }
        emitState();
        notifyReservationStatus(lot, event);
        return;
      }

      state.primaryReservation = {
        commentId: event.commentId,
        viewerId: event.viewerId,
      };
      event.status = "creating_order";
      state.committedReservationCount = (state.committedReservationCount || 0) + needed;
      emitState();

      let nextWaitlistEvent = null;

      try {
        let existingOrder = customerOrdersByViewerId.get(customerOrderKey) || null;
        let resolvedCounterparty = null;

        // Cross-session merge: in-memory map is wiped when the WebSocket
        // closes or the operator restarts the stream, so the same viewer's
        // next reservation looks "fresh" even when MoySklad already has an
        // open «Новый» order for them. Ask MoySklad as source of truth.
        if (!existingOrder?.id) {
          try {
            resolvedCounterparty = await moysklad.ensureCounterparty({
              viewerId: event.viewerId,
              viewerName: event.viewerName,
            });
            if (resolvedCounterparty?.id) {
              const found = await moysklad.findBroadcastCustomerOrderForCounterparty(
                resolvedCounterparty.id,
                { broadcastDate },
              );
              if (found?.id) {
                existingOrder = found;
                logger.info("moysklad", "open_customer_order_reused", {
                  connectionId,
                  lotSessionId: lot.lotSessionId,
                  viewerId: event.viewerId,
                  orderId: found.id,
                  source: "cross_session_lookup",
                });
              }
            }
          } catch (lookupError) {
            // Do not block the reservation on a lookup failure — falling
            // through to createCustomerOrderReservation is the safe default
            // (worst case: an extra order, same as before this feature).
            logger.warn("moysklad", "open_order_lookup_failed", {
              connectionId,
              viewerId: event.viewerId,
              error: lookupError,
            });
          }
        }

        let order = null;

        if (existingOrder?.id) {
          // ВАЖНО: сохраняем результат append'а отдельно. В safe mode wrapper
          // возвращает {skipped:true, safeMode:true} — раньше мы тут затирали
          // его на existingOrder, и safe-mode check ниже пропускал; покупатель
          // получал ложное «бронь подтверждена», а в МойСкладе — ничего.
          const appendResult = await moysklad.appendPositionToCustomerOrder({
            orderId: existingOrder.id,
            activeLot: lot,
            productCard: {
              salePrice: lot.product?.salePrice,
              voicePrice: lot.product?.voicePrice,
            },
            reservation: event,
            broadcastDate,
          });
          // Несём positionId добавленной позиции на объекте заказа — он нужен
          // отмене брони (#16) для адресного DELETE именно этой позиции, а не
          // соседней позиции того же товара в этом же заказе.
          order = (appendResult && appendResult.skipped === true && appendResult.safeMode === true)
            ? appendResult
            : { ...existingOrder, positionId: appendResult?.positionId || null };
        } else {
          order = await moysklad.createCustomerOrderReservation({
            activeLot: lot,
            productCard: {
              salePrice: lot.product?.salePrice,
              voicePrice: lot.product?.voicePrice,
            },
            reservation: event,
            counterparty: resolvedCounterparty,
            broadcastDate,
          });
        }

        // safe-mode flipped on between the early check and the wrapped call —
        // the safe-mode wrapper returns { skipped: true, safeMode: true } and
        // nothing was actually written to MoySklad. Mark the event accordingly
        // instead of falling through to the success path.
        if (order && order.skipped === true && order.safeMode === true) {
          event.status = "safe_mode_logged";
          // No MoySklad write happened — release the slot in the counter.
          state.committedReservationCount = Math.max(0, (state.committedReservationCount || 0) - needed);
          logger.warn("safe-mode", "reservation_blocked_mid_flight", {
            connectionId,
            lotSessionId: lot.lotSessionId,
            commentId: event.commentId,
            viewerId: event.viewerId,
          });
          notifyReservationStatus(lot, event);
          return;
        }

        // The order was created/appended in MoySklad. Even if the lot has
        // moved on since we started, register it so a future reservation by
        // the same viewer appends to this order instead of creating a third
        // orphan record. This is the orphan-prevention path.
        if (!existingOrder?.id && order?.id) {
          customerOrdersByViewerId.set(customerOrderKey, order);
        }

        if (!isReservationSessionCurrent(lot, reservationSessionVersion)) {
          logger.info("vk", "reservation_result_discarded", {
            connectionId,
            lotSessionId: lot.lotSessionId,
            commentId: event.commentId,
            viewerId: event.viewerId,
            orderId: order?.id || null,
            reason: existingOrder?.id ? "stale_session_after_append" : "stale_session_after_create",
            note: "MoySklad write completed; recorded in customerOrdersByViewerId to avoid duplicate orders.",
          });
          return;
        }

        event.status = existingOrder?.id ? "reserved_appended" : "reserved";
        event.customerOrder = order;
        const orderSalePrice = Number(getLotEffectivePrice(lot) || 0);
        const orderDiscountAmount = Number(lot.discountAmount || 0);
        logger.info("vk", "reservation_order_created", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          commentId: event.commentId,
          viewerId: event.viewerId,
          viewerName: event.viewerName,
          orderId: order?.id || null,
          appended: Boolean(existingOrder?.id),
          code: lot.code,
          productId: lot.product?.id || null,
          productName: lot.product?.name || null,
          salePrice: Number.isFinite(orderSalePrice) ? orderSalePrice : null,
          discountAmount: orderDiscountAmount,
          effectivePrice: Number.isFinite(orderSalePrice)
            ? Math.max(0, orderSalePrice - orderDiscountAmount)
            : null,
        });
        sessionLog.logOrderCreated({
          viewerName: event.viewerName,
          viewerId: event.viewerId,
          orderId: order?.id || null,
          lotCode: lot.code,
          appended: Boolean(existingOrder?.id),
        });
        notifyReservationStatus(lot, event);
      } catch (error) {
        state.acceptedUserIds.delete(event.viewerId);
        // Roll back the counter increment from line ~302 so a later viewer
        // isn't blocked by this failed write.
        state.committedReservationCount = Math.max(0, (state.committedReservationCount || 0) - needed);
        event.status = "order_failed";
        event.error = error instanceof Error ? error.message : String(error);
        logger.error("moysklad", "reservation_order_failed", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          commentId: event.commentId,
          viewerId: event.viewerId,
          error,
        });

        if (!isReservationSessionCurrent(lot, reservationSessionVersion)) {
          logger.info("vk", "reservation_result_discarded", {
            connectionId,
            lotSessionId: lot.lotSessionId,
            commentId: event.commentId,
            viewerId: event.viewerId,
            reason: "stale_session_after_error",
          });
          return;
        }

        notifyReservationStatus(lot, event);
      } finally {
        if (
          state.primaryReservation?.commentId === event.commentId
          && state.primaryReservation?.viewerId === event.viewerId
        ) {
          state.primaryReservation = null;
        }

        nextWaitlistEvent = state.events.find((candidate) => candidate.status === "waitlist_pending") || null;
      }

      emitState();

      if (nextWaitlistEvent && openLotsBySessionId.get(lot.lotSessionId) === lot) {
        nextWaitlistEvent.status = "pending_reservation";
        // Forensic: фиксируем переход «второй в очереди → первый», чтобы
        // в логе была видна полная судьба брони. Раньше можно было
        // увидеть waitlist_pending без объяснения, чем кончилось.
        logger.info("vk", "reservation_promoted_to_primary", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          code: lot.code,
          commentId: nextWaitlistEvent.commentId,
          viewerId: nextWaitlistEvent.viewerId,
          viewerName: nextWaitlistEvent.viewerName,
          previousPrimaryCommentId: event.commentId,
          previousPrimaryStatus: event.status,
        });
        sessionLog.logWaitlistPromoted({
          viewerName: nextWaitlistEvent.viewerName,
          viewerId: nextWaitlistEvent.viewerId,
          lotCode: lot.code,
          previousPrimaryStatus: event.status,
        });
        void processReservationEvent(lot, nextWaitlistEvent);
      }
    }

    // Этап 6: толерантность к ведущим нулям в коде покупателя. Оператор
     // говорит «00588», но покупатель пишет «бронь 0588» — старый exact-match
    // терял такую бронь. Pad только добавляет ведущие нули и только если код
    // лота длиннее: «10588» нельзя достичь pad'ом из «0588», поэтому
    // ложноположительных матчей не появится.
    function codesEquivalent(buyerCode, lotCode) {
      if (!buyerCode || !lotCode) return false;
      if (buyerCode === lotCode) return true;
      if (buyerCode.length >= lotCode.length) return false;
      if (!/^\d+$/.test(buyerCode) || !/^\d+$/.test(lotCode)) return false;
      return buyerCode.padStart(lotCode.length, "0") === lotCode;
    }

    function findCommentTarget(text) {
      const openLots = getOpenLots();
      // Сначала проходим по всем открытым лотам с exact-сравнением (и
      // wishlist), exact всегда побеждает padded.
      for (const lot of openLots) {
        const expectedCode = normalizeReservationCode(lot.code);
        const reservationComment = parseReservationComment(text, { preferredCode: expectedCode });
        if (reservationComment.code && reservationComment.code === expectedCode) {
          return { lot, reservationComment, wishlistComment: parseWishlistComment(text), matchedReservation: true, matchedWishlist: false };
        }
        const wishlistComment = parseWishlistComment(text);
        if (wishlistComment.code && wishlistComment.code === expectedCode) {
          return { lot, reservationComment, wishlistComment, matchedReservation: false, matchedWishlist: true };
        }
      }
      // Второй проход — zero-padding. Собираем все лоты, в которые код
      // покупателя ложится pad'ом из нулей, и используем только если
      // подошёл ровно один. Иначе ambiguous → возвращаем null, чтобы не
      // отправить бронь не на тот лот (например, если открыты «00588» и
      // «000588», buyer «588» подходит обоим).
      const paddedMatches = [];
      for (const lot of openLots) {
        const expectedCode = normalizeReservationCode(lot.code);
        const reservationComment = parseReservationComment(text, { preferredCode: expectedCode });
        if (reservationComment.code && codesEquivalent(reservationComment.code, expectedCode)) {
          paddedMatches.push({ lot, reservationComment });
        }
      }
      if (paddedMatches.length === 1) {
        const { lot, reservationComment } = paddedMatches[0];
        return { lot, reservationComment, wishlistComment: parseWishlistComment(text), matchedReservation: true, matchedWishlist: false };
      }
      if (paddedMatches.length > 1) {
        logger.warn("vk", "padded_match_ambiguous", {
          connectionId,
          text,
          lotCodes: paddedMatches.map(({ lot }) => lot.code),
        });
      }
      return null;
    }

    function startCommentPolling() {
      if (commentPollingActive) {
        return;
      }

      const generation = ++commentPollingGeneration;
      commentPollingActive = true;

      void (async function pollLoop() {
        let initialized = false;
        let consecutiveFailures = 0;

        while (generation === commentPollingGeneration && openLotsBySessionId.size > 0) {
          try {
            const comments = await vk.getComments(100);
            if (generation !== commentPollingGeneration || openLotsBySessionId.size === 0) {
              break;
            }

            const profileMap = new Map((comments.profiles || []).map((profile) => [profile.id, profile]));
            const sortedItems = (comments.items || []).sort((left, right) => left.id - right.id);

            if (!initialized) {
              initialized = true;
              consecutiveFailures = 0;

              if (commentPollingLastCommentId <= 0) {
                commentPollingLastCommentId = sortedItems.at(-1)?.id || commentPollingLastCommentId;

                await new Promise((resolve) => {
                  setTimeout(resolve, 2000);
                });
                continue;
              }
            }

            const newItems = (comments.items || [])
              .filter((item) => item.id > commentPollingLastCommentId && !commentPollingSeenIds.has(item.id))
              .sort((left, right) => left.id - right.id);

            for (const comment of newItems) {
              commentPollingLastCommentId = Math.max(commentPollingLastCommentId, comment.id);
              addBoundedId(commentPollingSeenIds, comment.id);

              const target = findCommentTarget(comment.text);
              if (!target) {
                continue;
              }
              const { lot: currentLot, reservationComment, wishlistComment, matchedReservation, matchedWishlist } = target;
              const reservationState = ensureReservationState(currentLot);
              reservationState.lastCommentId = Math.max(reservationState.lastCommentId, comment.id);
              rememberSeenComment(reservationState, comment.id);

              // Forensic: каждый новый комментарий в окне лота попадает в лог,
              // даже если не «бронь». Это позволяет позже увидеть пропущенные
              // брони (опечатки, «забронируй», эмодзи) и общий шум вокруг лота.
              const profileForLog = profileMap.get(comment.from_id);
              const viewerNameForLog = profileForLog
                ? [profileForLog.first_name, profileForLog.last_name].filter(Boolean).join(" ")
                : "";
              // Персистентный кеш имён (W3): запоминаем КАЖДОГО комментатора с
              // резолвнутым именем, не только бронирующих. Кеш переживает
              // стоп/старт эфира и используется голосовой отменой брони для
              // сопоставления произнесённого оператором имени с зрителем.
              if (nameCacheStore && viewerNameForLog) {
                nameCacheStore.remember(comment.from_id, viewerNameForLog);
              }
              logger.info("vk", "comment_seen", {
                connectionId,
                lotSessionId: currentLot.lotSessionId,
                code: currentLot.code,
                commentId: comment.id,
                viewerId: comment.from_id,
                viewerName: viewerNameForLog,
                text: typeof comment.text === "string" ? comment.text.slice(0, 200) : "",
                createdAt: new Date(comment.date * 1000).toISOString(),
                reservationCommentCode: reservationComment.code,
                hasReservationKeyword: reservationComment.hasReservationKeyword,
                reservationCommentQuantity: reservationComment.quantity ?? 1,
                wishlistCommentCode: wishlistComment.code,
                hasWishlistKeyword: wishlistComment.hasWishlistKeyword,
                matchedReservation,
                matchedWishlist,
              });

              if (!matchedReservation) {
                if (matchedWishlist) {
                  if (!viewerNameForLog) {
                    logger.warn("vk", "wishlist_profile_missing", {
                      connectionId,
                      lotSessionId: currentLot.lotSessionId,
                      commentId: comment.id,
                      viewerId: comment.from_id,
                    });
                    continue;
                  }

                  const wishlistEvent = {
                    commentId: comment.id,
                    viewerId: comment.from_id,
                    viewerName: viewerNameForLog,
                    text: comment.text,
                    createdAt: new Date(comment.date * 1000).toISOString(),
                    status: "wishlist_confirmed",
                    lotCode: currentLot.code,
                  };
                  void addWishlistFromComment(currentLot, wishlistEvent).catch((error) => {
                    logger.warn("wishlist", "add_from_comment_failed", {
                      connectionId,
                      lotSessionId: currentLot.lotSessionId,
                      commentId: comment.id,
                      viewerId: comment.from_id,
                      error,
                    });
                  });
                }
                continue;
              }

              const viewerId = comment.from_id;
              if (!viewerNameForLog) {
                logger.warn("vk", "reservation_profile_missing", {
                  connectionId,
                  lotSessionId: currentLot.lotSessionId,
                  commentId: comment.id,
                  viewerId,
                });
                continue;
              }

              if (reservationState.acceptedUserIds.has(viewerId)) {
                logger.info("vk", "reservation_duplicate_ignored", {
                  connectionId,
                  lotSessionId: currentLot.lotSessionId,
                  commentId: comment.id,
                  viewerId,
                });
                continue;
              }

              addBoundedId(reservationState.acceptedUserIds, viewerId);

              const reservationQuantity = Math.max(1, Math.min(10, Number(reservationComment.quantity) || 1));
              const event = {
                commentId: comment.id,
                viewerId,
                viewerName: viewerNameForLog,
                text: comment.text,
                createdAt: new Date(comment.date * 1000).toISOString(),
                status: "pending_reservation",
                lotCode: currentLot.code,
                quantity: reservationQuantity,
              };

              addReservationEvent(currentLot, event);
              sessionLog.logVkComment({
                commentId: comment.id,
                viewerId,
                viewerName: event.viewerName,
                text: comment.text,
                createdAt: event.createdAt,
                lotCode: currentLot.code,
              });
              // Полный снимок данных, необходимых для воспроизведения заказа
              // в МойСкладе из одной этой строки лога: продукт, цена в момент
              // эфира, действующая скидка, оригинальный текст комментария.
              // Цена эфира фиксируется здесь специально — её последующее
              // изменение в каталоге не должно искажать replay.
              const reservationSalePrice = Number(getLotEffectivePrice(currentLot) || 0);
              const reservationDiscountAmount = Number(currentLot.discountAmount || 0);
              logger.info("vk", "reservation_detected", {
                connectionId,
                lotSessionId: currentLot.lotSessionId,
                code: currentLot.code,
                commentId: comment.id,
                commentText: typeof comment.text === "string" ? comment.text.slice(0, 200) : "",
                commentCreatedAt: event.createdAt,
                viewerId,
                viewerName: event.viewerName,
                productId: currentLot.product?.id || null,
                productName: currentLot.product?.name || null,
                pathName: currentLot.product?.pathName || null,
                salePrice: Number.isFinite(reservationSalePrice) ? reservationSalePrice : null,
                discountAmount: reservationDiscountAmount,
                effectivePrice: Number.isFinite(reservationSalePrice)
                  ? Math.max(0, reservationSalePrice - reservationDiscountAmount)
                  : null,
                availableStock: currentLot.product?.availableStock ?? null,
              });
              sessionLog.logReservation({
                viewerName: event.viewerName,
                viewerId,
                lotCode: currentLot.code,
              });
              emitState();
              void processReservationEvent(currentLot, event);
            }

            if (consecutiveFailures > 0) {
              logger.info("vk", "comment_poll_recovered", {
                connectionId,
                openLotCount: openLotsBySessionId.size,
                afterFailures: consecutiveFailures,
              });
              sendJson(websocket, { type: "info", message: "VK комменты снова приходят" });
            }
            consecutiveFailures = 0;
          } catch (error) {
            consecutiveFailures += 1;
            const errorCode = getVkApiErrorCode(error);
            logger.warn("vk", "comment_poll_failed", {
              connectionId,
              openLotCount: openLotsBySessionId.size,
              consecutiveFailures,
              errorCode,
              error,
            });

            if (isFatalCommentReadError(error)) {
              logger.warn("vk", "comment_poll_stopped", {
                connectionId,
                openLotCount: openLotsBySessionId.size,
                reason: "fatal_api_error",
                errorCode,
              });
              sendJson(websocket, {
                type: "error",
                message: `VK comments недоступны для этого видео: ${error?.message || "unknown"}`,
              });
              break;
            }

            // Notify operator ONCE per outage instead of breaking the loop.
            if (consecutiveFailures === 5) {
              const hint = errorCode === 5
                ? "истёк VK-токен — обновите VK_TOKEN в .env и перезапустите"
                : "проверьте сеть/VK API";
              sendJson(websocket, {
                type: "warning",
                message: `VK комменты не приходят (${consecutiveFailures} ошибок подряд): ${hint}`,
              });
            }
          }

          // Exponential backoff on failures: 2s → 4s → 8s → 16s → 32s (cap).
          const delayMs = consecutiveFailures === 0
            ? 2000
            : Math.min(32000, 2000 * 2 ** Math.min(consecutiveFailures - 1, 4));
          await new Promise((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }

        commentPollingActive = false;
      })();
    }

    // Async: caller ждёт фиксацию «брошенных» броней в логе ДО clearActiveState
    // и потенциального завершения процесса.
    async function flushOrphanWaitlist(lot, reason) {
      if (!lot?.reservations?.events) {
        return;
      }
      // Кандидаты на ручной разбор при закрытии лота: ждавшие исхода брони
      // (waitlist_pending/pending_reservation), либо для которых попытка
      // создания заказа упала (order_failed — зритель товар не получил,
      // спрос есть, но wishlist теперь требует комментарий «СПИСОК код»).
      //
      // НЕ мигрируем reserved/reserved_appended (получили), safe_mode_logged
      // (записан для replay).
      const MIGRATE_STATUSES = new Set([
        "waitlist_pending",
        "pending_reservation",
        "order_failed",
      ]);
      const candidates = lot.reservations.events.filter((entry) => MIGRATE_STATUSES.has(entry?.status));
      if (candidates.length === 0) {
        return;
      }
      logger.warn("vk", "orphan_waitlist_at_close", {
        connectionId,
        lotSessionId: lot.lotSessionId,
        code: lot.code,
        reason,
        count: candidates.length,
        entries: candidates.map((entry) => ({
          commentId: entry.commentId,
          viewerId: entry.viewerId,
          viewerName: entry.viewerName,
          status: entry.status,
          createdAt: entry.createdAt,
        })),
      });
      sessionLog.logOrphanWaitlist({
        lotCode: lot.code,
        lotSessionId: lot.lotSessionId,
        reason,
        entries: candidates,
      });

      logger.info("wishlist", "auto_migrate_skipped_confirmation_required", {
        connectionId,
        lotSessionId: lot.lotSessionId,
        code: lot.code,
        reason,
        count: candidates.length,
      });
    }

    async function publishLotClosed(lot, reason) {
      if (!lot?.lotSessionId) {
        return;
      }

      // Сначала зафиксировать «брошенные» брони в логе, ПОТОМ закрывать
      // VK-публикацию.
      await flushOrphanWaitlist(lot, reason);

      if (isLotPoisoned(lot.lotSessionId)) {
        return;
      }

      void vk.publishLotClosed(lot).catch((error) => {
        handleVkPublishError(lot, error);
        logger.error("vk", "lot_close_publish_failed", {
          connectionId,
          code: lot.code,
          lotSessionId: lot.lotSessionId,
          reason,
          error,
        });
      });
    }

    async function applyDiscount(input, transcript = null) {
      // Раньше здесь требовался vkPublication.commentId — это блокировало
      // применение скидки в safe mode и при любых сбоях публикации в VK
      // (например, видео недоступно). Скидку считаем по внутреннему лоту
      // независимо от VK: дашборд должен показать новую цену, а в МойСклад
      // последующая бронь уже уйдёт с правильной ценой. Публикацию апдейта
      // в VK выполняем ниже, только если карточка туда вообще опубликована.
      if (!activeLot?.product) {
        return;
      }

      const salePrice = getLotEffectivePrice(activeLot);
      if (typeof salePrice !== "number" || !Number.isFinite(salePrice) || salePrice <= 0) {
        logger.warn("discount", "invalid_discount", {
          connectionId,
          reason: "no_sale_price",
          salePrice,
          lotSessionId: activeLot.lotSessionId,
        });
        return;
      }

      // Back-compat: callers may pass a bare number (rubles) or a structured
      // descriptor { kind, value }.
      const descriptor = typeof input === "number" ? { kind: "absolute", value: input } : input;
      let amount;
      if (descriptor?.kind === "percent") {
        const percent = Number(descriptor.value);
        if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
          logger.warn("discount", "invalid_discount", { connectionId, kind: "percent", value: descriptor.value });
          return;
        }
        amount = Math.floor((salePrice * percent) / 100);
      } else {
        amount = Number(descriptor?.value);
      }

      if (!Number.isFinite(amount) || amount <= 0 || amount >= salePrice) {
        logger.warn("discount", "invalid_discount", {
          connectionId,
          amount,
          salePrice,
          kind: descriptor?.kind,
          rawValue: descriptor?.value,
          lotSessionId: activeLot.lotSessionId,
        });
        return;
      }

      const originalPrice = salePrice;
      activeLot.discountAmount = amount;
      const newPrice = originalPrice - amount;

      logger.info("discount", "discount_applied", {
        connectionId,
        amount,
        originalPrice,
        newPrice,
        code: activeLot.code,
        lotSessionId: activeLot.lotSessionId,
      });
      sessionLog.logDiscount({
        amount,
        originalPrice,
        newPrice,
        code: activeLot.code,
        lotSessionId: activeLot.lotSessionId,
        descriptor,
        transcript,
      });

      // Публикация апдейта в VK имеет смысл только если карточка лота уже
      // ушла туда и лот не «битый». Иначе пропускаем без шума — скидка во
      // внутреннем состоянии уже зафиксирована и попадёт в МойСклад при брони.
      if (
        activeLot.vkPublication?.commentId
        && !isLotPoisoned(activeLot.lotSessionId)
      ) {
        await vk.publishDiscountUpdate(activeLot).catch((error) => {
          handleVkPublishError(activeLot, error);
          logger.error("vk", "discount_publish_failed", {
            connectionId,
            lotSessionId: activeLot?.lotSessionId,
            error,
          });
        });
      }

      emitState();
    }

    function isDetectionStillActive({ runId = null, enforceActiveRun = false, expectedDetectionId = null } = {}) {
      if (enforceActiveRun && runId !== activeRunId) {
        return false;
      }

      if (expectedDetectionId && activeDetectionActionId !== expectedDetectionId) {
        return false;
      }

      return true;
    }

    function buildConfirmedLot(detection, selectedCode, source = "voice", productCard = null) {
      const previousLot = activeLot;

      return {
        code: selectedCode,
        lotSessionId: `lot-${Date.now()}-${nextLotSessionId++}`,
        transcript: detection.transcript,
        source,
        openedAt: new Date().toISOString(),
        previousLotSessionId: previousLot?.lotSessionId || null,
        product: productCard ? {
          id: productCard.id,
          name: productCard.name,
          code: productCard.code,
          pathName: productCard.pathName,
          salePrice: productCard.salePrice,
          voicePrice: productCard.voicePrice ?? null,
          priceSource: productCard.priceSource || (productCard.voicePrice ? "voice" : "moysklad"),
          availableStock: productCard.availableStock,
          hasPhoto: Boolean(productCard.photo),
        } : null,
        discountAmount: 0,
        vkPublication: null,
        reservations: {
          lastCommentId: 0,
          seenCommentIds: createBoundedIdSet(),
          acceptedUserIds: createBoundedIdSet(),
          events: [],
          // Эти поля гонятся через всю логику бронирования; раньше создавались
          // лениво (`|| 0`, `?.` сахар). Явно инициализируем здесь, чтобы
          // снимок лота соответствовал тому, что выдаёт state-store после
          // recovery — без поверхностных undefined.
          primaryReservation: null,
          committedReservationCount: 0,
        },
      };
    }

    function activateConfirmedLot(detection, nextLot, source = "voice") {
      activeLot = nextLot;
      registerOpenLot(nextLot);
      lastDetection = {
        ...detection,
        status: "confirmed",
        chosen: {
          code: nextLot.code,
          source,
          fragment: detection.transcript,
          confidence: 1,
        },
      };

      // Forensic: сохраняем ВСЕХ кандидатов, не только выбранного, плюс
      // оригинальный код до обрезки по каталогу. Если выбор окажется
      // неверным, замечание делается по логу без re-parsing.
      const allCandidates = Array.isArray(detection?.candidates)
        ? detection.candidates.map((candidate) => ({
            code: candidate?.code || null,
            source: candidate?.source || null,
            confidence: typeof candidate?.confidence === "number" ? candidate.confidence : null,
            originalCode: candidate?.originalCode || null,
            knownCode: candidate?.knownCode === true,
          }))
        : [];

      logger.info("article", "article_detected", {
        connectionId,
        code: nextLot.code,
        lotSessionId: nextLot.lotSessionId,
        source,
        transcript: detection.transcript,
        // Self-contained snapshot — позволяет восстановить контекст лота из
        // одной этой строки, не сшивая её с product_card_loaded по времени.
        productId: nextLot.product?.id || null,
        productName: nextLot.product?.name || null,
        pathName: nextLot.product?.pathName || null,
        salePrice: nextLot.product?.salePrice ?? null,
        voicePrice: nextLot.product?.voicePrice ?? null,
        effectivePrice: getLotEffectivePrice(nextLot) ?? null,
        availableStock: nextLot.product?.availableStock ?? null,
        discountAmount: Number(nextLot.discountAmount || 0),
        allCandidates,
      });

      voicePipeline.resetTriggerWindow("lot_opened");
      emitState();
      return nextLot;
    }

    async function mergeSameCodeRedetection(detection, source, voicePrice, gate) {
      const lot = activeLot;
      if (!lot) return;
      let productCardLazyFetched = false;
      // Lazy lookup: если карточка не подтянулась с первой попытки (например,
      // МойСклад был в таймауте), даём редетекции шанс заполнить её.
      if (!lot.product?.id) {
        try {
          const productCard = await moysklad.getProductCardByCode(lot.code);
          if (!isDetectionStillActive(gate)) return;
          if (productCard) {
            productCardLazyFetched = true;
            lot.product = {
              id: productCard.id,
              name: productCard.name,
              code: productCard.code,
              pathName: productCard.pathName,
              salePrice: productCard.salePrice,
              voicePrice: productCard.voicePrice ?? voicePrice?.value ?? null,
              priceSource: productCard.priceSource || (voicePrice?.value ? "voice" : "moysklad"),
              availableStock: productCard.availableStock,
              hasPhoto: Boolean(productCard.photo),
            };
          }
        } catch (error) {
          logger.warn("moysklad", "product_card_lookup_failed_on_redetection", {
            connectionId, code: lot.code, error,
          });
        }
      }

      // Между awaits активный лот мог смениться (оператор успел назвать
      // другой код, лот закрылся и т.д.). Любая мутация / публикация по
      // этой точке должна быть отброшена — иначе обновим цену на старом
      // объекте и выстрелим price-update в VK по уже закрытому лоту.
      if (activeLot !== lot || !isDetectionStillActive(gate)) return;

      let priceChanged = false;
      if (voicePrice?.value && lot.product
          && lot.product.voicePrice !== voicePrice.value) {
        lot.product.voicePrice = voicePrice.value;
        lot.product.priceSource = "voice";
        priceChanged = true;
      }

      lot.transcript = detection.transcript;
      lastDetection = {
        ...detection,
        status: "confirmed",
        chosen: { code: lot.code, source, fragment: detection.transcript, confidence: 1 },
        redetection: true,
      };

      logger.info("article", "article_redetection_same_code", {
        connectionId,
        code: lot.code,
        lotSessionId: lot.lotSessionId,
        source,
        transcript: detection.transcript,
        priceChanged,
        productCardLazyFetched,
        reservationsKept: lot.reservations?.events?.length || 0,
      });

      const acceptedReservationCount = lot.reservations?.events?.length || 0;
      if (priceChanged && lot.vkPublication?.commentId && !isLotPoisoned(lot.lotSessionId)) {
        // Если в лоте уже есть принятые брони — не рискуем зачумить лот
        // ошибкой VK (например, vkErrorCode=801 «комментарии закрыты»
        // через handleVkPublishError → markLotPoisoned). Цена в локальном
        // состоянии уже обновлена, операторский UI её увидит; для
        // покупателей карточка останется со старой ценой — это меньшее
        // зло, чем потеря sticky-лота со всеми броньями. Если броней
        // ещё нет, риск приемлем: терять нечего.
        if (acceptedReservationCount > 0) {
          logger.info("vk", "redetection_price_update_skipped_due_to_reservations", {
            connectionId,
            lotSessionId: lot.lotSessionId,
            code: lot.code,
            acceptedReservationCount,
          });
        } else {
          // Повторная проверка: между предыдущей проверкой и публикацией
          // ничего не было await'нуто, но это самая дорогая операция —
          // выстрелить нерелевантным update'ом в VK хуже, чем пропустить
          // обновление цены.
          if (activeLot !== lot || !isDetectionStillActive(gate)) {
            emitState();
            return;
          }
          try {
            await vk.publishPriceUpdate(lot);
          } catch (error) {
            handleVkPublishError(lot, error);
            logger.warn("vk", "redetection_price_update_failed", {
              connectionId, lotSessionId: lot.lotSessionId, error,
            });
          }
        }
      }

      voicePipeline.resetTriggerWindow("redetection_merged");
      emitState();
    }

    async function handleConfirmedDetection(detection, selectedCode, source, options = {}) {
      const {
        runId = null,
        enforceActiveRun = false,
        expectedDetectionId = null,
        voicePrice = null,
      } = options;

      if (!isDetectionStillActive({ runId, enforceActiveRun, expectedDetectionId })) {
        return;
      }

      // Этап 4: если каталог загружен — пропускаем только коды, известные
      // МойСкладу. Иначе голосовой путь молча открывал лот для «00011» с
      // null-карточкой и оператор узнавал о промахе только по логам.
      // Параллель с ручным вводом (manualCode rejection above).
      const knownCodesForGate = productCodeCache?.getCodes?.() || null;
      if (knownCodesForGate && knownCodesForGate.size > 0 && !knownCodesForGate.has(selectedCode)) {
        logger.warn("article", "voice_code_rejected_unknown", {
          connectionId,
          code: selectedCode,
          source,
          transcript: detection?.transcript ?? null,
        });
        sendJson(websocket, {
          type: "warning",
          message: `Код ${selectedCode} не найден в каталоге МойСклад`,
        });
        return;
      }

      // Идемпотентная переразметка. Оператор регулярно проговаривает код
      // повторно (распознавание сорвалось, диктует цену, добавляет описание).
      // Раньше каждый такой повтор закрывал текущий лот, помечал ожидающих
      // как orphan_waitlist, и открывал заново — терялись брони, написанные
      // между двумя произнесениями (см. эфир 24.05.2026: лоты 03199/03202/
      // 03212 переоткрывались 2–3 раза каждый). При том же коде, что и у
      // активного лота, не делаем close+reopen — только мерджим новые данные
      // (voicePrice, product card если был null) в существующий lotSessionId.
      const sameCodeOpenLot = getOpenLots().find((lot) => lot.code === selectedCode) || null;
      if (sameCodeOpenLot?.lotSessionId && !isLotPoisoned(sameCodeOpenLot.lotSessionId)) {
        activeLot = sameCodeOpenLot;
        await mergeSameCodeRedetection(detection, source, voicePrice, {
          runId, enforceActiveRun, expectedDetectionId,
        });
        return;
      }

      let productCard = null;

      try {
        productCard = await moysklad.getProductCardByCode(selectedCode);
      } catch (error) {
        logger.error("moysklad", "product_card_lookup_failed", {
          connectionId,
          code: selectedCode,
          transcript: detection.transcript,
          error,
        });
      }

      if (productCard && !hasUsableSalePrice(productCard) && voicePrice?.value) {
        productCard.voicePrice = voicePrice.value;
        productCard.priceSource = "voice";
      }

      if (!isDetectionStillActive({ runId, enforceActiveRun, expectedDetectionId })) {
        return;
      }

      const confirmedLot = buildConfirmedLot(detection, selectedCode, source, productCard);
      let publicationCommentId = null;

      try {
        const publication = await vk.publishLotCard(confirmedLot, productCard);
        publicationCommentId = getVkPublicationCommentId(publication);
      } catch (error) {
        handleVkPublishError(confirmedLot, error);
        logger.error("vk", "lot_card_publish_failed", {
          connectionId,
          code: selectedCode,
          lotSessionId: confirmedLot.lotSessionId,
          error,
        });
      }

      if (!isDetectionStillActive({ runId, enforceActiveRun, expectedDetectionId })) {
        return;
      }

      if (publicationCommentId !== null) {
        const reservationState = ensureReservationState(confirmedLot);
        confirmedLot.vkPublication = {
          commentId: publicationCommentId,
        };
        reservationState.lastCommentId = Math.max(reservationState.lastCommentId, publicationCommentId);
      }

      activateConfirmedLot(detection, confirmedLot, source);
      sessionLog.logLotOpened({
        code: confirmedLot.code,
        lotSessionId: confirmedLot.lotSessionId,
        productName: productCard?.name || null,
        salePrice: productCard?.salePrice ?? null,
        voicePrice: productCard?.voicePrice ?? null,
        availableStock: productCard?.availableStock ?? null,
        transcript: confirmedLot.transcript,
        source: confirmedLot.source,
      });
      startCommentPolling();

      voicePipeline.resetTriggerWindow("confirmed_detection_completed");
    }

    logger.info("ws", "client_connected", { connectionId });

    websocket.on("message", async (message, isBinary) => {
      try {
        if (isBinary) {
          if (!session) {
            return;
          }

          session.pushAudio(Buffer.from(message));
          return;
        }

        const payload = JSON.parse(message.toString());

        if (payload.type === "start") {
          const runId = nextRunId++;

          activeRunId = null;
          session?.close();
          session = null;

          if (payload.vkLiveVideoUrl) {
            vk.setLiveVideoUrl(payload.vkLiveVideoUrl);
          }

          logger.info("ws", "stream_start_requested", {
            connectionId,
            sampleRate: payload.sampleRate,
            encoding: payload.encoding,
            deviceId: payload.deviceId,
            vkLiveVideoUrl: payload.vkLiveVideoUrl || null,
          });
          sessionLog.logSessionStart({
            connectionId,
            vkLiveVideoUrl: payload.vkLiveVideoUrl || null,
            context: {
              version: services.packageVersion || null,
              safeMode: isSafeMode(),
              productCache: productCodeCache?.getSnapshot?.() || null,
              featureFlags: {
                moyskladEnabled: Boolean(moysklad?.isEnabled ?? true),
                vkEnabled: Boolean(vk?.isEnabled ?? true),
                wishlistActive: wishlistStore?.getActiveCount?.() ?? 0,
              },
            },
          });
          // Связываем diagnostic sink с этим writer'ом: каждый moysklad_call
          // теперь падает в .jsonl этой сессии (а не в server.log как unrouted).
          services.diagnosticRouter?.setActiveWriter?.(sessionLog.getJsonl());
          activeRunId = runId;
          const speechKitHandlers = {
            onPartial: ({ text, latencyMs }) => {
              if (runId !== activeRunId) {
                return;
              }

              sendJson(websocket, { type: "partial", text, latencyMs });
            },
            onFinal: ({ text, latencyMs }) => {
              if (runId !== activeRunId) {
                return;
              }

              logger.info("speechkit", "final_transcript", { connectionId, text, latencyMs });
              sessionLog.logTranscriptFinal({ text, latencyMs });
              sendJson(websocket, { type: "final", text, latencyMs });
              voicePipeline.rememberFinal(text);

              // Голосовая отмена брони (W3): «<Имя Фамилия> отмена лота #код».
              // НЕ исполняем отмену из речи — только находим бронь и просим
              // клиента подсветить строку; оператор подтверждает кнопкой
              // «× отменить». Это исключает авто-списание денег в МойСкладе по
              // ошибке распознавания. Обрабатываем до article-детекции и
              // выходим, чтобы «отмена лота 033322» не открыла лот 033322.
              const cancelCommand = parseCancelCommand(text);
              if (cancelCommand.matched) {
                handleVoiceCancelCommand(cancelCommand, text);
                return;
              }

              const priceResult = detectPrice(text);

              const discountResult = detectDiscount(text, config.discount.triggers);
              if (discountResult) {
                // detectDiscount now returns { kind, value }. Pass the full
                // descriptor so percent discounts are scaled by current
                // salePrice — fixes the "скидка 30 процентов → 30₽" bug.
                void applyDiscount(discountResult, text).catch((error) => {
                  logger.error("discount", "apply_failed", { connectionId, text, error });
                });
              } else {
                // Forensic: транскрипт содержит триггер скидки, но детектор
                // не извлёк сумму. Без этого лога мы видели бы тишину и не
                // понимали, что оператор хотел скидку (как в случае
                // «скидка процентов тридцать» — порядок слов ломает regex).
                const normalizedForDiscount = String(text || "").toLowerCase().replace(/ё/g, "е");
                const matchedDiscountTrigger = config.discount.triggers.some((trigger) => {
                  const nt = String(trigger || "").toLowerCase().replace(/ё/g, "е");
                  return nt && new RegExp(`(?:^|\\s)${nt}(?:$|\\s)`).test(normalizedForDiscount);
                });
                if (matchedDiscountTrigger) {
                  logger.warn("discount", "discount_skipped", {
                    connectionId,
                    text,
                    reason: "trigger_matched_but_no_amount_extracted",
                    lotSessionId: activeLot?.lotSessionId || null,
                    code: activeLot?.code || null,
                  });
                  sessionLog.logDiscountSkipped({
                    text,
                    reason: "trigger_matched_but_no_amount_extracted",
                    lotSessionId: activeLot?.lotSessionId || null,
                    code: activeLot?.code || null,
                  });
                }
              }

              void (async () => {
                const detectionInputs = voicePipeline.buildDetectionInputs(text);
                let detection = null;

                for (const input of detectionInputs) {
                  const candidateDetection = await detectArticle(input, {
                    ...detectionConfig,
                    knownCodes: productCodeCache?.getCodes?.() || null,
                  });

                  if (!detection) {
                    detection = candidateDetection;
                  }

                  if (candidateDetection.status === "confirmed") {
                    detection = candidateDetection;
                    break;
                  }

                  if (
                    candidateDetection.status === "ambiguous"
                    && detection.status !== "confirmed"
                  ) {
                    detection = candidateDetection;
                  }

                  if (
                    candidateDetection.status === "awaiting_continuation"
                    && detection.status === "no_match"
                  ) {
                    detection = candidateDetection;
                  }

                  // YandexGPT упал — повторять вызов на остальных вариантах
                  // из buildDetectionInputs бессмысленно: тот же ключ/квота
                  // даст ту же ошибку. Выходим, чтобы не плодить N упавших
                  // HTTP-запросов на один final transcript.
                  if (candidateDetection.status === "llm_error") {
                    break;
                  }
                }

                if (runId !== activeRunId) {
                  return;
                }

                const detectionWithId = {
                  ...detection,
                  detectionId: `det-${runId}-${nextDetectionId++}`,
                };

                lastDetection = detectionWithId;

                if (detectionWithId.status === "confirmed" && detectionWithId.chosen) {
                  activeDetectionActionId = detectionWithId.detectionId;
                  await handleConfirmedDetection(
                    detectionWithId,
                    detectionWithId.chosen.code,
                    detectionWithId.chosen.source,
                    {
                      runId,
                      enforceActiveRun: true,
                      expectedDetectionId: detectionWithId.detectionId,
                      voicePrice: priceResult,
                    },
                  );
                } else if (priceResult) {
                  await applyVoicePrice(priceResult, text);
                } else if (detectionWithId.status === "ambiguous") {
                  logger.warn("article", "article_ambiguous", {
                    connectionId,
                    transcript: detectionWithId.transcript,
                    candidates: detectionWithId.candidates,
                  });
                } else if (detectionWithId.status === "awaiting_continuation") {
                  logger.info("article", "article_awaiting_continuation", {
                    connectionId,
                    transcript: detectionWithId.transcript,
                  });
                } else if (
                  detectionWithId.status === "no_match"
                  && detectionWithId.matchedTrigger === true
                ) {
                  // Forensic: триггер был, но извлечения нет. Это либо мусорный
                  // транскрипт, либо непокрытая parserом конструкция (например,
                  // оператор поправился, оборвал фразу, или SpeechKit «съел»
                  // цифры). Запись помогает находить новые паттерны для парсера.
                  logger.warn("article", "article_no_match_with_trigger", {
                    connectionId,
                    transcript: detectionWithId.transcript,
                  });
                }

                if (runId !== activeRunId) {
                  return;
                }

                emitState();
              })().catch((error) => {
                logger.error("article", "article_detection_failed", {
                  connectionId,
                  text,
                  error,
                });
              });
            },
            onStatus: ({ message: statusMessage, codeType }) => {
              if (runId !== activeRunId) {
                return;
              }

              logger.warn("speechkit", "status_update", {
                connectionId,
                codeType,
                statusMessage,
              });
              sendJson(websocket, {
                type: "error",
                message: `SpeechKit status ${codeType}: ${statusMessage}`,
              });
            },
            onError: async (error) => {
              if (runId !== activeRunId) {
                return;
              }

              await publishAllLotsClosed("stream_error");
              await wishlistStore?.flush?.();
              logger.error("speechkit", "stream_error", { connectionId, error });
              sessionLog.logSessionEnd({ reason: "stream_error" });
              await sessionLog.flush();
              services.diagnosticRouter?.setActiveWriter?.(null);
              activeRunId = null;
              session?.close();
              session = null;
              // Раньше после stream_error состояние оставалось «висеть»:
              // activeLot не nullified, active-state.json не стирался. Если
              // потом сокет закрывался, второй publishLotClosed дублировал
              // orphan-флаш, а при перезапуске сервера срабатывало фейковое
              // crash-recovery (state-файл с этой сессии). Чистим всё, как
              // в обычных путях stop/socket_close.
              resetCustomerOrders();
              resetDetectionState();
              emitState();
              sendJson(websocket, { type: "error", message: error.message });
            },
            onEnd: async () => {
              // On manual stop the handler clears activeRunId before close(),
              // so guard below skips reconnect for operator-initiated stops.
              if (runId !== activeRunId) {
                return;
              }

              // Yandex SpeechKit closes a streaming gRPC session after ~10 min.
              // Re-open transparently so the operator does not have to restart.
              logger.info("speechkit", "stream_ended", { connectionId, autoReconnect: true });
              session?.close();
              try {
                session = createSpeechKitSession(config.speechkit, speechKitHandlers, { connectionId });
                logger.info("speechkit", "stream_auto_reconnected", { connectionId });
                sendJson(websocket, { type: "info", message: "STT-поток перезапущен" });
              } catch (error) {
                logger.error("speechkit", "stream_auto_reconnect_failed", { connectionId, error });
                await publishAllLotsClosed("stream_end");
                await wishlistStore?.flush?.();
                sessionLog.logSessionEnd({ reason: "stream_end" });
                await sessionLog.flush();
                services.diagnosticRouter?.setActiveWriter?.(null);
                activeRunId = null;
                session = null;
                resetCustomerOrders();
                resetDetectionState();
                emitState();
                sendJson(websocket, { type: "error", message: "STT-поток оборвался и не удалось перезапустить" });
              }
            },
          };
          session = createSpeechKitSession(config.speechkit, speechKitHandlers, { connectionId });

          resetDetectionState();
          emitState();
          return;
        }

        if (payload.type === "setLotPrice") {
          // Operator manually overrides the price on the active lot — closes
          // the gap when voice-price detection misfires ("два пять пять
          // ноль" misread as "2"). Bypasses applyVoicePrice's salePrice
          // guard because manual intent is explicit.
          const value = Number(payload.value);
          if (!activeLot?.product || !Number.isFinite(value) || value <= 0) {
            sendJson(websocket, { type: "warning", message: "Не удалось применить цену: лот неактивен или значение неверно" });
            return;
          }
          activeLot.product.voicePrice = value;
          activeLot.product.priceSource = "manual";
          // For manual override we treat the value as the operator-confirmed
          // sale price too — otherwise stock guard and reservation totals
          // still use the (wrong) salePrice from MoySklad.
          activeLot.product.salePrice = value;
          logger.info("price", "manual_price_applied", {
            connectionId,
            value,
            code: activeLot.code,
            lotSessionId: activeLot.lotSessionId,
          });
          if (activeLot.vkPublication?.commentId && !isLotPoisoned(activeLot.lotSessionId)) {
            await vk.publishPriceUpdate(activeLot).catch((error) => {
              handleVkPublishError(activeLot, error);
              logger.warn("vk", "manual_price_publish_failed", {
                connectionId,
                lotSessionId: activeLot?.lotSessionId,
                error,
              });
            });
          }
          emitState();
          return;
        }

        if (payload.type === "manualCode") {
          // Ручной ввод артикула на активном лоте (#14). Закрывает разрыв,
          // когда SpeechKit подтвердил НЕ тот код: оператор добивает код с
          // клавиатуры, а бэкенд ведёт себя как при голосовом подтверждении.
          // Конструируем detection напрямую и идём через
          // handleConfirmedDetection — НЕ через detectArticle, поэтому
          // YandexGPT-фоллбек физически недостижим (см.
          // knowledge/wiki/deferred-operator-features.md #14, FM#4).
          //
          // Вариант А: ручной ввод доступен ТОЛЬКО при активном STT-стриме.
          // Без него весь жизненный цикл лота (поллер VK, журнал сессии,
          // закрытие) не на месте — кнопка в UI заблокирована, но дублируем
          // проверку на сервере.
          if (activeRunId === null) {
            sendJson(websocket, {
              type: "warning",
              message: "Запустите распознавание перед ручным вводом кода",
            });
            return;
          }

          const code = String(payload.code ?? "").trim();
          if (!code) {
            sendJson(websocket, {
              type: "warning",
              message: "Введите код товара",
            });
            return;
          }

          // Валидация по каталогу: все товары обязаны быть в базе МойСклад.
          // Если кэш кодов недоступен/пуст — блокируем, иначе по
          // непроверенному коду откроется лот и создастся ошибочная бронь.
          const knownCodes = productCodeCache?.getCodes?.() || null;
          if (!knownCodes || knownCodes.size === 0) {
            logger.warn("article", "manual_code_rejected_no_catalog", {
              connectionId,
              code,
              catalogSize: knownCodes?.size ?? null,
            });
            sendJson(websocket, {
              type: "warning",
              message: "Каталог товаров не загружен — ручной ввод недоступен",
            });
            return;
          }
          if (!knownCodes.has(code)) {
            logger.warn("article", "manual_code_rejected_unknown", {
              connectionId,
              code,
            });
            sendJson(websocket, {
              type: "warning",
              message: `Код ${code} не найден в каталоге МойСклад`,
            });
            return;
          }

          const detectionId = `det-manual-${activeRunId}-${nextDetectionId++}`;
          const detection = {
            transcript: `manual:${code}`,
            matchedTrigger: false,
            status: "confirmed",
            candidates: [{ code, source: "manual", confidence: 1, knownCode: true }],
            chosen: { code, source: "manual", confidence: 1 },
            detectionId,
          };

          logger.info("article", "manual_code_submitted", {
            connectionId,
            code,
            detectionId,
            activeLotCode: activeLot?.code || null,
          });

          // Помечаем как активную детекцию — поздний голосовой final с другим
          // кодом инвалидирует этот manual через expectedDetectionId, и
          // наоборот (см. concurrency-gate в handleConfirmedDetection).
          activeDetectionActionId = detectionId;
          await handleConfirmedDetection(detection, code, "manual", {
            runId: activeRunId,
            enforceActiveRun: true,
            expectedDetectionId: detectionId,
            voicePrice: null,
          });
          return;
        }

        if (payload.type === "closeLot") {
          // Operator manually closes the active lot — same path as voice
          // re-detection / stream_stop, but without ending the session.
          // Useful when speech recognition missed the operator moving on.
          const closingLot = payload.lotSessionId
            ? openLotsBySessionId.get(payload.lotSessionId)
            : (payload.code
              ? getOpenLots().find((candidate) => String(candidate.code) === String(payload.code))
              : activeLot);
          if (closingLot) {
            logger.info("ws", "lot_close_requested_by_operator", {
              connectionId,
              lotSessionId: closingLot.lotSessionId,
              code: closingLot.code,
            });
            await publishLotClosed(closingLot, "manual_close");
            unregisterOpenLot(closingLot);
            if (openLotsBySessionId.size === 0) {
              resetCustomerOrders();
            }
            emitState();
          }
          return;
        }

        if (payload.type === "cancelReservation") {
          // Отмена брони оператором (#16). Удаляет позицию покупателя из
          // customerorder в МойСкладе, освобождает слот стока для следующего
          // покупателя и позволяет тому же зрителю забронировать снова.
          // Адресный DELETE по сохранённому positionId исключает удаление
          // соседней позиции того же товара (кейс reserved_appended).
          // См. knowledge/wiki/deferred-operator-features.md #16.
          const lot = payload.lotSessionId
            ? openLotsBySessionId.get(payload.lotSessionId)
            : (payload.code
              ? getOpenLots().find((candidate) => String(candidate.code) === String(payload.code))
              : activeLot);
          if (!lot) {
            sendJson(websocket, { type: "warning", message: "Нет активного лота для отмены брони" });
            return;
          }

          const state = ensureReservationState(lot);
          const events = Array.isArray(state.events) ? state.events : [];
          const targetViewerId = payload.viewerId;
          const targetCommentId = payload.commentId;
          const event = events.find((candidate) =>
            String(candidate.viewerId) === String(targetViewerId)
            && (targetCommentId == null || candidate.commentId === targetCommentId)
            && (candidate.status === "reserved" || candidate.status === "reserved_appended"));

          if (!event) {
            sendJson(websocket, { type: "warning", message: "Бронь не найдена или уже отменена" });
            return;
          }

          const orderId = event.customerOrder?.id;
          const positionId = event.customerOrder?.positionId;
          if (!orderId || !positionId) {
            logger.warn("ws", "reservation_cancel_no_position", {
              connectionId,
              lotSessionId: lot.lotSessionId,
              commentId: event.commentId,
              viewerId: event.viewerId,
              orderId: orderId || null,
            });
            sendJson(websocket, {
              type: "warning",
              message: "Нет связанной позиции МойСклад — отмените заказ вручную",
            });
            return;
          }

          // Safe-mode: явная проверка ДО вызова (в обвязке wrapWithSafeMode
          // дублируется ниже на случай флипа в полёте). Никаких реальных
          // удалений и мутаций состояния в safe-mode — только warning.
          if (isSafeMode()) {
            logger.warn("safe-mode", "reservation_cancel_blocked", {
              connectionId,
              lotSessionId: lot.lotSessionId,
              commentId: event.commentId,
              viewerId: event.viewerId,
            });
            sendJson(websocket, { type: "warning", message: "Отмена брони недоступна в safe-mode" });
            return;
          }

          let result;
          try {
            result = await moysklad.removePositionFromOrder({ orderId, positionId });
          } catch (error) {
            logger.error("moysklad", "reservation_cancel_failed", {
              connectionId,
              lotSessionId: lot.lotSessionId,
              commentId: event.commentId,
              viewerId: event.viewerId,
              orderId,
              positionId,
              error,
            });
            sendJson(websocket, { type: "warning", message: "Не удалось отменить бронь — попробуйте ещё раз" });
            return;
          }

          // safe-mode: wrapWithSafeMode вернул {skipped, safeMode} — реального
          // удаления не было, состояние не трогаем.
          if (result && result.skipped === true && result.safeMode === true) {
            logger.warn("safe-mode", "reservation_cancel_blocked", {
              connectionId,
              lotSessionId: lot.lotSessionId,
              commentId: event.commentId,
              viewerId: event.viewerId,
            });
            sendJson(websocket, { type: "warning", message: "Отмена брони недоступна в safe-mode" });
            return;
          }

          const released = Math.max(1, Number(event.quantity) || 1);
          state.committedReservationCount = Math.max(0, (state.committedReservationCount || 0) - released);
          // Снимаем зрителя из принятых, чтобы тот же покупатель мог
          // забронировать заново (или поллер VK принял его новый комментарий).
          state.acceptedUserIds.delete(event.viewerId);
          // Сбрасываем in-memory маппинг заказа на день, чтобы следующая бронь
          // этого зрителя переразрешилась через МойСклад, а не дописала позицию
          // в заказ, из которого мы только что удалили позицию.
          const broadcastDate = formatBroadcastDate(new Date(event.createdAt || Date.now()));
          customerOrdersByViewerId.delete(`${broadcastDate}:${event.viewerId}`);
          const previousStatus = event.status;
          event.status = "cancelled";

          logger.info("ws", "reservation_cancelled", {
            connectionId,
            lotSessionId: lot.lotSessionId,
            code: lot.code,
            commentId: event.commentId,
            viewerId: event.viewerId,
            viewerName: event.viewerName,
            orderId,
            positionId,
            previousStatus,
            quantityReleased: released,
            alreadyGone: Boolean(result?.alreadyGone),
          });
          sessionLog.logOrderCancelled({
            viewerName: event.viewerName,
            viewerId: event.viewerId,
            lotCode: lot.code,
            orderId,
          });
          emitState();
          return;
        }

        if (payload.type === "setSafeMode") {
          const changed = setSafeMode(payload.enabled, { source: "web-ui", connectionId });
          logger.info("ws", "safe_mode_request", {
            connectionId,
            enabled: Boolean(payload.enabled),
            changed,
          });
          if (!changed) {
            emitState();
          }
          return;
        }

        if (payload.type === "stop") {
          logger.info("ws", "stream_stop_requested", { connectionId });
          await publishAllLotsClosed("stream_stop");
          await wishlistStore?.flush?.();
          sessionLog.logSessionEnd({ reason: "stream_stop" });
          await sessionLog.flush();
          services.diagnosticRouter?.setActiveWriter?.(null);
          activeRunId = null;
          session?.close();
          session = null;
          resetCustomerOrders();
          resetDetectionState();
          emitState();
        }
      } catch (error) {
        logger.error("ws", "message_handler_failed", { connectionId, error });
        sendJson(websocket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    websocket.on("close", async () => {
      logger.info("ws", "client_disconnected", { connectionId });
      await publishAllLotsClosed("socket_close");
      await wishlistStore?.flush?.();
      sessionLog.logSessionEnd({ reason: "socket_close" });
      await sessionLog.flush();
      services.diagnosticRouter?.setActiveWriter?.(null);
      activeRunId = null;
      session?.close();
      session = null;
      resetCustomerOrders();
      resetDetectionState();
      unsubscribeSafeMode();
      clearInterval(stateSnapshotInterval);
    });
  });

  return wsServer;
}
