import { WebSocketServer } from "ws";
import { logger } from "./logger.js";
import { createSessionLog } from "./session-log.js";
import { SpeechKitStreamingSession } from "./speechkit-stream.js";
import { detectArticle, transcriptHasTrigger } from "./article-extractor.js";
import { detectDiscount, matchesDiscountTrigger } from "./discount-detector.js";
import { detectPrice } from "./price-detector.js";
import { createMoySkladClient } from "./moysklad.js";
import { createVkPublisher, isVkStreamFatalError } from "./vk.js";
import { isSafeMode, setSafeMode, onSafeModeChange } from "./safe-mode.js";
import { saveActiveState, clearActiveState } from "./state-store.js";
import { parseReservationComment, parseWishlistComment, parseCancelComment } from "./reservation-parser.js";
import { parseCancelCommand } from "./cancel-command-parser.js";
import { parseQuantityCommand } from "./quantity-command-parser.js";
import { matchNameAgainst } from "./name-matcher.js";
import { createAuth } from "./auth.js";
import { createChatClient } from "./chat-client.js";
import { createViewerLotPublisher } from "./viewer-lot.js";
import { createCrossPromoPublisher } from "./cross-promo.js";
import { resolveKnownCode } from "./product-code-resolver.js";
import { createReservationAttention } from "./domain/reservation-attention.js";
import {
  sendJson,
  getVkPublicationCommentId,
  formatBroadcastDate,
  normalizeReservationCode,
  createBoundedIdSet,
  addBoundedId,
  hasUsableSalePrice,
  getLotEffectivePrice,
  getReservationReplyMessage,
  getCancelReplyMessage,
  getCommittedReservationCount,
  RESERVATION_HISTORY_LIMIT,
} from "./ws-helpers.js";
import { createVoicePipeline } from "./domain/voice-pipeline.js";
import { createCommentPollers } from "./domain/comment-pollers.js";
import { createViewerInstructions } from "./domain/viewer-instructions.js";
import { createPendingActions } from "./domain/pending-actions.js";

let nextConnectionId = 1;
let nextLotSessionId = 1;
let nextDetectionId = 1;
let nextVoiceSuggestionId = 1;

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
  // Чат зрителей на /efir/ — второй источник комментариев наравне с VK.
  // enabled:false без STREAM_CHAT_URL: поллер не стартует, ничего не меняется.
  const chatClient = services.chatClient || createChatClient(config.chat);
  const auth = createAuth();
  const detectionConfig = config.articleExtraction;
  const productCodeCache = services.productCodeCache || null;
  const wishlistStore = services.wishlistStore || null;
  const nameCacheStore = services.nameCacheStore || null;
  const blockedViewersStore = services.blockedViewersStore || null;
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

  // Heartbeat: полумёртвый TCP (Wi-Fi роуминг, NAT-таймаут) держит
  // readyState OPEN минутами. Такой зомби-сокет блокировал реконнект
  // оператора через single-broadcast guard (409 «эфир уже запущен»), пока
  // тот не догадается про ?force=1. Пингуем всех клиентов; не ответивший
  // pong к следующему проходу — terminate, дальше штатный путь close.
  const heartbeatIntervalMs = Number(config.wsHeartbeatIntervalMs) > 0
    ? Number(config.wsHeartbeatIntervalMs)
    : 30_000;
  const heartbeatTimer = setInterval(() => {
    for (const client of wsServer.clients) {
      if (client.isAlive === false) {
        logger.warn("ws", "heartbeat_timeout_terminate", {
          connectionId: client.connectionId || null,
        });
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try { client.ping(); } catch { /* ignore */ }
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
  httpServer.on("close", () => clearInterval(heartbeatTimer));

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
    // Для heartbeat-свипа: pong возвращает клиента в живые. ws-клиент
    // браузера отвечает на ping автоматически, отдельного кода в UI не надо.
    websocket.isAlive = true;
    websocket.connectionId = connectionId;
    websocket.on("pong", () => { websocket.isAlive = true; });
    const sessionLog = createSessionLogImpl();
    // Карточка активного лота на странице зрителя /efir/ (аналог карточки в
    // VK-комментариях). Синхронизируется из emitState(), дедупит сама.
    const viewerLot = services.viewerLotPublisher || createViewerLotPublisher({
      chatClient,
      logger,
      connectionId,
    });
    // Подсказки «вторая площадка» в оба канала + плашка со ссылкой на /efir/.
    // Публикует только когда вторая площадка реально в эфире (см. cross-promo.js).
    const crossPromo = services.crossPromoPublisher || createCrossPromoPublisher({
      config,
      vk,
      chatClient,
      // Пробу своей площадки инжектит server/index.js. Импортировать
      // stream-status.js здесь нельзя: он тянет server/config.js, а тот —
      // `dotenv/config`, и .env разработчика протёк бы в тесты (заодно
      // включив им auth и настоящие адреса MediaMTX/ВК).
      getStreamStatus: services.getStreamStatus || null,
      logger,
      connectionId,
    });
    let session = null;
    let activeLot = null;
    const openLotsBySessionId = new Map();
    const priceCommitQueues = new Map();
    let lastDetection = null;
    const voicePipeline = createVoicePipeline({
      connectionId,
      detectionConfig,
    });
    let nextRunId = 1;
    let activeRunId = null;
    let activeDetectionActionId = null;
    // Проактивный реконнект SpeechKit. `speechKitEpoch` растёт при каждом
    // открытии gRPC-сессии; обработчики onEnd/onError игнорируют события
    // от устаревшей (заменённой при ротации) сессии, сравнивая свой epoch
    // с текущим. Так закрытие старого стрима во время ротации не запускает
    // повторный реактивный реконнект.
    let proactiveReconnectTimer = null;
    let speechKitEpoch = 0;

    function clearProactiveReconnect() {
      if (proactiveReconnectTimer) {
        clearTimeout(proactiveReconnectTimer);
        proactiveReconnectTimer = null;
      }
    }

    // Открывает gRPC-сессию SpeechKit и планирует её проактивную замену
    // ДО ~10-минутного лимита Yandex. На ротации новая сессия создаётся
    // первой и подменяет `session` атомарно, затем старая закрывается —
    // поэтому аудио из websocket-обработчика всегда попадает в живой стрим
    // (раньше чанки в окне close→create молча терялись).
    function openSpeechKitSession(runId, makeHandlers) {
      // Epoch повышаем ТОЛЬКО после успешного создания. Иначе при падении
      // createSpeechKitSession старая живая сессия осталась бы с устаревшим
      // epoch — её реактивный onEnd на жёстком лимите замолчал бы и STT
      // тихо умер. Так старая сессия сохраняет валидный epoch и переоткроется.
      const epoch = speechKitEpoch + 1;
      const created = createSpeechKitSession(config.speechkit, makeHandlers(epoch), { connectionId });
      speechKitEpoch = epoch;

      clearProactiveReconnect();
      const intervalMs = config.speechkit.reconnectIntervalMs;
      if (intervalMs > 0) {
        proactiveReconnectTimer = setTimeout(() => {
          if (runId !== activeRunId) {
            return;
          }
          try {
            const replacement = openSpeechKitSession(runId, makeHandlers);
            const old = session;
            session = replacement;
            // onEnd старой сессии увидит epoch !== speechKitEpoch и выйдет.
            old?.close();
            logger.info("speechkit", "stream_proactive_reconnected", { connectionId });
            sendJson(websocket, { type: "info", message: "STT-поток обновлён" });
          } catch (error) {
            // Оставляем текущую сессию; жёсткий лимит подхватит реактивный
            // onEnd. Лишь логируем, чтобы не уронить эфир.
            logger.error("speechkit", "stream_proactive_reconnect_failed", { connectionId, error });
          }
        }, intervalMs);
      }

      return created;
    }
    // Транспорт покупательских комментариев (VK + чат /efir/). Курсоры,
    // generation и backoff живут внутри модуля; наружу он отдаёт комментарии
    // в ingestViewerComment и принимает два управляющих вызова — stopVk() при
    // отравлении лота и reset() при перезапуске эфира.
    const commentPollers = createCommentPollers({
      vk,
      chatClient,
      config,
      connectionId,
      onComment: (comment) => ingestViewerComment(comment),
      getOpenLotCount: () => openLotsBySessionId.size,
      notify: (payload) => sendJson(websocket, payload),
    });
    let customerOrdersByViewerId = new Map();
    let customerOrderSessionVersion = 1;
    // «Битые» лоты: у видео в VK отключены комментарии (errorCode 801) или
    // другая неустранимая ошибка. Любые публикации/опрос для такого лота —
    // no-op до конца сессии; пользователь увидит уведомление в UI один раз.
    const poisonedLotSessionIds = new Set();
    const reservationStockGateByLotSessionId = new Map();
    // Однократные токены для голосовой команды «+N штук». Сервер выдаёт
    // actionId в voiceQuantityMatch и хранит проверенный target (lot, event,
    // quantity). При appendReservationQuantity клиент возвращает этот же
    // actionId — сервер берёт значения ИЗ pendingQuantityActions, игнорируя
    // присланные клиентом lotSessionId/viewerId/commentId/quantity. Так
    // клиент не может произвольным WS-сообщением добавить позицию любой
    // брони (HIGH из opencode review 2026-06-01). TTL 60 сек — за это время
    // оператор либо кликает, либо команда устаревает.
    const pendingQuantityActions = createPendingActions({ ttlMs: 60_000 });

    // Те же однократные токены для «забронировать из строки внимания»: покупатель
    // написал код, под который открытого лота нет (лот закрыт час назад или это
    // был первый день кампании), сервер бронировать сам не стал и вынес строку
    // оператору. Клик по «✓ забронировать» возвращает actionId, а code/viewerId
    // сервер берёт из своей map — клиентскому payload здесь верить нельзя, это
    // прямая запись позиции в МойСклад.
    //
    // TTL заметно больше, чем у «+N штук»: строка внимания живёт в баннере до
    // разбора, оператор доходит до неё между лотами, а не в ту же секунду.
    const pendingAttentionReservations = createPendingActions({
      ttlMs: 30 * 60_000,
      max: 200,
    });
    // Токен намеренно НЕ тратится до успешной записи (чтобы сбой МойСклада можно
    // было повторить тем же кликом), поэтому от двойного клика он не защищает:
    // обработчик сообщений не сериализован, и два кадра успевают пройти peek до
    // того, как первый допишет позицию. Получалось ДВА заказа на одного
    // покупателя. Тот же приём, что у appendReservationQuantity (appendInFlight).
    const attentionReservationsInFlight = new Set();
    let allLotsClosePromise = null;
    const reservationWorkByLotSessionId = new Map();
    const closingLotsBySessionId = new Map();
    const closingReservationAdmission = new Set();

    function isLotPoisoned(lotSessionId) {
      return Boolean(lotSessionId) && poisonedLotSessionIds.has(lotSessionId);
    }

    function markLotPoisoned(lot, reason, error) {
      const lotSessionId = lot?.lotSessionId;
      if (!lotSessionId || poisonedLotSessionIds.has(lotSessionId)) {
        return;
      }
      poisonedLotSessionIds.add(lotSessionId);
      // Останавливаем активный VK-цикл — следующая итерация увидит выросший
      // generation и выйдет. Чат /efir/ при этом продолжает принимать брони.
      commentPollers.stopVk();
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
      // Зрители на своей площадке видят лот здесь же: одна точка входа на все
      // изменения лота (открытие, цена голосом, скидка, закрытие), поэтому
      // отдельных вызовов рядом с каждым vk.publish* не нужно.
      viewerLot.sync(activeLot);
      emitStateSnapshot();
    }

    const unsubscribeSafeMode = onSafeModeChange((enabled, meta) => {
      sessionLog.logSafemodeToggled({ enabled, source: meta?.source });
      emitState();
    });

    // Снимок state раз в 30 секунд (только пока есть активный лот) — даёт
    // мне «реперные точки» в диагностическом jsonl, чтобы реконструировать
    // состояние в любой момент эфира без жадного логирования каждой мутации.
    function emitStateSnapshot() {
      const openLots = getOpenLots();
      if (openLots.length === 0) return;
      const activeLotSnapshot = activeLot?.lotSessionId
        ? summarizeLotForDiagnostics(activeLot)
        : null;
      sessionLog.logStateSnapshot({
        activeLot: activeLotSnapshot,
        activeLotSessionId: activeLotSnapshot?.lotSessionId || null,
        openLots: openLots.map((lot) => summarizeLotForDiagnostics(lot)),
        safeMode: isSafeMode(),
        wishlistActive: services.wishlistStore?.getActiveCount?.() ?? 0,
      });
    }
    const stateSnapshotInterval = setInterval(emitStateSnapshot, 30_000);
    stateSnapshotInterval.unref();

    function resetDetectionState() {
      viewerInstructions.stop();
      // Плашка запасной площадки гаснет вместе с инструкциями — иначе зритель
      // остался бы со ссылкой на уже закончившийся эфир.
      crossPromo.stop();
      commentPollers.reset();
      activeLot = null;
      openLotsBySessionId.clear();
      allLotsClosePromise = null;
      reservationWorkByLotSessionId.clear();
      closingLotsBySessionId.clear();
      closingReservationAdmission.clear();
      lastDetection = null;
      // Карантин цены/скидки живёт ровно столько же, сколько распознавание,
      // которое его породило: после остановки эфира выбирать уже не из чего.
      pendingAmbiguity = null;
      activeDetectionActionId = null;
      // Токены строк внимания привязаны к комментариям прошлого эфира: после
      // перезапуска поллер перечитает комментарии и выдаст новые.
      pendingAttentionReservations.clear();
      attentionReservationsInFlight.clear();
      // Эфир остановлен/сокет закрыт — карточка лота у зрителей не должна
      // висеть до следующего эфира (сюда попадает и close, где emitState()
      // уже некому вызвать).
      viewerLot.clear();
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

    function summarizeLotForDiagnostics(lot) {
      if (!lot) return null;
      const reservations = lot.reservations || {};
      const events = Array.isArray(reservations.events) ? reservations.events : [];
      const eventsByStatus = {};
      for (const event of events) {
        const status = event?.status || "unknown";
        eventsByStatus[status] = (eventsByStatus[status] || 0) + 1;
      }
      const salePrice = Number(getLotEffectivePrice(lot) || 0);
      const discountAmount = Number(lot.discountAmount || 0);
      return {
        code: lot.code || null,
        lotSessionId: lot.lotSessionId || null,
        productId: lot.product?.id || null,
        productName: lot.product?.name || null,
        pathName: lot.product?.pathName || null,
        availableStock: lot.product?.availableStock ?? null,
        stockUnknown: lot.product?.stockUnknown === true,
        salePrice: lot.product?.salePrice ?? null,
        voicePrice: lot.product?.voicePrice ?? null,
        effectivePrice: Number.isFinite(salePrice) ? salePrice : null,
        discountAmount: Number.isFinite(discountAmount) ? discountAmount : 0,
        discountedPrice: Number.isFinite(salePrice) ? Math.max(0, salePrice - discountAmount) : null,
        openedAt: lot.openedAt || null,
        source: lot.source || null,
        eventsByStatus,
        committedReservationCount: reservations.committedReservationCount || 0,
        primaryReservation: reservations.primaryReservation || null,
      };
    }

    function buildReservationDiagnosticPayload(lot, event, extra = {}) {
      const lotSnapshot = summarizeLotForDiagnostics(lot) || {};
      const order = event?.customerOrder || {};
      return {
        lotSessionId: lotSnapshot.lotSessionId || lot?.lotSessionId || null,
        code: lotSnapshot.code || lot?.code || event?.lotCode || null,
        commentId: event?.commentId ?? null,
        commentText: typeof event?.text === "string" ? event.text.slice(0, 200) : "",
        commentCreatedAt: event?.createdAt || null,
        viewerId: event?.viewerId ?? null,
        viewerName: event?.viewerName || null,
        quantity: Math.max(1, Number(event?.quantity) || 1),
        status: event?.status || null,
        productId: lotSnapshot.productId || null,
        productName: lotSnapshot.productName || null,
        pathName: lotSnapshot.pathName || null,
        availableStock: lotSnapshot.availableStock ?? null,
        stockUnknown: lotSnapshot.stockUnknown === true,
        salePrice: lotSnapshot.effectivePrice ?? null,
        discountAmount: lotSnapshot.discountAmount ?? 0,
        effectivePrice: lotSnapshot.discountedPrice ?? null,
        orderId: order.id || null,
        positionId: order.positionId || null,
        ...extra,
      };
    }

    function logReservationFinalized(lot, event, extra = {}) {
      sessionLog.logReservationFinalized(buildReservationDiagnosticPayload(lot, event, extra));
    }

    function logLotClosedOnce(lot, reason) {
      if (!lot?.lotSessionId || lot.__closedLogged === true) return;
      Object.defineProperty(lot, "__closedLogged", {
        value: true,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      sessionLog.logLotClosed({
        ...summarizeLotForDiagnostics(lot),
        reason,
      });
    }

    function publishAllLotsClosed(reason) {
      if (allLotsClosePromise) {
        return allLotsClosePromise;
      }

      allLotsClosePromise = (async () => {
        const lots = getOpenLots();
        const alreadyClosing = [...closingLotsBySessionId.values()];
        for (const lot of lots) closingReservationAdmission.add(lot.lotSessionId);
        // Detach first: promoted waitlist work may already be queued in a
        // microtask. It must observe a closed lot before any MoySklad write.
        openLotsBySessionId.clear();
        activeLot = null;
        await Promise.allSettled(alreadyClosing);
        // Последовательно, чтобы при «video not found» на конце эфира можно
        // было записать ровно один warning и пропустить публикацию закрытия
        // оставшихся лотов вместо серии error publish failures в логе.
        let vkStreamUnavailable = false;
        for (const lot of lots) {
          await settleReservationWorkAtClose(lot, reason);
          await flushOrphanWaitlist(lot, reason);
          logLotClosedOnce(lot, reason);
          if (isLotPoisoned(lot.lotSessionId) || vkStreamUnavailable) {
            closingReservationAdmission.delete(lot.lotSessionId);
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
          closingReservationAdmission.delete(lot.lotSessionId);
        }
      })();

      return allLotsClosePromise;
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

    // Раньше здесь стояло state.events.slice(-20). Обрезка выглядела защитой
    // памяти, но events — не лог, а РАБОЧЕЕ состояние лота, и вытесненные
    // события ломали расчёты на популярных лотах (>20 броней):
    //
    // - backfillLotPositionPricing переставал пересчитывать ранние позиции —
    //   покупатель платил цену без объявленной скидки;
    // - продвижение очереди: waitlist_pending — короткое состояние, пока
    //   предыдущая бронь пишется в МойСклад, а следующий ждёт своей очереди
    //   (state.events.find по этому же массиву). Вытесненного обрезкой
    //   покупателя никто уже не продвинет — его бронь молча зависает;
    // - flushOrphanWaitlist не переносил их в лист ожидания при закрытии лота;
    // - extractOrphans в state-store.js не видел их при восстановлении
    //   после падения.
    //
    // committedReservationCount выше — след прошлой попытки закрыть один из
    // этих симптомов (счётчик для stock guard), а не причину.
    //
    // Роста памяти тут нет: массив живёт на ОДИН лот, а не на весь эфир.
    function addReservationEvent(lot, event) {
      const state = ensureReservationState(lot);
      state.events.push(event);
    }

    // Поиск открытого лота по произнесённому коду для voice cancel/quantity.
    // Оператор вслух обычно опускает ведущие нули («два четыре три» → «243»
    // при лоте «00243»), а строгое сравнение отвечало «нет лота» — путь
    // детекции и покупательские комментарии такой допуск уже имеют. Exact
    // всегда побеждает; иначе — codesEquivalent, но только при РОВНО одном
    // кандидате (как в findCommentTarget): двусмысленность → отказ, не угадываем.
    function findOpenLotBySpokenCode(code) {
      const lots = getOpenLots();
      const exact = lots.find((candidate) => String(candidate.code) === String(code));
      if (exact) return { lot: exact, ambiguous: false };
      const padded = lots.filter((candidate) => codesEquivalent(String(code), String(candidate.code)));
      if (padded.length === 1) return { lot: padded[0], ambiguous: false };
      return { lot: null, ambiguous: padded.length > 1 };
    }

    // Голосовая отмена брони (W3). Находит подтверждённую бронь по имени и
    // просит клиента подсветить строку. НИКОГДА не отменяет сама — реальное
    // удаление позиции в МойСкладе делает оператор кнопкой «× отменить»
    // (path cancelReservation, со своей safe-mode защитой). Неоднозначность
    // имени → предупреждение, без подсветки наугад.
    function handleVoiceCancelCommand(command, transcript) {
      const spokenName = command.name;
      const code = command.code;

      const { lot, ambiguous } = findOpenLotBySpokenCode(code);

      if (ambiguous) {
        sendJson(websocket, {
          type: "warning",
          message: `Код ${code} подходит нескольким открытым лотам — отмените нужную бронь кнопкой «× отменить»`,
        });
        return;
      }
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

    function handleVoiceQuantityCommand(command, transcript) {
      const spokenName = command.name;
      const code = command.code;
      const quantity = command.quantity;
      // `requested` — что озвучил оператор ДО клампа (парсер режет до 1..10).
      // Если запрошено больше cap, скажем об этом в UI явно, чтобы добавленное
      // количество не расходилось молча с произнесённым.
      const requested = Number.isFinite(command.requested) ? command.requested : quantity;
      const capped = requested > quantity;

      const { lot, ambiguous } = findOpenLotBySpokenCode(code);
      if (ambiguous) {
        sendJson(websocket, {
          type: "warning",
          message: `Код ${code} подходит нескольким открытым лотам — добавьте количество кнопкой`,
        });
        return;
      }
      if (!lot) {
        sendJson(websocket, {
          type: "warning",
          message: `Нет открытого лота ${code} для добавления (${spokenName})`,
        });
        return;
      }

      const state = ensureReservationState(lot);
      const events = Array.isArray(state?.events) ? state.events : [];
      const confirmable = events.filter(
        (e) => e.status === "reserved" || e.status === "reserved_appended",
      );
      // Dedupe по (viewerId, commentId): после первого voice append у того же
      // покупателя появляется reserved_appended событие, и без dedupe два
      // одинаковых имени дают «ambiguous» — оператор не может голосом добавить
      // ещё штук (MEDIUM из opencode review). Берём первое событие на пару
      // viewer+comment — этого достаточно, чтобы name-matcher не плодил
      // искусственные дубли. Поиск реального event для апдейта идёт по
      // первому reserved* событию того же viewerId.
      const seen = new Set();
      const candidates = [];
      for (const e of confirmable) {
        const key = `${e.viewerId}:${e.commentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          viewerId: e.viewerId,
          commentId: e.commentId,
          name: e.viewerName || nameCacheStore?.getName?.(e.viewerId) || "",
        });
      }
      const matches = matchNameAgainst(spokenName, candidates);

      logger.info("ws", "voice_quantity_command", {
        connectionId,
        lotSessionId: lot.lotSessionId,
        spokenCode: code,
        spokenName,
        quantity,
        transcript: typeof transcript === "string" ? transcript.slice(0, 200) : "",
        candidateCount: candidates.length,
        matchCount: matches.length,
        topScore: matches[0]?.score ?? null,
      });

      if (confirmable.length === 0) {
        sendJson(websocket, {
          type: "warning",
          message: `Нет подтверждённых броней на лоте ${code}`,
        });
        return;
      }
      if (matches.length === 0) {
        sendJson(websocket, {
          type: "warning",
          message: `Не нашёл бронь по имени «${spokenName}» — добавьте позицию вручную`,
        });
        return;
      }
      if (matches.length > 1 && matches[0].score === matches[1].score) {
        sendJson(websocket, {
          type: "warning",
          message: `Несколько броней похожи на «${spokenName}» — выберите нужную и подтвердите`,
        });
        return;
      }

      const best = matches[0];
      // Однократный токен, который вернётся в appendReservationQuantity.
      // Без него любой WS-клиент мог бы прислать произвольные
      // viewerId/commentId/quantity и создать чужую позицию в МойСкладе.
      const actionId = pendingQuantityActions.issue({
        lotSessionId: lot.lotSessionId,
        viewerId: best.viewerId,
        commentId: best.commentId,
        quantity,
      });

      sendJson(websocket, {
        type: "voiceQuantityMatch",
        actionId,
        viewerId: best.viewerId,
        commentId: best.commentId,
        viewerName: best.name,
        spokenName,
        code,
        lotSessionId: lot.lotSessionId,
        quantity,
        requested,
        capped,
      });
    }

    // Читаем pending action БЕЗ удаления — токен живёт, пока append реально не
    // применился. Раньше удаление в начале хендлера означало, что при ошибке
    // МойСклада «попробуйте ещё раз» было невозможно: токен уже потрачен, а
    // кнопка в UI висела на «…». Истёкший токен подчищаем здесь же.
    function peekPendingQuantityAction(actionId) {
      return pendingQuantityActions.peek(actionId);
    }

    // Регистрирует строку внимания как выполнимое действие «забронировать».
    // Возвращает actionId или null, если бронировать по этой строке нельзя
    // (нет однозначного каталожного кода — гадать в денежном пути запрещено).
    function registerPendingAttentionReservation({ code, viewerId, viewerName, commentId, quantity, source }) {
      if (!code || viewerId == null) {
        return null;
      }

      return pendingAttentionReservations.issue({
        code: String(code),
        viewerId,
        viewerName: viewerName || "",
        commentId: commentId ?? null,
        quantity: Math.min(10, Math.max(1, Number(quantity) || 1)),
        source: source === "chat" ? "chat" : "vk",
      });
    }

    // Как peekPendingQuantityAction: токен не тратится до успешной записи,
    // чтобы при сбое МойСклада оператор мог повторить тем же кликом.
    function peekPendingAttentionReservation(actionId) {
      return pendingAttentionReservations.peek(actionId);
    }

    // Окно голосовой правки. Любой ценовой триггер с числом в пределах 8
    // токенов переписывал цену активного лота без всякой проверки, что фраза
    // вообще про товар: 2026-08-15 лот 03048 за девять минут получил цены 28 ₽
    // («жара стоит сегодня двадцать восемь»), 1200 ₽ («крем тысяча двести»),
    // 644 ₽ и 650 ₽ (цены Озона) — и каждая уехала комментарием в VK.
    //
    // Правило: голос меняет цену только пока окно лота открыто. Дальше он
    // предлагает, а решает оператор. 90 секунд покрывают 99 % реальных цен
    // (медиана 6 с, p90 22 с) и 95 % скидок; цена и скидка держат
    // ОТДЕЛЬНЫЕ гейты, потому что в 52 из 58 лотов скидка называется ПОСЛЕ
    // цены, и общий флаг отправил бы их все в подсказки.
    //
    // Сброс — только по новому lotSessionId. Повторное называние того же
    // артикула окно не открывает: 302 переобнаружения в бандле против 4
    // полезных цен, то есть это была бы лазейка, а не удобство.
    const VOICE_CHANGE_WINDOW_MS = Number(config?.voiceChangeWindowMs) > 0
      ? Number(config.voiceChangeWindowMs)
      : 90_000;
    const MAX_VOICE_SUGGESTIONS = 5;

    function isVoiceGateOpen(lot, kind) {
      if (!lot) return false;
      // Строго !== false: лот, восстановленный из снимка без этих полей,
      // считается закрытым в обе стороны. Молча пустить голос в цену
      // после рестарта — ровно тот случай, ради которого окно и вводится.
      const closed = kind === "price" ? lot.voicePriceAutoClosed : lot.voiceDiscountAutoClosed;
      if (closed !== false) return false;
      const openedAt = Number(lot.voiceWindowOpenedAt);
      if (!Number.isFinite(openedAt)) return false;
      return Date.now() - openedAt <= VOICE_CHANGE_WINDOW_MS;
    }

    // Подсказка живёт НА ЛОТЕ, а не в отдельной коллекции: так она физически
    // не может примениться к другому лоту, уезжает вместе с ним в снимок
    // состояния и умирает вместе с ним при закрытии.
    function addVoiceSuggestion(lot, suggestion) {
      if (!lot) return;
      if (!Array.isArray(lot.voiceSuggestions)) lot.voiceSuggestions = [];
      const entry = {
        id: `sg-${lot.lotSessionId}-${nextVoiceSuggestionId++}`,
        lotSessionId: lot.lotSessionId,
        createdAt: new Date().toISOString(),
        ...suggestion,
      };
      lot.voiceSuggestions.push(entry);
      if (lot.voiceSuggestions.length > MAX_VOICE_SUGGESTIONS) {
        lot.voiceSuggestions.splice(0, lot.voiceSuggestions.length - MAX_VOICE_SUGGESTIONS);
      }
      logger.info("price", "voice_change_suggested", {
        connectionId,
        kind: entry.kind,
        value: entry.value,
        code: lot.code,
        lotSessionId: lot.lotSessionId,
        transcript: entry.transcript || null,
      });
      emitState();
      return entry;
    }

    // Неоднозначный артикул: каталог подтвердил несколько прочтений одной
    // фразы. Спецификация 4.1 пункт 4 требует не открывать лот автоматически,
    // а показать выбор оператору. Держим ОДНУ такую запись — фраза старше
    // следующей неоднозначности оператору уже не нужна.
    //
    // Цена и скидка из того же транскрипта лежат здесь же, в карантине:
    // применить их к предыдущему лоту нельзя (фраза про другой товар), а
    // выбросить жалко — в реальных фразах цена звучит в том же предложении.
    let pendingAmbiguity = null;

    function registerAmbiguousDetection(detection, { priceResult = null, discountResult = null } = {}) {
      const candidates = (detection.candidates || [])
        .filter((candidate) => candidate?.knownCode === true && candidate.code)
        .slice(0, 3);
      pendingAmbiguity = {
        detectionId: detection.detectionId,
        transcript: detection.transcript,
        candidateCodes: candidates.map((candidate) => candidate.code),
        priceResult,
        discountResult,
      };
      lastDetection = {
        ...detection,
        heldPrice: priceResult?.value ?? null,
      };
      logger.warn("article", "article_ambiguous", {
        connectionId,
        detectionId: detection.detectionId,
        transcript: detection.transcript,
        candidates: pendingAmbiguity.candidateCodes,
        heldPrice: priceResult?.value ?? null,
        heldDiscount: discountResult ? `${discountResult.kind}:${discountResult.value}` : null,
      });
      sendJson(websocket, {
        type: "articleAmbiguous",
        detectionId: detection.detectionId,
        transcript: detection.transcript,
        candidates: candidates.map((candidate) => ({
          code: candidate.code,
          source: candidate.source || null,
        })),
        heldPrice: priceResult?.value ?? null,
      });
    }

    async function applyVoicePrice(priceResult, transcript = null) {
      if (!priceResult?.value) {
        return false;
      }
      // Тихие no-op здесь стоили оператору уверенности: он называет цену,
      // система молчит — и только в логах видно почему. Теперь каждый отказ
      // отвечает warning'ом в UI.
      if (!activeLot?.product) {
        sendJson(websocket, {
          type: "warning",
          message: `Распознал цену ${priceResult.value} ₽, но открытого лота нет — цена не применена`,
        });
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
        sendJson(websocket, {
          type: "warning",
          message: `Цена ${priceResult.value} ₽ из речи не применена: у лота ${activeLot.code} уже есть цена ${activeLot.product.salePrice} ₽ из МойСклад. Изменить можно кликом по цене лота`,
        });
        return false;
      }

      if (!isVoiceGateOpen(activeLot, "price")) {
        addVoiceSuggestion(activeLot, {
          kind: "price",
          value: priceResult.value,
          trigger: priceResult.trigger || null,
          transcript,
        });
        sendJson(websocket, {
          type: "warning",
          message: `Услышал цену ${priceResult.value} ₽ для лота ${activeLot.code}, но цена уже задана — предложил вместо замены`,
        });
        return false;
      }

      await commitLotPrice(activeLot, {
        value: priceResult.value,
        source: "voice",
        trigger: priceResult.trigger || null,
        transcript,
      });
      return true;
    }

    // Скидка хранится абсолютной суммой (discountAmount), потому что её читают
    // ~12 мест — от построения позиции в МойСкладе до карточки VK. Дескриптор
    // хранит ИСХОДНОЕ намерение оператора рядом с суммой, и после смены цены
    // процентная скидка пересчитывается вместо того, чтобы остаться рублями от
    // старой цены (эфир 2026-08-15, лот 03048: цена вернулась на 8800 ₽, а лот
    // остался 8768 ₽ — 32 ₽ это 5 % от ложных 650 ₽).
    //
    // Лот без дескриптора трактуется как абсолютная скидка и не трогается:
    // это и миграция сохранённого состояния, и поведение по умолчанию.
    function recomputeLotDiscountAmount(lot) {
      if (lot?.discountDescriptor?.kind !== "percent") {
        return;
      }
      const percent = Number(lot.discountDescriptor.value);
      // getLotEffectivePrice — цена ДО скидки (её же берёт applyDiscount).
      const salePrice = Number(getLotEffectivePrice(lot) || 0);
      if (!Number.isFinite(percent) || percent <= 0 || !Number.isFinite(salePrice) || salePrice <= 0) {
        return;
      }
      const amount = Math.floor((salePrice * percent) / 100);
      lot.discountAmount = amount > 0 && amount < salePrice ? amount : 0;
    }

    // Единая точка изменения цены лота: состояние → пересчёт скидки →
    // переоценка уже созданных позиций в МойСкладе → карточка VK → лог.
    //
    // Раньше путей было два — applyVoicePrice (голос) и setLotPrice (клик
    // оператора), — и backfillLotPositionPricing не звал ни один: его звала
    // только скидка. Поэтому правка цены после первых броней оставляла позиции
    // в заказах по старой цене, и оператор правил заказы руками.
    async function commitLotPrice(lot, {
      value,
      source,
      trigger = null,
      transcript = null,
      publishVkUpdate = true,
    } = {}) {
      const queueKey = lot.lotSessionId;
      const previous = priceCommitQueues.get(queueKey) || Promise.resolve();
      const current = previous.catch(() => {}).then(async () => {
        lot.product.voicePrice = value;
        lot.product.priceSource = source;
        // Ручная правка — явное намерение оператора, поэтому перекрываем и
        // salePrice: иначе склад-гейт и суммы броней продолжают считаться по
        // старой (неверной) цене из МойСклада.
        if (source === "manual") {
          lot.product.salePrice = value;
        }
        // Цена у лота теперь есть — голос дальше только предлагает. Ручная
        // правка закрывает гейт по той же причине: перебивать голосом то, что
        // оператор ввёл руками, нельзя.
        lot.voicePriceAutoClosed = true;

        recomputeLotDiscountAmount(lot);

        logger.info("price", source === "manual" ? "manual_price_applied" : "voice_price_applied", {
          connectionId,
          value,
          voicePrice: value,
          source,
          trigger,
          code: lot.code,
          lotSessionId: lot.lotSessionId,
          discountAmount: Number(lot.discountAmount || 0),
          transcript,
        });
        sessionLog.logPriceChanged({
          code: lot.code,
          lotSessionId: lot.lotSessionId,
          source,
          value,
          trigger,
          transcript,
        });

        await backfillLotPositionPricing(lot, { reason: "price_changed" });

        if (publishVkUpdate && lot.vkPublication?.commentId && !isLotPoisoned(lot.lotSessionId)) {
          await vk.publishPriceUpdate(lot).catch((error) => {
            handleVkPublishError(lot, error);
            logger.warn("vk", "price_update_publish_failed", {
              connectionId,
              lotSessionId: lot?.lotSessionId,
              source,
              error,
            });
            sendJson(websocket, {
              type: "warning",
              message: `Цена применена, но обновить карточку в VK не удалось — покупатели видят старую цену лота ${lot?.code || ""}`.trim(),
            });
          });
        }

        emitState();
        await replayPendingReservations(lot);
      });
      priceCommitQueues.set(queueKey, current);

      try {
        return await current;
      } finally {
        if (priceCommitQueues.get(queueKey) === current) {
          priceCommitQueues.delete(queueKey);
        }
      }
    }

    // Брони, которые ждали цену (см. reservation_held_no_price). Проигрываем
    // строго ПО ОДНОЙ: параллельный запуск сломал бы гейт склада и инвариант
    // «один primary + очередь ожидания».
    async function replayPendingReservations(lot) {
      const state = ensureReservationState(lot);
      const held = (state.events || []).filter((event) => event.status === "pending_reservation");
      if (held.length === 0) return;
      logger.info("vk", "reservations_replayed_after_price", {
        connectionId,
        lotSessionId: lot.lotSessionId,
        code: lot.code,
        count: held.length,
      });
      for (const event of held) {
        if (openLotsBySessionId.get(lot.lotSessionId) !== lot) return;
        await runReservationProcessing(lot, event);
      }
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
        return Promise.resolve();
      }

      // Бронь из чата /efir/ → ответ в тот же чат сервисным сообщением.
      // VK-poison тут не при чём (это про закрытые VK-комментарии), а ошибка
      // чата ничего не отравляет — best-effort, как и весь канал ответов.
      if (event.source === "chat") {
        return chatClient.postServiceMessage(message).then((result) => {
          if (!result.ok) {
            logger.warn("chat", "reservation_reply_failed", {
              connectionId,
              lotSessionId: lot?.lotSessionId || null,
              code: lot?.code || null,
              commentId: event.commentId,
              viewerId: event.viewerId,
              status: event.status,
              error: result.error,
            });
          }
        }).catch((error) => {
          logger.warn("chat", "reservation_reply_failed", {
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

      if (isLotPoisoned(lot?.lotSessionId)) {
        return Promise.resolve();
      }

      return vk.publishReservationReply({
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
      if (!wishlistStore || !lot || event?.viewerId == null) {
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
        && (
          openLotsBySessionId.get(lot?.lotSessionId) === lot
          || closingReservationAdmission.has(lot?.lotSessionId)
        );
    }

    function buildCustomerOrderCacheKey(viewerId, broadcastDate) {
      return `${viewerId}:${formatBroadcastDate(broadcastDate)}`;
    }

    async function withReservationStockGate(lot, task) {
      const lotSessionId = lot?.lotSessionId;
      if (!lotSessionId) {
        return task();
      }

      const previous = reservationStockGateByLotSessionId.get(lotSessionId) || Promise.resolve();
      const current = previous.catch(() => {}).then(task);
      reservationStockGateByLotSessionId.set(lotSessionId, current);
      try {
        return await current;
      } finally {
        if (reservationStockGateByLotSessionId.get(lotSessionId) === current) {
          reservationStockGateByLotSessionId.delete(lotSessionId);
        }
      }
    }

    function deleteCustomerOrderCacheForViewer(viewerId) {
      const rawKey = String(viewerId);
      const datedPrefix = `${rawKey}:`;
      customerOrdersByViewerId.delete(rawKey);
      for (const key of customerOrdersByViewerId.keys()) {
        if (String(key).startsWith(datedPrefix)) {
          customerOrdersByViewerId.delete(key);
        }
      }
    }

    async function processReservationEvent(lot, event) {
      const state = ensureReservationState(lot);
      const reservationSessionVersion = customerOrderSessionVersion;
      const reservationCustomerOrders = customerOrdersByViewerId;
      const broadcastDate = formatBroadcastDate(new Date(event.createdAt || Date.now()));
      // Заказы объединяются только внутри одного эфира. Иначе сегодняшняя
      // бронь может попасть в старый или уже оплаченный заказ того же клиента.
      const customerOrderKey = buildCustomerOrderCacheKey(event.viewerId, broadcastDate);

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
        logReservationFinalized(lot, event, { reason: "safe_mode_preflight" });
        emitState();
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
        logReservationFinalized(lot, event, { reason: "product_missing" });
        emitState();
        await notifyReservationStatus(lot, event);
        return;
      }

      // Позиция с ценой 0 — это не бронь, а потерянные деньги: в бандле
      // 2026-08-15 таких заказов 62 из 962. Раньше бронь уходила в МойСклад
      // независимо от цены, в расчёте что цена прозвучит через пару секунд;
      // если она не звучала, покупатель оставался в заказе с нулём.
      //
      // Держим бронь в pending_reservation и проигрываем её, когда цена
      // появится (commitLotPrice → replayPendingReservations). Гейт склада при
      // этом не занимаем: все брони лота ждут одинаково и проигрываются в
      // порядке поступления. Если цена так и не прозвучит, закрытие лота
      // уводит такие брони в хотелки через flushOrphanWaitlist — не теряются.
      const effectivePrice = Math.max(
        0,
        Number(getLotEffectivePrice(lot) || 0) - Number(lot.discountAmount || 0),
      );
      if (!(effectivePrice > 0)) {
        event.status = "pending_reservation";
        logger.warn("vk", "reservation_held_no_price", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          code: lot.code,
          commentId: event.commentId,
          viewerId: event.viewerId,
          salePrice: Number(getLotEffectivePrice(lot) || 0),
          discountAmount: Number(lot.discountAmount || 0),
        });
        sendJson(websocket, {
          type: "warning",
          message: `Бронь ${lot.code} от ${event.viewerName || event.viewerId} ждёт цену — назовите или введите цену лота`,
        });
        emitState();
        return;
      }

      const gateResult = await withReservationStockGate(lot, async () => {
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
            lotSessionId: lot.lotSessionId,
            commentId: event.commentId,
            position: waitlistPosition,
          });
          logReservationFinalized(lot, event, { waitlistPosition });
          emitState();
          await notifyReservationStatus(lot, event);
          return { proceed: false };
        }

        // На первой брони со «склад=unknown» — однократная попытка дотянуть
        // реальное число из MoySklad. Защищает от молчаливого over-sell в
        // случаях, когда стартовая карточка лота вернула null/0.
        await ensureStockKnownBeforeFirstReservation(lot, state);
        if (openLotsBySessionId.get(lot?.lotSessionId) !== lot) {
          // Лот закрыли, пока мы ждали MoySklad — выходим без побочных
          // эффектов; processReservationEvent вызывался для закрытого лота.
          return { proceed: false };
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
          logReservationFinalized(lot, event, { wishlistEntryId: event.wishlistEntryId || null });
          emitState();
          await notifyReservationStatus(lot, event);
          return { proceed: false };
        }

        state.primaryReservation = {
          commentId: event.commentId,
          viewerId: event.viewerId,
        };
        event.status = "creating_order";
        state.committedReservationCount = (state.committedReservationCount || 0) + needed;
        emitState();
        return { proceed: true, needed };
      });

      if (!gateResult?.proceed) {
        return;
      }

      const needed = gateResult.needed;

      let nextWaitlistEvent = null;

      try {
        let existingOrder = reservationCustomerOrders.get(customerOrderKey) || null;
        let resolvedCounterparty = null;

        // Кэш заказа мог устареть: оператор перевёл заказ в закрытый статус
        // (Запакован/Отправлен/Доставлен/Отменён) прямо во время эфира. Слепой
        // append по кэшу дописал бы позицию в уже закрытый заказ, поэтому перед
        // дозаписью перепроверяем статус ИМЕННО этого заказа в МойСкладе. При
        // закрытом/ошибке проверки — выбрасываем из кэша и переразрешаем ниже
        // через источник истины (lookup → иначе новый заказ).
        if (existingOrder?.id) {
          try {
            const appendable = await moysklad.isCustomerOrderAppendable(existingOrder.id);
            if (!appendable) {
              logger.info("moysklad", "cached_order_closed_discarded", {
                connectionId,
                lotSessionId: lot.lotSessionId,
                viewerId: event.viewerId,
                orderId: existingOrder.id,
              });
              reservationCustomerOrders.delete(customerOrderKey);
              existingOrder = null;
            }
          } catch (recheckError) {
            logger.warn("moysklad", "cached_order_recheck_failed", {
              connectionId,
              viewerId: event.viewerId,
              orderId: existingOrder.id,
              error: recheckError,
            });
            reservationCustomerOrders.delete(customerOrderKey);
            existingOrder = null;
          }
        }

        // Cross-session / cross-day merge: the in-memory map is wiped when the
        // WebSocket closes or the operator restarts the stream (and is keyed by
        // day), so the same viewer's next reservation looks "fresh" even when
        // MoySklad already has their open broadcast order. Ask MoySklad as the
        // source of truth. With config.crossDayOrderMerge on (default), the
        // lookup reuses the viewer's latest OPEN #Эфир order regardless of which
        // campaign day created it — multi-day эфиры accumulate into one order
        // per buyer; a new order starts only once the operator closes the old.
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
                  broadcastDate,
                  source: "cross_session_broadcast_lookup",
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
            : (appendResult?.id && appendResult.id !== existingOrder.id)
              // Journal dedup may recover a create from before restart even if
              // current routing selected append. Keep the order that actually
              // received the position instead of attaching it to stale cache.
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
          logReservationFinalized(lot, event, { reason: "safe_mode_mid_flight" });
          emitState();
          await notifyReservationStatus(lot, event);
          return;
        }

        if (!isReservationSessionCurrent(lot, reservationSessionVersion)) {
          const staleReason = existingOrder?.id ? "stale_session_after_append" : "stale_session_after_create";
          logger.info("vk", "reservation_result_discarded", {
            connectionId,
            lotSessionId: lot.lotSessionId,
            commentId: event.commentId,
            viewerId: event.viewerId,
            orderId: order?.id || null,
            reason: staleReason,
            note: "MoySklad write completed after the reservation session closed; omitted from the current-session cache.",
          });
          event.status = "stale_discarded";
          event.customerOrder = order;
          return;
        }

        if (!existingOrder?.id && order?.id) {
          reservationCustomerOrders.set(customerOrderKey, order);
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
        logReservationFinalized(lot, event, { appended: Boolean(existingOrder?.id) });
        await notifyReservationStatus(lot, event);
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

        logReservationFinalized(lot, event, { error: event.error });
        await notifyReservationStatus(lot, event);
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
          lotSessionId: lot.lotSessionId,
          commentId: nextWaitlistEvent.commentId,
          previousPrimaryStatus: event.status,
        });
        void runReservationProcessing(lot, nextWaitlistEvent).catch((error) => {
          logger.error("vk", "reservation_processing_unhandled", {
            connectionId,
            lotSessionId: lot.lotSessionId,
            code: lot.code,
            commentId: nextWaitlistEvent.commentId,
            viewerId: nextWaitlistEvent.viewerId,
            status: nextWaitlistEvent.status,
            error,
          });
          sendJson(websocket, {
            type: "warning",
            message: `${lot.code}: обработка брони оборвалась — проверьте заявку вручную`,
          });
        });
      }
    }

    // Этап 6 (+ log review 2026-06-05): толерантность к ВЕДУЩИМ нулям в обе
    // стороны. Покупатель пишет «бронь 0588» вместо «00588» (нулей меньше) или
    // «бронь 000296» вместо «00296» (нулей больше) — обе формы должны указывать
    // на тот же лот. Сравниваем коды после срезания ведущих нулей. Значащие
    // цифры обязаны совпасть точно, поэтому «10588»/«1588» и внутренние нули
    // («012005» vs «01205») НЕ матчатся — такие уходят оператору на разбор.
    // Неоднозначность (несколько открытых лотов после нормализации) ловит
    // правило «ровно один матч» в findCommentTarget.
    function runReservationProcessing(lot, event) {
      const key = lot?.lotSessionId;
      const work = processReservationEvent(lot, event);
      if (!key) return work;

      let pending = reservationWorkByLotSessionId.get(key);
      if (!pending) {
        pending = new Set();
        reservationWorkByLotSessionId.set(key, pending);
      }
      pending.add(work);
      const cleanup = () => {
        pending.delete(work);
        if (pending.size === 0) reservationWorkByLotSessionId.delete(key);
      };
      work.then(cleanup, cleanup);
      return work;
    }

    async function settleReservationWorkAtClose(lot, reason) {
      const key = lot?.lotSessionId;
      if (!key) return;

      const timeoutMs = Math.max(1000, Number(config.reservationCloseSettleTimeoutMs) || 15_000);
      const deadline = Date.now() + timeoutMs;
      while (reservationWorkByLotSessionId.get(key)?.size > 0) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const current = [...reservationWorkByLotSessionId.get(key)];
        let timeoutId;
        const settled = await Promise.race([
          Promise.allSettled(current).then(() => true),
          new Promise((resolve) => {
            timeoutId = setTimeout(resolve, remainingMs, false);
          }),
        ]);
        clearTimeout(timeoutId);
        if (!settled) break;
      }

      if (reservationWorkByLotSessionId.get(key)?.size > 0) {
        const uncertain = (lot.reservations?.events || []).filter((entry) => entry.status === "creating_order");
        if (uncertain.length > 0) {
          sessionLog.logOrphanWaitlist({
            lotCode: lot.code,
            lotSessionId: lot.lotSessionId,
            reason: `${reason}_creating_order_timeout`,
            entries: uncertain,
          });
          sendJson(websocket, {
            type: "warning",
            message: `${lot.code}: ${uncertain.length} заявок ещё записываются в МойСклад — проверьте их вручную`,
          });
        }
      }
    }

    function codesEquivalent(buyerCode, lotCode) {
      if (!buyerCode || !lotCode) return false;
      if (buyerCode === lotCode) return true;
      if (!/^\d+$/.test(buyerCode) || !/^\d+$/.test(lotCode)) return false;
      const stripLeadingZeros = (code) => code.replace(/^0+/, "") || "0";
      return stripLeadingZeros(buyerCode) === stripLeadingZeros(lotCode);
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
        // Несколько открытых лотов подходят под код покупателя — НЕ бронируем
        // наугад. Возвращаем причину, чтобы вызывающий код вынес это оператору
        // на дашборд (а не списал бронь не на тот артикул).
        return { lot: null, reason: "ambiguous", candidateCodes: paddedMatches.map(({ lot }) => lot.code) };
      }
      return null;
    }

    // Общая обработка одного комментария зрителя — единый вход для ОБОИХ
    // источников: VK-видео и чата /efir/. Нормализованная форма:
    //   { id, viewerId, viewerName, text, createdAt(ISO), source: "vk"|"chat", phone? }
    // id и viewerId чата живут в диапазоне 9e9+ (назначает chat-service) и не
    // пересекаются с VK. Денежный путь (matching лотов, сток-гейт, МойСклад)
    // общий и от источника не зависит; source решает только компонент логов и
    // канал ответа покупателю (notifyReservationStatus).
    // Комментарий похож на бронь, но однозначного открытого лота нет — случай
    // уходит оператору на дашборд. Логика вместе с ограничителем флуда живёт в
    // domain/reservation-attention.js: она читает открытые лоты и каталог, но
    // состояние лотов не меняет.
    const reservationAttention = createReservationAttention({
      connectionId,
      productCodeCache,
      nameCacheStore,
      getOpenLots: () => getOpenLots(),
      registerPendingReservation: (payload) => registerPendingAttentionReservation(payload),
      pendingReservationTtlMs: pendingAttentionReservations.ttlMs,
      notify: (payload) => sendJson(websocket, payload),
    });

    // Периодическая инструкция зрителям живёт в domain/viewer-instructions.js.
    // Перекрёстные подсказки заводятся и гасятся тем же циклом эфира, но
    // своим флагом (CROSS_PROMO_ENABLED=0) — поэтому crossPromo дёргается
    // рядом с ними в точках старта и остановки, а не внутри модуля.
    const viewerInstructions = createViewerInstructions({
      config,
      vk,
      chatClient,
      connectionId,
      isLive: () => Boolean(activeRunId),
    });

    // Комментарии-отмены обрабатываются один раз: поллер VK может отдать один и
    // тот же комментарий повторно, а второй проход искал бы позицию, которой уже
    // нет, и слал оператору ложное «бронь не найдена».
    const processedCancelCommentIds = createBoundedIdSet();

    // Отмена брони комментарием покупателя — включая закрытый лот и предыдущий
    // день кампании, чего кнопка оператора не умеет (она живёт на открытом лоте).
    //
    // Безопасность держится на контрагенте: заказ находится по viewerId автора
    // комментария, поэтому снять можно ТОЛЬКО собственную бронь — чужой или
    // шуточный комментарий физически не дотянется до чужого заказа.
    async function handleBuyerCancelComment(comment, parsed, logSource) {
      const viewerName = comment.viewerName || nameCacheStore?.getName?.(comment.viewerId) || "";
      const notifyOperator = (type, message) => sendJson(websocket, { type, message });

      // Ответ самому покупателю. Отвечаем в тот канал, откуда пришёл
      // комментарий — тем же способом, что и подтверждение брони
      // (notifyReservationStatus). VK-ответ идёт комментарием к ЖИВОМУ видео
      // (video.createComment с replyToComment), а не под карточку лота,
      // поэтому закрытый/чужой лот в коде отмены на адресата не влияет.
      // Poison-гейт всё равно спрашиваем: если у видео выключены комментарии
      // (ошибка 801), писать туда нельзя — очередной 801 отравил бы и текущий
      // лот. Лот для гейта: тот, по которому нашли бронь, иначе активный.
      const replyToBuyer = (outcome, { code = null, lot = null } = {}) => {
        const message = getCancelReplyMessage(outcome, { code, viewerName });
        if (!message) return;

        if (comment.source === "chat") {
          if (!chatClient?.postServiceMessage) return;
          void chatClient.postServiceMessage(message).then((result) => {
            if (!result?.ok) {
              logger.warn("chat", "cancel_reply_failed", {
                connectionId,
                commentId: comment.id,
                viewerId: comment.viewerId,
                code,
                outcome,
                error: result?.error,
              });
            }
          });
          return;
        }

        const gateLot = lot || activeLot;
        if (isLotPoisoned(gateLot?.lotSessionId)) return;

        void vk.publishReservationReply({
          commentId: comment.id,
          message,
          lotSessionId: gateLot?.lotSessionId || null,
          code,
          viewerId: comment.viewerId,
          status: `cancel_${outcome}`,
        }).catch((error) => {
          handleVkPublishError(gateLot, error);
          logger.warn("vk", "cancel_reply_failed", {
            connectionId,
            commentId: comment.id,
            viewerId: comment.viewerId,
            code,
            outcome,
            error,
          });
        });
      };

      // Дедуп раньше любой реакции: повторная доставка комментария не должна
      // ни удалять позицию второй раз, ни дёргать оператора тем же вопросом.
      if (processedCancelCommentIds.has(comment.id)) return;
      addBoundedId(processedCancelCommentIds, comment.id);

      if (!parsed.code) {
        // «отмена» без кода: у покупателя может быть несколько броней, гадать
        // нельзя. Отдаём оператору — он видит ленту комментариев.
        logger.warn(logSource, "cancel_comment_without_code", {
          connectionId,
          commentId: comment.id,
          viewerId: comment.viewerId,
          viewerName,
          text: typeof comment.text === "string" ? comment.text.slice(0, 200) : "",
        });
        notifyOperator("warning", `${viewerName || "Покупатель"} просит отмену, но не назвал артикул — уточните`);
        replyToBuyer("no_code");
        return;
      }
      const knownCodes = productCodeCache?.getCodes?.() || null;
      const resolution = knownCodes && knownCodes.size > 0
        ? resolveKnownCode(parsed.code, knownCodes)
        : { status: "no_catalog", code: parsed.code };
      const code = resolution.status === "matched" ? resolution.code : parsed.code;

      // 1. Лот ещё открыт и бронь жива в памяти — идём обычным путём: он
      // откатывает счётчик стока лота, чего путь через МойСклад сделать не может.
      const { lot } = findOpenLotBySpokenCode(code);
      if (lot) {
        const events = Array.isArray(ensureReservationState(lot).events) ? ensureReservationState(lot).events : [];
        const event = events.find((candidate) =>
          String(candidate.viewerId) === String(comment.viewerId)
          && (candidate.status === "reserved" || candidate.status === "reserved_appended"));
        if (event) {
          const { status } = await cancelReservationEvent(lot, event, { reason: "buyer_comment" });
          logger.info(logSource, "reservation_cancelled_by_comment", {
            connectionId,
            commentId: comment.id,
            viewerId: comment.viewerId,
            viewerName,
            code,
            path: "open_lot",
            status,
          });
          notifyOperator(
            status === "cancelled" ? "info" : "warning",
            status === "cancelled"
              ? `${viewerName || "Покупатель"} отменил бронь ${code} — позиция снята`
              : `${viewerName || "Покупатель"} просит отмену ${code}, снять не удалось (${status}) — проверьте МойСклад`,
          );
          replyToBuyer(status === "cancelled" ? "cancelled" : "failed", { code, lot });
          return;
        }
      }

      // 2. Лот закрыт (в этом эфире или в предыдущий день кампании) — брони в
      // памяти нет. Ищем позицию прямо в заказе покупателя.
      if (isSafeMode()) {
        logger.warn("safe-mode", "cancel_comment_blocked", {
          connectionId, commentId: comment.id, viewerId: comment.viewerId, code,
        });
        notifyOperator("warning", `Отмена ${code} от ${viewerName || "покупателя"} не выполнена: safe-mode`);
        replyToBuyer("failed", { code });
        return;
      }

      // Что писать покупателю на каждый отказ. «Не нашли» — когда снимать
      // нечего (чужой/ошибочный код, позиция уже снята); «оператор проверит» —
      // когда бронь может существовать, но тронуть её мы не вправе
      // (проведённый заказ, сбой МойСклада).
      const FAIL_OUTCOMES = {
        product_not_found: "not_found",
        no_counterparty: "not_found",
        no_position: "not_found",
        no_order: "failed",
      };

      const fail = (reason, message) => {
        logger.warn(logSource, "cancel_comment_not_executed", {
          connectionId,
          commentId: comment.id,
          viewerId: comment.viewerId,
          viewerName,
          code,
          reason,
        });
        notifyOperator("warning", message);
        replyToBuyer(FAIL_OUTCOMES[reason] || "failed", { code });
      };

      try {
        const productCard = await moysklad.getProductCardByCode(code);
        if (!productCard?.id) {
          fail("product_not_found", `Отмена ${code} от ${viewerName || "покупателя"}: артикул не найден в каталоге — снимите вручную`);
          return;
        }
        // createIfMissing:false — нет контрагента, значит и заказа нет; создавать
        // покупателя ради отмены бессмысленно.
        const counterparty = await moysklad.ensureCounterparty({
          viewerId: comment.viewerId,
          viewerName,
          createIfMissing: false,
        });
        if (!counterparty?.id) {
          fail("no_counterparty", `Отмена ${code} от ${viewerName || "покупателя"}: покупатель не найден в МойСкладе — снимите вручную`);
          return;
        }
        // Тот же поиск, что и у брони: заказ кампании, закрытые/оплаченные
        // состояния отсекаются внутри — оплаченный заказ трогать нельзя.
        const order = await moysklad.findBroadcastCustomerOrderForCounterparty(counterparty.id, {
          broadcastDate: new Date(comment.createdAt || Date.now()),
          source: logSource,
        });
        if (!order?.id) {
          fail("no_order", `Отмена ${code} от ${viewerName || "покупателя"}: открытого заказа эфира нет — возможно, он уже проведён`);
          return;
        }
        const position = await moysklad.hasPositionInOrder(order.id, productCard.id, { source: logSource });
        if (!position?.present || !position.positionId) {
          fail("no_position", `Отмена ${code} от ${viewerName || "покупателя"}: позиции в заказе ${order.name || order.id} нет — уже снята?`);
          return;
        }

        const result = await moysklad.removePositionFromOrder({
          orderId: order.id,
          positionId: position.positionId,
          source: logSource,
        });
        if (result?.skipped === true && result?.safeMode === true) {
          notifyOperator("warning", `Отмена ${code} не выполнена: safe-mode`);
          replyToBuyer("failed", { code });
          return;
        }

        logger.info(logSource, "reservation_cancelled_by_comment", {
          connectionId,
          commentId: comment.id,
          viewerId: comment.viewerId,
          viewerName,
          code,
          path: "closed_lot",
          orderId: order.id,
          positionId: position.positionId,
          alreadyGone: Boolean(result?.alreadyGone),
          status: "cancelled",
        });
        sessionLog.logOrderCancelled({
          viewerName,
          viewerId: comment.viewerId,
          lotCode: code,
          orderId: order.id,
        });
        // Кэш заказов зрителя сбрасываем: следующая его бронь должна
        // переразрешиться через МойСклад, а не дописаться в заказ, из которого
        // мы только что удалили позицию.
        deleteCustomerOrderCacheForViewer(comment.viewerId);
        notifyOperator("info", `${viewerName || "Покупатель"} отменил бронь ${code} по закрытому лоту — позиция снята из ${order.name || "заказа"}`);
        replyToBuyer("cancelled", { code });
      } catch (error) {
        logger.error("moysklad", "cancel_comment_failed", {
          connectionId,
          commentId: comment.id,
          viewerId: comment.viewerId,
          code,
          error,
        });
        notifyOperator("warning", `Отмена ${code} от ${viewerName || "покупателя"} не прошла — снимите позицию вручную`);
        replyToBuyer("failed", { code });
      }
    }

    function ingestViewerComment(comment) {
      const logSource = comment.source === "chat" ? "chat" : "vk";

      // Спамер в чёрном списке: выходим ДО парсинга, до имя-кеша и до
      // reservationAttention. Фильтр стоит первым сознательно — иначе
      // спам успевает создать бронь и заказ в МойСкладе, а отменять их
      // потом придётся вручную. Блокировка мягкая: в VK комментарий
      // остаётся, V-Amber его просто не обрабатывает.
      if (blockedViewersStore?.isBlocked?.(comment.viewerId)) {
        logger.info(logSource, "comment_blocked", {
          connectionId,
          commentId: comment.id,
          viewerId: comment.viewerId,
          viewerName: comment.viewerName
            || blockedViewersStore.get?.(comment.viewerId)?.name
            || "",
          text: typeof comment.text === "string" ? comment.text.slice(0, 200) : "",
          source: comment.source,
        });
        return;
      }

      // Лента комментариев в дашборде: оператор (Роман) ведёт эфир с телефона
      // как камеры и не видит комментарии в самом VK/на /efir/. Поэтому
      // КАЖДЫЙ незаблокированный комментарий — не только «бронь» — уходит
      // оператору отдельным событием, чтобы он читал зал на ноутбуке.
      // Стоит после фильтра блокировок (спамеры в ленту не попадают) и не
      // трогает логику броней ниже.
      sendJson(websocket, {
        type: "viewerComment",
        commentId: comment.id,
        viewerId: comment.viewerId,
        viewerName: comment.viewerName
          || nameCacheStore?.getName?.(comment.viewerId)
          || "",
        text: typeof comment.text === "string" ? comment.text.slice(0, 500) : "",
        createdAt: comment.createdAt || new Date().toISOString(),
        source: comment.source === "chat" ? "chat" : "vk",
      });

      // Отмена разбирается ДО брони: «отменяю бронь 03770» содержит и «отмена»,
      // и «бронь», и трактовать это как новую бронь нельзя.
      const cancelComment = parseCancelComment(comment.text, { preferredCode: activeLot?.code || null });
      if (cancelComment.hasCancelKeyword) {
        handleBuyerCancelComment(comment, cancelComment, logSource).catch((error) => {
          logger.error(logSource, "cancel_comment_handler_failed", {
            connectionId, commentId: comment.id, viewerId: comment.viewerId, error,
          });
        });
        return;
      }

      const target = findCommentTarget(comment.text);
      if (!target || !target.lot) {
        reservationAttention.handleNoOpenLot({ comment, target, logSource });
        return;
      }
      const { lot: currentLot, reservationComment, wishlistComment, matchedReservation, matchedWishlist } = target;
      const reservationState = ensureReservationState(currentLot);
      if (comment.source === "vk") {
        // lastCommentId — VK-курсор лота (Math.max с publicationCommentId);
        // id чата из диапазона 9e9+ задрал бы его до бессмысленного значения.
        reservationState.lastCommentId = Math.max(reservationState.lastCommentId, comment.id);
      }
      rememberSeenComment(reservationState, comment.id);

      // Forensic: каждый новый комментарий в окне лота попадает в лог,
      // даже если не «бронь». Это позволяет позже увидеть пропущенные
      // брони (опечатки, «забронируй», эмодзи) и общий шум вокруг лота.
      // Персистентный кеш имён (W3): запоминаем КАЖДОГО комментатора с
      // резолвнутым именем, не только бронирующих. Кеш переживает
      // стоп/старт эфира и используется голосовой отменой брони для
      // сопоставления произнесённого оператором имени с зрителем.
      if (nameCacheStore && comment.viewerName) {
        nameCacheStore.remember(comment.viewerId, comment.viewerName);
      }
      logger.info(logSource, "comment_seen", {
        connectionId,
        lotSessionId: currentLot.lotSessionId,
        code: currentLot.code,
        commentId: comment.id,
        viewerId: comment.viewerId,
        viewerName: comment.viewerName,
        text: typeof comment.text === "string" ? comment.text.slice(0, 200) : "",
        createdAt: comment.createdAt,
        source: comment.source,
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
          if (!comment.viewerName) {
            logger.warn(logSource, "wishlist_profile_missing", {
              connectionId,
              lotSessionId: currentLot.lotSessionId,
              commentId: comment.id,
              viewerId: comment.viewerId,
            });
            return;
          }

          const wishlistEvent = {
            commentId: comment.id,
            viewerId: comment.viewerId,
            viewerName: comment.viewerName,
            text: comment.text,
            createdAt: comment.createdAt,
            status: "wishlist_confirmed",
            lotCode: currentLot.code,
          };
          void addWishlistFromComment(currentLot, wishlistEvent).catch((error) => {
            logger.warn("wishlist", "add_from_comment_failed", {
              connectionId,
              lotSessionId: currentLot.lotSessionId,
              commentId: comment.id,
              viewerId: comment.viewerId,
              error,
            });
          });
        }
        return;
      }

      const viewerId = comment.viewerId;
      if (!comment.viewerName) {
        logger.warn(logSource, "reservation_profile_missing", {
          connectionId,
          lotSessionId: currentLot.lotSessionId,
          commentId: comment.id,
          viewerId,
        });
        return;
      }

      if (reservationState.acceptedUserIds.has(viewerId)) {
        logger.info(logSource, "reservation_duplicate_ignored", {
          connectionId,
          lotSessionId: currentLot.lotSessionId,
          commentId: comment.id,
          viewerId,
        });
        return;
      }

      addBoundedId(reservationState.acceptedUserIds, viewerId);

      const reservationQuantity = Math.max(1, Math.min(10, Number(reservationComment.quantity) || 1));
      const event = {
        commentId: comment.id,
        viewerId,
        viewerName: comment.viewerName,
        text: comment.text,
        createdAt: comment.createdAt,
        status: "pending_reservation",
        lotCode: currentLot.code,
        quantity: reservationQuantity,
        source: comment.source,
        phone: comment.phone || null,
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
      logger.info(logSource, "reservation_detected", {
        connectionId,
        lotSessionId: currentLot.lotSessionId,
        code: currentLot.code,
        commentId: comment.id,
        commentText: typeof comment.text === "string" ? comment.text.slice(0, 200) : "",
        commentCreatedAt: event.createdAt,
        viewerId,
        viewerName: event.viewerName,
        source: comment.source,
        viewerPhone: comment.phone || null,
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
        lotSessionId: currentLot.lotSessionId,
        commentId: event.commentId,
        status: event.status,
        quantity: event.quantity,
      });
      sessionLog.logReservationDetected(buildReservationDiagnosticPayload(currentLot, event, {
        reservationCommentCode: reservationComment.code,
        hasReservationKeyword: reservationComment.hasReservationKeyword,
        matchedReservation,
      }));
      emitState();
      void runReservationProcessing(currentLot, event).catch((error) => {
        logger.error("vk", "reservation_processing_unhandled", {
          connectionId,
          lotSessionId: currentLot.lotSessionId,
          code: currentLot.code,
          commentId: event.commentId,
          viewerId: event.viewerId,
          status: event.status,
          error,
        });
        sendJson(websocket, {
          type: "warning",
          message: `${currentLot.code}: обработка брони оборвалась — проверьте заявку вручную`,
        });
      });
    }

    // Async: caller ждёт durable wishlist и финальный ответ покупателю ДО
    // clearActiveState и потенциального завершения процесса.
    async function flushOrphanWaitlist(lot, reason) {
      if (!lot?.reservations?.events) {
        return;
      }
      const MIGRATE_STATUSES = new Set([
        "waitlist_pending",
        "pending_reservation",
        "order_failed",
      ]);
      const candidates = lot.reservations.events.filter((entry) => (
        MIGRATE_STATUSES.has(entry?.status) && !entry?.wishlistEntryId
      ));
      if (candidates.length === 0) {
        return;
      }

      let migrated = 0;
      const migratedEntries = [];
      const failed = [];
      for (const entry of candidates) {
        const previousStatus = entry.status;
        try {
          const wishlistEntry = await addWishlistFromComment(
            lot,
            entry,
            previousStatus === "order_failed" ? "order_failed" : "waitlist_close",
          );
          if (!wishlistEntry?.id) {
            throw new Error("Wishlist entry was not created");
          }

          entry.wishlistEntryId = wishlistEntry.id;
          if (previousStatus !== "order_failed") {
            entry.status = "out_of_stock";
            sessionLog.logReservationOutOfStock({
              viewerName: entry.viewerName,
              viewerId: entry.viewerId,
              lotCode: lot.code,
            });
          }
          logReservationFinalized(lot, entry, {
            previousStatus,
            reason: `${reason}_wishlist_migration`,
            wishlistEntryId: wishlistEntry.id,
          });
          await notifyReservationStatus(lot, entry);
          migrated += 1;
          migratedEntries.push(entry);
        } catch (error) {
          if (previousStatus !== "order_failed") {
            entry.status = "out_of_stock";
            entry.wishlistMigrationFailed = true;
            logReservationFinalized(lot, entry, {
              previousStatus,
              reason: `${reason}_wishlist_migration_failed`,
              wishlistEntryId: null,
            });
            await notifyReservationStatus(lot, entry);
          }
          failed.push(entry);
          logger.error("wishlist", "waitlist_migration_failed", {
            connectionId,
            lotSessionId: lot.lotSessionId,
            code: lot.code,
            reason,
            commentId: entry.commentId,
            viewerId: entry.viewerId,
            previousStatus,
            error,
          });
        }
      }

      if (migrated > 0) {
        sessionLog.logWaitlistMigratedToWishlist({
          lotCode: lot.code,
          lotSessionId: lot.lotSessionId,
          reason,
          count: migrated,
          entries: migratedEntries,
        });
      }

      logger.info("wishlist", "waitlist_migration_completed", {
        connectionId,
        lotSessionId: lot.lotSessionId,
        code: lot.code,
        reason,
        candidates: candidates.length,
        migrated,
        failed: failed.length,
      });

      if (failed.length > 0) {
        sessionLog.logOrphanWaitlist({
          lotCode: lot.code,
          lotSessionId: lot.lotSessionId,
          reason: `${reason}_wishlist_migration_failed`,
          entries: failed,
        });
        sendJson(websocket, {
          type: "warning",
          message: `${lot.code}: ${failed.length} заявок не удалось добавить в список ожидания — проверьте вручную`,
        });
      }
    }

    async function publishLotClosed(lot, reason) {
      if (!lot?.lotSessionId) {
        return;
      }

      const existingClose = closingLotsBySessionId.get(lot.lotSessionId);
      if (existingClose) return existingClose;
      closingReservationAdmission.add(lot.lotSessionId);

      const closePromise = (async () => {
        await settleReservationWorkAtClose(lot, reason);
        // Сначала зафиксировать «брошенные» брони в логе, ПОТОМ закрывать
        // VK-публикацию.
        await flushOrphanWaitlist(lot, reason);
        logLotClosedOnce(lot, reason);

        if (isLotPoisoned(lot.lotSessionId)) {
          return;
        }

        await vk.publishLotClosed(lot).catch((error) => {
          handleVkPublishError(lot, error);
          logger.error("vk", "lot_close_publish_failed", {
            connectionId,
            code: lot.code,
            lotSessionId: lot.lotSessionId,
            reason,
            error,
          });
        });
      })().finally(() => {
        closingReservationAdmission.delete(lot.lotSessionId);
        if (closingLotsBySessionId.get(lot.lotSessionId) === closePromise) {
          closingLotsBySessionId.delete(lot.lotSessionId);
        }
      });
      closingLotsBySessionId.set(lot.lotSessionId, closePromise);
      return closePromise;
    }

    // Отмена одной подтверждённой брони: адресный DELETE позиции в МойСкладе +
    // откат счётчиков лота. Вынесено из обработчика `cancelReservation`, чтобы
    // тем же путём шла отмена по комментарию покупателя — иначе две ветки
    // по-разному откатывают сток и кэш заказов.
    //
    // Возвращает { status } вместо того, чтобы слать сообщения самой: у кнопки
    // оператора и у комментария покупателя разные тексты.
    async function cancelReservationEvent(lot, event, { reason = "operator_cancelled" } = {}) {
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
        return { status: "no_position" };
      }

      // Safe-mode: явная проверка ДО вызова (в обвязке wrapWithSafeMode
      // дублируется ниже на случай флипа в полёте). Никаких реальных
      // удалений и мутаций состояния в safe-mode.
      if (isSafeMode()) {
        logger.warn("safe-mode", "reservation_cancel_blocked", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          commentId: event.commentId,
          viewerId: event.viewerId,
        });
        return { status: "safe_mode" };
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
        return { status: "failed" };
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
        return { status: "safe_mode" };
      }

      const state = ensureReservationState(lot);
      const released = Math.max(1, Number(event.quantity) || 1);
      state.committedReservationCount = Math.max(0, (state.committedReservationCount || 0) - released);
      // Снимаем зрителя из принятых, чтобы тот же покупатель мог
      // забронировать заново (или поллер VK принял его новый комментарий).
      state.acceptedUserIds.delete(event.viewerId);
      // Сбрасываем in-memory маппинг заказа этого зрителя, чтобы следующая
      // бронь переразрешилась через МойСклад, а не дописала позицию в заказ,
      // из которого мы только что удалили позицию. Чистим все dated-cache
      // записи зрителя: после отмены безопаснее заново спросить МойСклад.
      deleteCustomerOrderCacheForViewer(event.viewerId);
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
        reason,
      });
      sessionLog.logOrderCancelled({
        viewerName: event.viewerName,
        viewerId: event.viewerId,
        lotCode: lot.code,
        orderId,
      });
      logReservationFinalized(lot, event, {
        reason,
        previousStatus,
        quantityReleased: released,
        alreadyGone: Boolean(result?.alreadyGone),
      });
      emitState();
      return { status: "cancelled", orderId, positionId, released };
    }

    // Пересчитывает цену/скидку у позиций лота, которые УЖЕ созданы в МойСкладе.
    // Вызывается после изменения скидки лота: без этого покупатель, забронировавший
    // за секунду до объявления скидки, платит полную цену, а оператор правит заказ
    // руками. Позиции лота адресуются сохранёнными orderId/positionId — соседние
    // позиции того же товара в других заказах не трогаются.
    //
    // Никогда не роняет вызывающий поток: скидка на лоте уже применена, и сбой
    // МойСклада не должен отменять её для последующих броней.
    async function backfillLotPositionPricing(lot, { reason } = {}) {
      const state = ensureReservationState(lot);
      const events = Array.isArray(state.events) ? state.events : [];
      const targets = events.filter((event) => (
        (event.status === "reserved" || event.status === "reserved_appended")
        && event.customerOrder?.id
        && event.customerOrder?.positionId
      ));
      if (targets.length === 0) {
        return { updated: 0, failed: 0, skipped: 0 };
      }

      if (isSafeMode()) {
        logger.warn("safe-mode", "position_pricing_backfill_blocked", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          code: lot.code,
          positions: targets.length,
        });
        return { updated: 0, failed: 0, skipped: targets.length };
      }

      const salePrice = Number(getLotEffectivePrice(lot) || 0);
      const discountAmount = Number(lot.discountAmount || 0);
      let updated = 0;
      let failed = 0;
      for (const event of targets) {
        try {
          const result = await moysklad.updateCustomerOrderPositionPricing({
            orderId: event.customerOrder.id,
            positionId: event.customerOrder.positionId,
            salePrice,
            discountAmount,
            source: reason === "price_changed" ? "price_backfill" : "discount_backfill",
          });
          if (result?.skipped === true && result?.safeMode === true) {
            return { updated, failed, skipped: targets.length - updated - failed };
          }
          if (result?.ok) updated += 1;
        } catch (error) {
          failed += 1;
          logger.error("moysklad", "position_pricing_backfill_failed", {
            connectionId,
            lotSessionId: lot.lotSessionId,
            code: lot.code,
            orderId: event.customerOrder.id,
            positionId: event.customerOrder.positionId,
            viewerId: event.viewerId,
            error,
          });
        }
      }

      if (updated > 0 || failed > 0) {
        logger.info("moysklad", "position_pricing_backfilled", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          code: lot.code,
          reason: reason || null,
          salePrice,
          discountAmount,
          updated,
          failed,
        });
        sessionLog.logPositionPricingBackfilled({
          code: lot.code,
          lotSessionId: lot.lotSessionId,
          reason: reason || null,
          salePrice,
          discountAmount,
          updated,
          failed,
        });
      }
      if (failed > 0) {
        const what = reason === "price_changed" ? "Цена изменена" : "Скидка применена";
        sendJson(websocket, {
          type: "warning",
          message: `${what}, но ${failed} уже созданн${failed === 1 ? "ая бронь" : "ых броней"} по лоту ${lot.code} не пересчитал${failed === 1 ? "ась" : "ись"} — проверьте цены в МойСкладе`,
        });
      }
      return { updated, failed, skipped: 0 };
    }

    async function applyDiscount(input, transcript = null, { fromVoice = true } = {}) {
      // Раньше здесь требовался vkPublication.commentId — это блокировало
      // применение скидки в safe mode и при любых сбоях публикации в VK
      // (например, видео недоступно). Скидку считаем по внутреннему лоту
      // независимо от VK: дашборд должен показать новую цену, а в МойСклад
      // последующая бронь уже уйдёт с правильной ценой. Публикацию апдейта
      // в VK выполняем ниже, только если карточка туда вообще опубликована.
      if (!activeLot?.product) {
        sendJson(websocket, {
          type: "warning",
          message: "Распознал скидку, но открытого лота нет — скидка не применена",
        });
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
        sendJson(websocket, {
          type: "warning",
          message: `Скидка не применена: у лота ${activeLot.code} нет цены — назовите или введите цену сначала`,
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
          sendJson(websocket, {
            type: "warning",
            message: `Скидка не применена: процент вне диапазона (${descriptor.value})`,
          });
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
        sendJson(websocket, {
          type: "warning",
          message: `Скидка ${Number.isFinite(amount) ? `${amount} ₽` : ""} не применена: сумма больше или равна цене лота (${salePrice} ₽)`.replace(/\s+/g, " "),
        });
        return;
      }

      // Скидка держит собственный гейт: в 52 из 58 лотов бандла она названа
      // ПОСЛЕ цены (медиана +6 с), поэтому закрытие ценового гейта её
      // трогать не должно. Общие объявления вида «все браслетики по тридцать
      // процентов» с длинным хвостом до 18 минут окно уже не пускает.
      if (fromVoice && !isVoiceGateOpen(activeLot, "discount")) {
        addVoiceSuggestion(activeLot, {
          kind: "discount",
          value: amount,
          descriptor,
          transcript,
        });
        sendJson(websocket, {
          type: "warning",
          message: `Услышал скидку для лота ${activeLot.code}, но окно правки закрыто — предложил вместо применения`,
        });
        return;
      }

      const originalPrice = salePrice;
      activeLot.voiceDiscountAutoClosed = true;
      activeLot.discountAmount = amount;
      // Дескриптор рядом с суммой, а не вместо неё: сумма остаётся
      // производной и пересчитывается в commitLotPrice при смене цены.
      activeLot.discountDescriptor = descriptor?.kind === "percent"
        ? { kind: "percent", value: Number(descriptor.value) }
        : { kind: "absolute", value: amount };
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

      // Скидку, объявленную ПОСЛЕ первых броней, надо донести до уже созданных
      // позиций: applyDiscount меняет лот, а позиция в МойСкладе остаётся по
      // полной цене. Эфир 2026-08-01, лот 03737 — скидка через 4 секунды после
      // трёх броней, все три ушли по полной цене, оператор правил заказы руками.
      await backfillLotPositionPricing(activeLot, { reason: "discount_applied" });

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
          sendJson(websocket, {
            type: "warning",
            message: `Скидка применена, но обновить карточку в VK не удалось — покупатели видят старую цену лота ${activeLot?.code || ""}`.trim(),
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
        // Окно голосовой правки открывается вместе с лотом и сбрасывается
        // только новым lotSessionId. Если лот открылся фразой, в которой уже
        // была цена, ценовой гейт закрыт сразу — эта цена и есть первая.
        voiceWindowOpenedAt: Date.now(),
        voicePriceAutoClosed: Boolean(productCard?.voicePrice),
        voiceDiscountAutoClosed: false,
        voiceSuggestions: [],
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

      lot.transcript = detection.transcript;
      lastDetection = {
        ...detection,
        status: "confirmed",
        chosen: { code: lot.code, source, fragment: detection.transcript, confidence: 1 },
        redetection: true,
      };

      const acceptedReservationCount = lot.reservations?.events?.length || 0;
      let priceChanged = false;
      if (voicePrice?.value && lot.product
          && lot.product.voicePrice !== voicePrice.value) {
        // Переобнаружение того же кода окно НЕ открывает — иначе «назови
        // артикул ещё раз» становится способом перебить цену чем угодно.
        if (isVoiceGateOpen(lot, "price")) {
          await commitLotPrice(lot, {
            value: voicePrice.value,
            source: "voice",
            trigger: voicePrice.trigger || null,
            transcript: detection.transcript,
            publishVkUpdate: acceptedReservationCount === 0,
          });
          priceChanged = true;
        } else {
          addVoiceSuggestion(lot, {
            kind: "price",
            value: voicePrice.value,
            trigger: voicePrice.trigger || null,
            transcript: detection.transcript,
          });
        }
      }

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

      if (priceChanged && acceptedReservationCount > 0
          && lot.vkPublication?.commentId && !isLotPoisoned(lot.lotSessionId)) {
        // Если в лоте уже есть принятые брони — не рискуем зачумить лот
        // ошибкой VK (например, vkErrorCode=801 «комментарии закрыты»
        // через handleVkPublishError → markLotPoisoned). Цена в локальном
        // состоянии уже обновлена, операторский UI её увидит; для
        // покупателей карточка останется со старой ценой — это меньшее
        // зло, чем потеря sticky-лота со всеми броньями.
        logger.info("vk", "redetection_price_update_skipped_due_to_reservations", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          code: lot.code,
          acceptedReservationCount,
        });
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
      const voiceCodeResolution = knownCodesForGate && knownCodesForGate.size > 0
        ? resolveKnownCode(selectedCode, knownCodesForGate)
        : { status: "no_catalog", code: selectedCode, candidates: [] };
      if (knownCodesForGate && knownCodesForGate.size > 0 && voiceCodeResolution.status !== "matched") {
        logger.warn("article", "voice_code_rejected_unknown", {
          connectionId,
          code: selectedCode,
          candidateCodes: voiceCodeResolution.candidates || [],
          source,
          transcript: detection?.transcript ?? null,
        });
        sendJson(websocket, {
          type: "warning",
          message: `Код ${selectedCode} не найден в каталоге МойСклад`,
        });
        return;
      }
      if (voiceCodeResolution.status === "matched" && voiceCodeResolution.code !== selectedCode) {
        selectedCode = voiceCodeResolution.code;
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

      // Публикацию карточки в ВК запускаем сразу, но лот открываем НЕ дожидаясь
      // её. Раньше активация шла строго после ответа ВК, и оператор видел лот с
      // задержкой: по логам шести эфиров медиана «финал с кодом → lot_opened»
      // 1.8 с, p90 7.7 с — при том что вызовы МойСклада в этом окне занимают
      // 150–500 мс, остальное съедало ожидание ВК.
      //
      // Брони от этого не разъезжаются: поллер отбирает новые комментарии по
      // собственному курсору (comment-pollers.js), а комментарий
      // привязывается к лоту по КОДУ (findCommentTarget). Лотовый
      // lastCommentId, который заполнялся из publicationCommentId, ни на что
      // не влиял — он нигде не читается.
      const publication = vk.publishLotCard(confirmedLot, productCard);

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
      commentPollers.startVk();
      commentPollers.startChat();

      voicePipeline.resetTriggerWindow("confirmed_detection_completed");

      // Хвост публикации. Ждём его здесь, в конце: цепочка финалов остаётся
      // сериализованной (следующая фраза по-прежнему обрабатывается после этой),
      // но оператор увидел лот ещё до ответа ВК.
      await publication.then((result) => {
        const publicationCommentId = getVkPublicationCommentId(result);
        // Лот мог закрыться, пока карточка публиковалась.
        if (publicationCommentId === null || !openLotsBySessionId.has(confirmedLot.lotSessionId)) {
          return;
        }
        const reservationState = ensureReservationState(confirmedLot);
        confirmedLot.vkPublication = { commentId: publicationCommentId };
        reservationState.lastCommentId = Math.max(reservationState.lastCommentId, publicationCommentId);
        emitState();
      }).catch((error) => {
        // Отравление лота теперь происходит ПОСЛЕ старта поллеров, поэтому
        // поднятый generation гасит уже запущенный цикл. Раньше было наоборот:
        // отравляли до старта, и опрос всё равно поднимался заново.
        handleVkPublishError(confirmedLot, error);
        logger.error("vk", "lot_card_publish_failed", {
          connectionId,
          code: selectedCode,
          lotSessionId: confirmedLot.lotSessionId,
          error,
        });
      });
    }

    logger.info("ws", "client_connected", { connectionId });

    // Однократное (на эфир) предупреждение «говорите в пустоту»: клиент шлёт
    // аудио, а STT-сессии нет (упала и не переподнялась, или start не прошёл).
    // Раньше чанки молча выбрасывались, и оператор узнавал о проблеме по
    // отсутствию транскриптов.
    let warnedAudioWithoutSession = false;

    websocket.on("message", async (message, isBinary) => {
      try {
        if (isBinary) {
          if (!session) {
            // activeRunId !== null означает окно реактивного reconnect —
            // о нём оператор уже предупреждён отдельным сообщением.
            if (!warnedAudioWithoutSession && activeRunId === null) {
              warnedAudioWithoutSession = true;
              sendJson(websocket, {
                type: "warning",
                message: "Аудио приходит, но распознавание не запущено — речь не обрабатывается. Перезапустите эфир",
              });
              logger.warn("ws", "audio_without_session", { connectionId });
            }
            return;
          }
          warnedAudioWithoutSession = false;

          session.pushAudio(Buffer.from(message));
          return;
        }

        const payload = JSON.parse(message.toString());

        if (payload.type === "start") {
          const runId = nextRunId++;

          activeRunId = null;
          clearProactiveReconnect();
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

          // Реактивное переподключение после gRPC-ошибки SpeechKit. Сетевые
          // мигания приходят от grpc-js как событие error (UNAVAILABLE и
          // т.п.), а не как чистый end, — раньше любой error немедленно
          // закрывал ВСЕ открытые лоты в VK и заканчивал эфир. Теперь error
          // получает те же шансы на reconnect, что и onEnd: до 3 попыток с
          // нарастающей паузой; полный teardown — только когда они
          // исчерпаны. Счётчик сбрасывается первым же транскриптом —
          // значит, поток реально ожил.
          const ERROR_RECONNECT_DELAYS_MS = Array.isArray(config.speechkit?.errorRetryDelaysMs)
            && config.speechkit.errorRetryDelaysMs.length > 0
            ? config.speechkit.errorRetryDelaysMs
            : [500, 2000, 5000];
          const ERROR_RECONNECT_MAX = ERROR_RECONNECT_DELAYS_MS.length;
          let errorReconnectAttempts = 0;

          // Дедуп и нумерация промежуточных распознаваний (см. onPartial).
          let lastPartialText = null;
          let partialSeq = 0;

          // Очередь обработки финальных транскриптов этого эфира: детекция,
          // цена и скидка применяются строго в порядке произнесения (см.
          // комментарий у enqueue в onFinal). Ошибки гасятся в .catch каждого
          // звена, так что цепочка не «залипает» после сбоя.
          let finalProcessingChain = Promise.resolve();

          // Полный демонтаж эфира после невосстановимого сбоя STT — бывшая
          // вторая половина onError. Гард по epoch: пока шли await-ы (или
          // решение о teardown зрело в таймере), сессию могла заменить
          // проактивная ротация или новый start — тогда чужой стейт не трогаем.
          const teardownAfterStreamFailure = async (error) => {
            const epochAtEntry = speechKitEpoch;
            clearProactiveReconnect();
            await publishAllLotsClosed("stream_error");
            await wishlistStore?.flush?.();
            sessionLog.logSessionEnd({ reason: "stream_error" });
            await sessionLog.flush();
            if (runId !== activeRunId || epochAtEntry !== speechKitEpoch) {
              return;
            }
            services.diagnosticRouter?.setActiveWriter?.(null);
            activeRunId = null;
            session?.close();
            session = null;
            resetCustomerOrders();
            resetDetectionState();
            emitState();
            sendJson(websocket, { type: "error", message: error?.message || "STT-поток оборвался" });
          };

          const scheduleErrorReconnect = (error) => {
            errorReconnectAttempts += 1;
            const attempt = errorReconnectAttempts;
            const delayMs = ERROR_RECONNECT_DELAYS_MS[
              Math.min(attempt - 1, ERROR_RECONNECT_DELAYS_MS.length - 1)
            ];
            sendJson(websocket, {
              type: "warning",
              message: `Распознавание оборвалось, переподключаюсь (попытка ${attempt} из ${ERROR_RECONNECT_MAX})…`,
            });
            setTimeout(() => {
              if (runId !== activeRunId) {
                return;
              }
              try {
                session = openSpeechKitSession(runId, makeHandlers);
                logger.info("speechkit", "stream_reconnected_after_error", { connectionId, attempt });
                sendJson(websocket, { type: "info", message: "STT-поток перезапущен" });
              } catch (reopenError) {
                logger.error("speechkit", "stream_error_reconnect_failed", { connectionId, attempt, error: reopenError });
                if (errorReconnectAttempts < ERROR_RECONNECT_MAX) {
                  scheduleErrorReconnect(error);
                  return;
                }
                void teardownAfterStreamFailure(error).catch((teardownError) => {
                  logger.error("speechkit", "stream_error_teardown_failed", { connectionId, error: teardownError });
                });
              }
            }, delayMs);
          };

          const makeHandlers = (epoch) => ({
            onPartial: ({ text, latencyMs }) => {
              if (runId !== activeRunId) {
                return;
              }

              errorReconnectAttempts = 0;
              // Партиалы теперь попадают в JSONL. SpeechKit шлёт их и когда
              // текст не изменился, поэтому повтор того же текста отбрасываем:
              // без этого лента раздувается, ничего не добавляя.
              if (text !== lastPartialText) {
                lastPartialText = text;
                partialSeq += 1;
                sessionLog.logTranscriptPartial({ text, latencyMs, seq: partialSeq });
              }
              sendJson(websocket, { type: "partial", text, latencyMs });
            },
            onFinal: ({ text, latencyMs, confidence = null }) => {
              if (runId !== activeRunId) {
                return;
              }

              errorReconnectAttempts = 0;
              // Реплика закончилась — нумерация партиалов начинается заново.
              lastPartialText = null;
              partialSeq = 0;
              logger.info("speechkit", "final_transcript", { connectionId, text, latencyMs, confidence });
              sessionLog.logTranscriptFinal({ text, latencyMs, confidence });
              sendJson(websocket, { type: "final", text, latencyMs });

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

              // Голосовая команда «<Имя Фамилия> добавь N штук <код>».
              // Тот же контракт, что у отмены: только подсветка строки и
              // предложение применить — НЕ создаём позицию в МойСкладе из
              // речи. Оператор подтверждает кнопкой на UI.
              const quantityCommand = parseQuantityCommand(text);
              if (quantityCommand.matched) {
                handleVoiceQuantityCommand(quantityCommand, text);
                return;
              }

              // rememberFinal — ПОСЛЕ early-return команд отмены/количества.
              // Фраза «отмена брони код 03204» содержит триггер «код»; попав
              // в окно триггеров, она склеивалась со СЛЕДУЮЩИМ финалом в
              // buildDetectionInputs и могла заново открыть лот 03204 — тот
              // самый, бронь которого оператор только что отменял.
              voicePipeline.rememberFinal(text);

              const priceResult = detectPrice(text);
              const discountResult = detectDiscount(text, config.discount.triggers);
              // Входы детекции собираем СРАЗУ (окно триггеров — функция
              // времени произнесения), а обрабатываем — строго по очереди.
              const detectionInputs = voicePipeline.buildDetectionInputs(text);

              // Сериализация финалов. Раньше каждый финал запускал
              // независимый async-блок: медленная детекция (YandexGPT) могла
              // завершиться ПОЗЖЕ быстрой следующей — и более старая фраза
              // открывала лот последней, «побеждая» свежую. А скидка
              // применялась к activeLot немедленно, пока открытие нового лота
              // ещё шло, — уценивался предыдущий лот. Теперь команды
              // применяются в порядке произнесения, и скидка идёт ПОСЛЕ
              // детекции артикула: фраза «артикул 03204 скидка 10%» сначала
              // открывает лот, затем уценивает его, а скидка отдельной фразой
              // ждёт завершения открытия лота из предыдущей.
              finalProcessingChain = finalProcessingChain.then(async () => {
                if (runId !== activeRunId) {
                  return;
                }
                let detection = null;

                for (const input of detectionInputs) {
                  // Границы длины артикула берём из самого каталога, а не из
                  // .env: там 1..10, тогда как в каталоге 2407 товаров с
                  // кодами от 2 до 6 знаков. Константы остаются фоллбэком на
                  // случай, когда каталога нет ни в памяти, ни на диске.
                  const codeBounds = productCodeCache?.getCodeLengthBounds?.() || null;
                  const candidateDetection = await detectArticle(input, {
                    ...detectionConfig,
                    ...(codeBounds ? { minLength: codeBounds.min, maxLength: codeBounds.max } : {}),
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
                } else if (detectionWithId.status === "ambiguous") {
                  // Ветка стоит ВЫШЕ priceResult намеренно. Раньше цена из
                  // неоднозначного транскрипта успевала уехать на предыдущий
                  // лот: «стальные покороче артикул ноль три сто двадцать
                  // четыре» — код спорный, а цена уже применена к чужому лоту.
                  // Теперь цена и скидка из этой фразы кладутся в карантин и
                  // привязываются к тому лоту, который создаст подтверждение.
                  registerAmbiguousDetection(detectionWithId, { priceResult, discountResult });
                } else if (priceResult) {
                  await applyVoicePrice(priceResult, text);
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

                // Скидка из неоднозначного транскрипта тоже в карантине —
                // она уже лежит в pendingAmbiguity и ждёт подтверждения кода.
                if (discountResult && detectionWithId.status !== "ambiguous") {
                  // detectDiscount возвращает { kind, value }. Полный
                  // дескриптор нужен, чтобы процентная скидка масштабировалась
                  // от текущего salePrice (фикс «скидка 30 процентов → 30₽»).
                  await applyDiscount(discountResult, text).catch((error) => {
                    logger.error("discount", "apply_failed", { connectionId, text, error });
                  });
                } else {
                  // Forensic: транскрипт содержит триггер скидки, но детектор
                  // не извлёк сумму. Без этого лога мы видели бы тишину и не
                  // понимали, что оператор хотел скидку (как в случае
                  // «скидка процентов тридцать» — порядок слов ломает regex).
                  if (matchesDiscountTrigger(text, config.discount.triggers)) {
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

                if (runId !== activeRunId) {
                  return;
                }

                emitState();
              }).catch((error) => {
                logger.error("article", "article_detection_failed", {
                  connectionId,
                  text,
                  error,
                });
              });
            },
            onStatus: ({ message: statusMessage, codeType }) => {
              if (runId !== activeRunId || epoch !== speechKitEpoch) {
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
              // epoch-гард: ошибка от устаревшей (заменённой при ротации)
              // сессии не должна валить активный эфир.
              if (runId !== activeRunId || epoch !== speechKitEpoch) {
                return;
              }

              logger.error("speechkit", "stream_error", { connectionId, error });

              // Сначала пробуем пережить сбой: закрываем мёртвую сессию и
              // планируем переоткрытие. Демонтаж эфира (закрытие всех лотов
              // в VK, сброс стейта — см. teardownAfterStreamFailure) — только
              // когда попытки исчерпаны.
              if (errorReconnectAttempts < ERROR_RECONNECT_MAX) {
                // Таймер плановой ротации мог бы сработать внутри окна
                // retry и открыть параллельную сессию, которую retry затем
                // молча перезаписал бы (осиротевший gRPC-стрим). Успешный
                // openSpeechKitSession переармирует ротацию сам.
                clearProactiveReconnect();
                session?.close();
                session = null;
                scheduleErrorReconnect(error);
                return;
              }

              await teardownAfterStreamFailure(error);
            },
            onEnd: async () => {
              // On manual stop the handler clears activeRunId before close(),
              // so guard below skips reconnect for operator-initiated stops.
              // epoch-гард пропускает событие end от сессии, уже заменённой
              // проактивной ротацией (её закрытие — штатное, не повод
              // реактивно реконнектиться).
              if (runId !== activeRunId || epoch !== speechKitEpoch) {
                return;
              }

              // Yandex SpeechKit closes a streaming gRPC session after ~10 min.
              // Жёсткий лимит сработал раньше проактивной ротации (например,
              // её таймер был сдвинут) — реактивно переоткрываем, чтобы
              // оператор не перезапускал эфир вручную.
              logger.info("speechkit", "stream_ended", { connectionId, autoReconnect: true });
              session?.close();
              try {
                session = openSpeechKitSession(runId, makeHandlers);
                logger.info("speechkit", "stream_auto_reconnected", { connectionId });
                sendJson(websocket, { type: "info", message: "STT-поток перезапущен" });
              } catch (error) {
                logger.error("speechkit", "stream_auto_reconnect_failed", { connectionId, error });
                clearProactiveReconnect();
                await publishAllLotsClosed("stream_end");
                await wishlistStore?.flush?.();
                sessionLog.logSessionEnd({ reason: "stream_end" });
                await sessionLog.flush();
                // Как в onError: оператор мог перезапустить эфир за время
                // await-ов — не затираем общий стейт чужого, более свежего run.
                if (runId !== activeRunId || epoch !== speechKitEpoch) {
                  return;
                }
                services.diagnosticRouter?.setActiveWriter?.(null);
                activeRunId = null;
                session = null;
                resetCustomerOrders();
                resetDetectionState();
                emitState();
                sendJson(websocket, { type: "error", message: "STT-поток оборвался и не удалось перезапустить" });
              }
            },
          });
          session = openSpeechKitSession(runId, makeHandlers);

          resetDetectionState();
          // Строго ПОСЛЕ resetDetectionState: тот гасит таймер инструкций
          // вместе с остальным состоянием эфира, и запуск до него был бы
          // немедленно отменён.
          crossPromo.start();
          viewerInstructions.start();
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
          await commitLotPrice(activeLot, { value, source: "manual" });
          return;
        }

        // Подсказка из закрытого окна: оператор либо принимает её одним
        // кликом, либо отклоняет. Ищем строго в текущем активном лоте —
        // подсказка от прошлого лота физически недостижима, потому что
        // хранится на нём самом.
        if (payload.type === "applyVoiceSuggestion" || payload.type === "dismissVoiceSuggestion") {
          const suggestionId = String(payload.suggestionId || "");
          const list = Array.isArray(activeLot?.voiceSuggestions) ? activeLot.voiceSuggestions : [];
          const index = list.findIndex((item) => item.id === suggestionId);
          if (index === -1) {
            sendJson(websocket, { type: "warning", message: "Подсказка устарела — лот уже закрыт или изменён" });
            return;
          }
          const [suggestion] = list.splice(index, 1);
          const dismissed = payload.type === "dismissVoiceSuggestion";
          logger.info("price", dismissed ? "voice_change_suggestion_dismissed" : "voice_change_suggestion_applied", {
            connectionId,
            kind: suggestion.kind,
            value: suggestion.value,
            code: activeLot.code,
            lotSessionId: activeLot.lotSessionId,
            transcript: suggestion.transcript || null,
          });
          if (dismissed) {
            emitState();
            return;
          }
          if (suggestion.kind === "price") {
            await commitLotPrice(activeLot, {
              value: suggestion.value,
              source: "manual",
              transcript: suggestion.transcript || null,
            });
          } else {
            await applyDiscount(suggestion.descriptor, suggestion.transcript || null, { fromVoice: false });
          }
          return;
        }

        // Оператор выбрал один из спорных кодов. Сообщение привязано к
        // detectionId, а не к коду: кнопка живёт в UI и может пережить более
        // свежий транскрипт, другой лот или перезапуск эфира. Переиспользовать
        // manualCode здесь нельзя — он намеренно не привязан ни к какому
        // распознаванию, и старый клик открыл бы посторонний лот.
        if (payload.type === "confirmArticleCandidate") {
          const detectionId = String(payload.detectionId || "");
          const code = String(payload.code || "").trim();
          const held = pendingAmbiguity;
          const stale = !held
            || held.detectionId !== detectionId
            || lastDetection?.detectionId !== detectionId
            || lastDetection?.status !== "ambiguous"
            || !held.candidateCodes.includes(code);
          if (stale) {
            logger.warn("article", "article_candidate_confirm_stale", {
              connectionId,
              detectionId,
              code,
              pendingDetectionId: held?.detectionId || null,
              lastDetectionId: lastDetection?.detectionId || null,
              lastDetectionStatus: lastDetection?.status || null,
            });
            sendJson(websocket, {
              type: "warning",
              message: "Выбор устарел — распознавание уже сменилось, назовите артикул ещё раз",
            });
            return;
          }

          pendingAmbiguity = null;
          logger.info("article", "article_candidate_confirmed", {
            connectionId,
            detectionId,
            code,
            candidates: held.candidateCodes,
            transcript: held.transcript,
          });

          const confirmed = {
            ...lastDetection,
            status: "confirmed",
            chosen: { code, source: "operator_choice", fragment: held.transcript, confidence: 1 },
          };
          activeDetectionActionId = detectionId;
          await handleConfirmedDetection(confirmed, code, "operator_choice", {
            runId: activeRunId,
            enforceActiveRun: true,
            expectedDetectionId: detectionId,
            // Цена из карантина уезжает внутрь создания лота, то есть
            // привязывается к созданному lotSessionId, а не к глобальному
            // activeLot: между вызовами есть await'ы на МойСклад и VK.
            voicePrice: held.priceResult,
          });

          const confirmedLot = activeLot?.code === code
            && lastDetection?.detectionId === detectionId
            && lastDetection?.status === "confirmed"
            && lastDetection?.chosen?.code === code
            ? activeLot
            : null;
          if (held.discountResult) {
            if (confirmedLot) {
              await applyDiscount(held.discountResult, held.transcript, { fromVoice: false }).catch((error) => {
                logger.error("discount", "apply_failed", { connectionId, text: held.transcript, error });
              });
            } else {
              logger.warn("discount", "held_discount_discarded", {
                connectionId, detectionId, code, reason: "lot_not_confirmed",
              });
              sendJson(websocket, {
                type: "warning",
                message: `Скидка из фразы про ${code} отброшена — лот не открылся`,
              });
            }
          }
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
          const manualCodeResolution = resolveKnownCode(code, knownCodes);
          if (manualCodeResolution.status !== "matched") {
            logger.warn("article", "manual_code_rejected_unknown", {
              connectionId,
              code,
              candidateCodes: manualCodeResolution.candidates || [],
            });
            sendJson(websocket, {
              type: "warning",
              message: `Код ${code} не найден в каталоге МойСклад`,
            });
            return;
          }
          const resolvedCode = manualCodeResolution.code;

          const detectionId = `det-manual-${activeRunId}-${nextDetectionId++}`;
          const detection = {
            transcript: `manual:${code}`,
            matchedTrigger: false,
            status: "confirmed",
            candidates: [{
              code: resolvedCode,
              originalCode: code !== resolvedCode ? code : undefined,
              source: "manual",
              confidence: 1,
              knownCode: true,
            }],
            chosen: {
              code: resolvedCode,
              originalCode: code !== resolvedCode ? code : undefined,
              source: "manual",
              confidence: 1,
            },
            detectionId,
          };

          logger.info("article", "manual_code_submitted", {
            connectionId,
            code: resolvedCode,
            originalCode: code !== resolvedCode ? code : undefined,
            detectionId,
            activeLotCode: activeLot?.code || null,
          });
          sessionLog.logManualCodeSubmitted({
            code: resolvedCode,
            originalCode: code !== resolvedCode ? code : undefined,
            detectionId,
            activeLotCode: activeLot?.code || null,
            activeLotSessionId: activeLot?.lotSessionId || null,
          });

          // Помечаем как активную детекцию — поздний голосовой final с другим
          // кодом инвалидирует этот manual через expectedDetectionId, и
          // наоборот (см. concurrency-gate в handleConfirmedDetection).
          activeDetectionActionId = detectionId;
          await handleConfirmedDetection(detection, resolvedCode, "manual", {
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
            unregisterOpenLot(closingLot);
            await publishLotClosed(closingLot, "manual_close");
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

          const { status } = await cancelReservationEvent(lot, event, { reason: "operator_cancelled" });
          if (status === "no_position") {
            sendJson(websocket, {
              type: "warning",
              message: "Нет связанной позиции МойСклад — отмените заказ вручную",
            });
          } else if (status === "safe_mode") {
            sendJson(websocket, { type: "warning", message: "Отмена брони недоступна в safe-mode" });
          } else if (status === "failed") {
            sendJson(websocket, { type: "warning", message: "Не удалось отменить бронь — попробуйте ещё раз" });
          }
          return;
        }

        if (payload.type === "appendReservationQuantity") {
          // Подтверждение от UI на голосовую команду «<Имя> добавь N штук
          // <код>». Реальные деньги, поэтому ID-параметры берём ТОЛЬКО из
          // server-side pending action — не из клиентского payload. Клиент
          // присылает actionId, выданный в voiceQuantityMatch; всё остальное
          // (lotSessionId, viewerId, commentId, quantity) — серверное.
          // Ответ-ack для UI: оператор должен либо увидеть успех (кнопка
          // уходит), либо получить ok:false и снова кликнуть по живому токену.
          const ackFail = (message) => {
            sendJson(websocket, { type: "warning", message });
            sendJson(websocket, { type: "voiceQuantityResult", actionId: payload.actionId, ok: false });
          };

          const pending = peekPendingQuantityAction(payload.actionId);
          if (!pending) {
            ackFail("Команда устарела или уже применена — повторите голосом");
            return;
          }

          const lot = openLotsBySessionId.get(pending.lotSessionId);
          if (!lot) {
            ackFail("Лот уже закрыт");
            return;
          }

          // Количество уже валидировано в парсере (1..10), но защитимся
          // явно от nonsense: integer, в допустимом диапазоне.
          if (!Number.isInteger(pending.quantity) || pending.quantity < 1 || pending.quantity > 10) {
            ackFail("Некорректное количество");
            return;
          }
          const quantityToAdd = pending.quantity;

          const state = ensureReservationState(lot);
          const events = Array.isArray(state.events) ? state.events : [];
          const event = events.find((candidate) =>
            String(candidate.viewerId) === String(pending.viewerId)
            && (pending.commentId == null || candidate.commentId === pending.commentId)
            && (candidate.status === "reserved" || candidate.status === "reserved_appended"));
          if (!event) {
            ackFail("Бронь не найдена");
            return;
          }

          const orderId = event.customerOrder?.id;
          if (!orderId) {
            ackFail("Нет связанного заказа МойСклад — добавьте позицию вручную");
            return;
          }

          // Защита от двойного клика по «+ N шт» (UI ставит btn.disabled
          // ПОСЛЕ постановки в очередь, гонка существует). Если запрос для
          // этой брони уже выполняется — отказываем, чтобы в МойСкладе не
          // появилось ДВА одинаковых дополнения по одному жесту.
          if (event.appendInFlight) {
            logger.warn("ws", "reservation_append_already_in_flight", {
              connectionId,
              lotSessionId: lot.lotSessionId,
              viewerId: event.viewerId,
            });
            // Токен НЕ трогаем: первый запрос ещё в полёте, ack по нему придёт.
            sendJson(websocket, { type: "warning", message: "Добавление уже выполняется — подождите" });
            return;
          }

          if (isSafeMode()) {
            logger.warn("safe-mode", "reservation_append_blocked", {
              connectionId,
              lotSessionId: lot.lotSessionId,
              viewerId: event.viewerId,
            });
            ackFail("Добавление недоступно в safe-mode");
            return;
          }

          event.appendInFlight = true;
          let appendResult;
          try {
            appendResult = await moysklad.appendPositionToCustomerOrder({
              orderId,
              activeLot: lot,
              productCard: lot.product || null,
              reservation: { viewerId: event.viewerId, quantity: quantityToAdd },
              broadcastDate: formatBroadcastDate(new Date(event.createdAt || Date.now())),
            });
          } catch (error) {
            event.appendInFlight = false;
            logger.error("moysklad", "reservation_append_failed", {
              connectionId,
              lotSessionId: lot.lotSessionId,
              viewerId: event.viewerId,
              orderId,
              quantity: quantityToAdd,
              error,
            });
            // Токен оставляем живым: append не применился, оператор может
            // повторить кликом по той же кнопке (ack:false её ре-активирует).
            ackFail("Не удалось добавить позицию — попробуйте ещё раз");
            return;
          }
          event.appendInFlight = false;

          if (appendResult && appendResult.skipped === true && appendResult.safeMode === true) {
            ackFail("Добавление недоступно в safe-mode");
            return;
          }

          // Записываем доп-позицию отдельным reserved_appended событием, чтобы
          // её можно было отменить отдельно по адресному positionId.
          const appendedEvent = {
            commentId: event.commentId,
            viewerId: event.viewerId,
            viewerName: event.viewerName,
            text: `voice_append: ${quantityToAdd} шт`,
            createdAt: new Date().toISOString(),
            status: "reserved_appended",
            lotCode: lot.code,
            quantity: quantityToAdd,
            customerOrder: {
              id: orderId,
              positionId: appendResult?.positionId || null,
            },
          };
          addReservationEvent(lot, appendedEvent);
          // ОПЕРАТОР ВСЕГДА ПРАВ: это ручное, подтверждённое кнопкой действие,
          // поэтому stock-guard (который для buyer-`бронь` отклоняет
          // remainingStock < quantity) здесь НАМЕРЕННО не применяется — оператор
          // держит товар в руках и решает сам. Счётчик всё равно растим на
          // quantityToAdd, чтобы последующие АВТО-брони видели реальную
          // занятость. См. reservation-flow.md → "Stock protection". Риск
          // перепродажи в этом пути — сознательно на ответственности оператора.
          state.committedReservationCount = (state.committedReservationCount || 0) + quantityToAdd;

          // Append применился — только теперь гасим одноразовый токен.
          pendingQuantityActions.delete(payload.actionId);

          logger.info("ws", "reservation_appended_by_voice", {
            connectionId,
            lotSessionId: lot.lotSessionId,
            code: lot.code,
            viewerId: event.viewerId,
            viewerName: event.viewerName,
            orderId,
            positionId: appendResult?.positionId || null,
            quantityAdded: quantityToAdd,
          });
          sendJson(websocket, { type: "voiceQuantityResult", actionId: payload.actionId, ok: true });
          sessionLog.logReservationQuantityAppended(buildReservationDiagnosticPayload(lot, appendedEvent, {
            orderId,
            positionId: appendResult?.positionId || null,
            quantityAdded: quantityToAdd,
          }));
          logReservationFinalized(lot, appendedEvent, { appended: true, source: "voice_quantity_confirmed" });
          emitState();
          return;
        }

        if (payload.type === "reserveFromAttention") {
          // «✓ забронировать» в баннере «Брони требуют внимания». Покупатель
          // написал код, под который открытого лота нет: лот закрылся раньше в
          // этом же эфире или карточка была в другой день кампании. Обычный путь
          // тут глухой (findCommentTarget смотрит только на ОТКРЫТЫЕ лоты), и до
          // 2026-07-26 такие брони пропадали молча — за один эфир так потерялись
          // две ручки 03723 (Анна Стрелкова, Марго Краснова).
          //
          // Лота нет, поэтому нет и стокового гейта лота: цену, остаток и товар
          // берём прямо из карточки МойСклада. Позиция дописывается в тот же
          // заказ кампании, что и обычная бронь (findBroadcastCustomerOrderForCounterparty).
          // Единственная точка ответа на клик — и единственное место, где
          // пишется исход. Раньше отказы уходили в UI и НЕ писались никуда:
          // в логах эфира «не кликали» и «кликнул, но не получилось» выглядели
          // одинаково, поэтому на жалобу «не работает твоя бронь ручная»
          // ответить было нечем — по шести строкам 15.08 до сих пор неизвестно,
          // что произошло. Любой новый исход обязан идти через эту функцию.
          const ackResult = ({ ok, status, message, auditStatus, ...extra }) => {
            // Именно замыкание на pending, а не повторный peek: успешные
            // ветки тратят токен ДО ответа, и peek вернул бы null.
            const pendingForLog = pending;
            logger.info("ws", "attention_reservation_outcome", {
              connectionId,
              actionId: payload.actionId,
              runId: activeRunId,
              // В аудите исход детальнее, чем в ответе клиенту: UI различает
              // только успех и отказ, а разбор эфира — «создан заказ» и
              // «дописан в существующий».
              status: auditStatus || status,
              ok,
              code: pendingForLog?.code ?? extra.code ?? null,
              viewerId: pendingForLog?.viewerId ?? null,
              viewerName: pendingForLog?.viewerName ?? null,
              commentId: pendingForLog?.commentId ?? null,
              quantity: pendingForLog?.quantity ?? null,
              tokenAgeMs: pendingForLog?.issuedAt ? Date.now() - pendingForLog.issuedAt : null,
              orderId: extra.orderId ?? null,
              positionId: extra.positionId ?? null,
              message,
            });
            if (!ok) sendJson(websocket, { type: "warning", message });
            sendJson(websocket, {
              type: "attentionReservationResult",
              actionId: payload.actionId,
              ok,
              status,
              message,
            });
          };
          const ackFail = (message, status = "failed") => ackResult({ ok: false, status, message });

          const pending = peekPendingAttentionReservation(payload.actionId);
          if (!pending) {
            ackFail("Строка устарела — попросите покупателя повторить код", "expired");
            return;
          }

          if (attentionReservationsInFlight.has(payload.actionId)) {
            ackFail("Бронь по этой строке уже создаётся — подождите", "in_flight");
            return;
          }

          if (isSafeMode()) {
            logger.warn("safe-mode", "attention_reservation_blocked", {
              connectionId,
              code: pending.code,
              viewerId: pending.viewerId,
              commentId: pending.commentId,
            });
            ackFail("Бронь недоступна в safe-mode", "safe_mode");
            return;
          }

          if (!moysklad?.isEnabled) {
            ackFail("МойСклад не настроен — бронь не создать");
            return;
          }

          attentionReservationsInFlight.add(payload.actionId);
          try {
            // Лот под этот код мог ОТКРЫТЬСЯ, пока строка ждала в баннере (TTL
            // 30 минут): оператор обычно ровно за этим карточку и открывает —
            // чтобы продать товар из строки. Тогда бронь обязана идти ЧЕРЕЗ
            // лот. Безлотовый путь ниже не знает ни про стоковый гейт лота, ни
            // про committedReservationCount: позиция уходила в МойСклад мимо
            // учёта лота, счётчик оставался нулевым, и СЛЕДУЮЩИЙ комментарий
            // бронировал ту же единицу второй раз. Свежий остаток из карточки
            // от этого не спасал: floor=1 в getRemainingAvailableStock всегда
            // пропускает первую бронь лота. Эфир 04.08.2026, лот 03824 —
            // оператор забронировал вручную, после чего тот же товар
            // забронировал другой покупатель.
            const { lot: openLot } = findOpenLotBySpokenCode(pending.code);
            if (openLot) {
              const lotState = ensureReservationState(openLot);
              if (lotState.acceptedUserIds.has(pending.viewerId)) {
                pendingAttentionReservations.delete(payload.actionId);
                ackResult({
                  ok: true,
                  status: "already_reserved",
                  message: `${pending.code}: бронь для ${pending.viewerName || `id${pending.viewerId}`} уже есть в списке лота`,
                });
                return;
              }

              addBoundedId(lotState.acceptedUserIds, pending.viewerId);
              const lotEvent = {
                commentId: pending.commentId,
                viewerId: pending.viewerId,
                viewerName: pending.viewerName,
                text: "",
                createdAt: new Date().toISOString(),
                status: "pending_reservation",
                lotCode: openLot.code,
                quantity: pending.quantity,
                source: pending.source,
                phone: null,
              };
              addReservationEvent(openLot, lotEvent);
              logger.info("ws", "attention_reservation_routed_to_open_lot", {
                connectionId,
                code: pending.code,
                lotCode: openLot.code,
                lotSessionId: openLot.lotSessionId,
                viewerId: pending.viewerId,
                viewerName: pending.viewerName,
                commentId: pending.commentId,
                quantity: pending.quantity,
              });
              emitState();
              // Дальше — обычный денежный путь: стоковый гейт, очередь,
              // committedReservationCount, запись в МойСклад, строка с кнопкой
              // «× отменить» в дашборде и публичный ответ покупателю.
              await runReservationProcessing(openLot, lotEvent);

              const settled = {
                reserved: `${pending.code} забронирован для ${pending.viewerName || `id${pending.viewerId}`} — строка в списке лота`,
                reserved_appended: `${pending.code} добавлен в заказ ${pending.viewerName || `id${pending.viewerId}`} — строка в списке лота`,
                waitlist_pending: `${pending.code}: ${pending.viewerName || `id${pending.viewerId}`} в очереди на лот — подтвердится после текущей брони`,
                out_of_stock: `${pending.code}: остатка на лоте нет — покупатель в списке ожидания`,
              };
              if (settled[lotEvent.status]) {
                pendingAttentionReservations.delete(payload.actionId);
                ackResult({
                  ok: true,
                  status: lotEvent.status === "out_of_stock" ? "wishlist" : lotEvent.status,
                  message: settled[lotEvent.status],
                  orderId: lotEvent.customerOrder?.id || null,
                  positionId: lotEvent.customerOrder?.positionId || null,
                });
                return;
              }

              // Не удалось — токен НЕ тратим, оператор повторит кликом
              // (processReservationEvent уже откатил счётчик и acceptedUserIds).
              ackFail(
                lotEvent.status === "safe_mode_logged"
                  ? "Бронь недоступна в safe-mode"
                  : `${pending.code}: бронь не создалась (${lotEvent.status}) — проверьте МойСклад`,
                lotEvent.status === "safe_mode_logged" ? "safe_mode" : "failed",
              );
              return;
            }

            const productCard = await moysklad.getProductCardByCode(pending.code);
            if (!productCard?.id) {
              logger.warn("ws", "attention_reservation_product_not_found", {
                connectionId,
                code: pending.code,
                viewerId: pending.viewerId,
              });
              ackFail(`Товар ${pending.code} не найден в МойСкладе`, "product_not_found");
              return;
            }

            // Лота нет — значит нет и озвученной цены, подставить её неоткуда.
            // У товара с нулевой ценой в каталоге позиция ушла бы в заказ по
            // 0 ₽, и оператор увидел бы зелёный «забронирован». Таких товаров
            // в каталоге сейчас десяток (эфир 26.07), поэтому отказываем явно.
            if (!hasUsableSalePrice(productCard)) {
              logger.warn("ws", "attention_reservation_no_price", {
                connectionId,
                code: pending.code,
                viewerId: pending.viewerId,
                salePrice: productCard.salePrice ?? null,
              });
              ackFail(
                `У ${pending.code} нет цены в МойСкладе — откройте лот и назовите цену, иначе позиция уйдёт по 0 ₽`,
                "no_price",
              );
              return;
            }

            const reservation = {
              viewerId: pending.viewerId,
              viewerName: pending.viewerName,
              commentId: pending.commentId,
              quantity: pending.quantity,
            };
            // Псевдо-лот для записи в МойСклад: тот же контракт, что у
            // recover-orders-from-logs.mjs. Реальным лотом он не становится —
            // в openLotsBySessionId не попадает и карточку в VK не публикует.
            const lotLike = {
              code: pending.code,
              lotSessionId: `attention-${payload.actionId}`,
              product: {
                id: productCard.id,
                name: productCard.name || "",
                salePrice: productCard.salePrice,
                availableStock: productCard.availableStock,
              },
              discountAmount: 0,
            };

            // «Если не хватило, то не хватило» — в вишлист, а не в отрицательный
            // остаток. Неизвестный остаток (null) не блокирует: оператор видит
            // товар в руках, решение за ним (та же политика, что у голосового
            // «+N шт»).
            const stock = productCard.availableStock;
            if (typeof stock === "number" && Number.isFinite(stock) && stock < pending.quantity) {
              const entry = await addWishlistFromComment(lotLike, {
                viewerId: pending.viewerId,
                viewerName: pending.viewerName,
                commentId: pending.commentId,
                quantity: pending.quantity,
              }, "attention_out_of_stock");
              logger.info("ws", "attention_reservation_out_of_stock", {
                connectionId,
                code: pending.code,
                viewerId: pending.viewerId,
                viewerName: pending.viewerName,
                availableStock: stock,
                wishlistEntryId: entry?.id || null,
              });
              sessionLog.logReservationOutOfStock({
                viewerName: pending.viewerName,
                viewerId: pending.viewerId,
                lotCode: pending.code,
              });
              pendingAttentionReservations.delete(payload.actionId);
              // Без имени зрителя wishlistStore запись не создаёт — не выдаём это
              // за успех, иначе покупатель тихо потеряется во второй раз.
              ackResult({
                ok: Boolean(entry),
                status: entry ? "wishlist" : "wishlist_failed",
                message: entry
                  ? `${pending.code}: товара нет в наличии — покупатель в списке ожидания`
                  : `${pending.code}: товара нет, но в список ожидания не попал — добавьте вручную`,
              });
              return;
            }

            const counterparty = await moysklad.ensureCounterparty({
              viewerId: pending.viewerId,
              viewerName: pending.viewerName,
            });

            // Без контрагента отказываем закрыто. createCustomerOrderReservation
            // разрешил бы его сам, но тогда недоступны и поиск заказа кампании,
            // и проверка на дубль — то есть каждый повтор писал бы новый заказ.
            if (!counterparty?.id) {
              logger.warn("ws", "attention_reservation_no_counterparty", {
                connectionId,
                code: pending.code,
                viewerId: pending.viewerId,
              });
              ackFail("Не удалось определить контрагента в МойСкладе — повторите", "no_counterparty");
              return;
            }

            const broadcastDate = new Date();
            const customerOrderKey = buildCustomerOrderCacheKey(pending.viewerId, broadcastDate);

            // Сначала кеш этой сессии — как на обычном пути брони. Иначе заказ,
            // созданный секунду назад, ещё не виден поиску по маркеру #Эфир, и
            // клик создаёт покупателю ВТОРОЙ заказ.
            let existingOrder = customerOrdersByViewerId.get(customerOrderKey) || null;
            if (existingOrder?.id) {
              try {
                const appendable = await moysklad.isCustomerOrderAppendable(existingOrder.id, {
                  source: "attention_reservation",
                });
                if (!appendable) {
                  customerOrdersByViewerId.delete(customerOrderKey);
                  existingOrder = null;
                }
              } catch (recheckError) {
                logger.warn("ws", "attention_reservation_cached_order_recheck_failed", {
                  connectionId,
                  viewerId: pending.viewerId,
                  orderId: existingOrder.id,
                  error: recheckError,
                });
                customerOrdersByViewerId.delete(customerOrderKey);
                existingOrder = null;
              }
            }

            if (!existingOrder?.id) {
              existingOrder = await moysklad.findBroadcastCustomerOrderForCounterparty(
                counterparty.id,
                { broadcastDate, source: "attention_reservation" },
              );
            }

            // Идемпотентность: оператор мог уже добить позицию руками или
            // кликнуть дважды. Проверяем ИМЕННО тот заказ, куда собираемся
            // писать: hasPositionForProduct смотрит последний незакрытый заказ
            // контрагента — без маркера #Эфир и без окна кампании, и посторонний
            // ручной заказ с тем же товаром выглядел бы как «уже забронировано».
            if (existingOrder?.id) {
              const already = await moysklad.hasPositionInOrder(existingOrder.id, productCard.id, {
                source: "attention_reservation",
              });
              if (already?.present) {
                pendingAttentionReservations.delete(payload.actionId);
                ackResult({
                  ok: true,
                  status: "already_reserved",
                  message: `${pending.code} уже есть в заказе ${existingOrder.name || existingOrder.id} — повторно не добавляю`,
                  orderId: existingOrder.id,
                });
                return;
              }
            }

            const writeResult = existingOrder?.id
              ? await moysklad.appendPositionToCustomerOrder({
                orderId: existingOrder.id,
                activeLot: lotLike,
                productCard,
                reservation,
                broadcastDate,
              })
              : await moysklad.createCustomerOrderReservation({
                activeLot: lotLike,
                productCard,
                reservation,
                counterparty,
                broadcastDate,
              });

            // safe-mode мог переключиться в полёте — обёртка возвращает маркер.
            if (writeResult?.skipped === true && writeResult?.safeMode === true) {
              ackFail("Бронь недоступна в safe-mode", "safe_mode");
              return;
            }

            const orderId = existingOrder?.id || writeResult?.id || null;
            if (!orderId) {
              ackFail("МойСклад не подтвердил создание заказа — повторите");
              return;
            }

            // Кладём заказ в кеш сессии, как это делает обычный путь брони:
            // следующая бронь этого покупателя должна дописаться СЮДА, а не
            // создать ещё один заказ.
            customerOrdersByViewerId.set(customerOrderKey, {
              id: orderId,
              name: existingOrder?.name || writeResult?.name || null,
              counterpartyId: counterparty.id,
            });

            pendingAttentionReservations.delete(payload.actionId);

            logger.info("ws", "attention_reservation_created", {
              connectionId,
              code: pending.code,
              productId: productCard.id,
              productName: productCard.name || null,
              viewerId: pending.viewerId,
              viewerName: pending.viewerName,
              commentId: pending.commentId,
              orderId,
              positionId: writeResult?.positionId || null,
              appended: Boolean(existingOrder?.id),
              quantity: pending.quantity,
              source: pending.source,
            });
            sessionLog.logOrderCreated({
              viewerName: pending.viewerName,
              viewerId: pending.viewerId,
              orderId,
              lotCode: pending.code,
              appended: Boolean(existingOrder?.id),
            });
            // Номер заказа в ответе — не украшение: у этой брони нет строки в
            // списке лота, поэтому отменить её кнопкой нельзя, и единственный
            // способ откатить ошибочный клик — открыть заказ в МойСкладе.
            ackResult({
              ok: true,
              status: "reserved",
              auditStatus: existingOrder?.id ? "reserved_appended" : "reserved",
              message: `${pending.code} забронирован для ${pending.viewerName || `id${pending.viewerId}`}`
                + ` — заказ ${existingOrder?.name || writeResult?.name || orderId}`,
              orderId,
              positionId: writeResult?.positionId || null,
            });
          } catch (error) {
            logger.error("ws", "attention_reservation_failed", {
              connectionId,
              code: pending.code,
              viewerId: pending.viewerId,
              commentId: pending.commentId,
              error,
            });
            ackFail("Не удалось создать бронь — попробуйте ещё раз");
          } finally {
            attentionReservationsInFlight.delete(payload.actionId);
          }
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
          clearProactiveReconnect();
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
      clearProactiveReconnect();
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
