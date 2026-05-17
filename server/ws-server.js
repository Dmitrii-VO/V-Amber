import { WebSocketServer } from "ws";
import { logger } from "./logger.js";
import { createSessionLog } from "./session-log.js";
import { SpeechKitStreamingSession } from "./speechkit-stream.js";
import { detectArticle, transcriptHasTrigger } from "./article-extractor.js";
import { detectDiscount } from "./discount-detector.js";
import { createTelegramNotifier } from "./telegram.js";
import { createMoySkladClient } from "./moysklad.js";
import { createVkPublisher } from "./vk.js";
import { isSafeMode, setSafeMode, onSafeModeChange, wrapWithSafeMode } from "./safe-mode.js";

let nextConnectionId = 1;
let nextLotSessionId = 1;
let nextDetectionId = 1;

function sendJson(socket, payload) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(payload));
  }
}

function getVkPublicationCommentId(publication) {
  const rawValue = typeof publication === "number"
    ? publication
    : publication?.comment_id ?? publication?.commentId ?? null;

  if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue > 0) {
    return rawValue;
  }

  const parsed = Number.parseInt(String(rawValue || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getVkApiErrorCode(error) {
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

export function attachWsServer(httpServer, config, services = {}) {
  const wsServer = new WebSocketServer({ noServer: true });
  const telegram = wrapWithSafeMode(
    services.telegram || createTelegramNotifier(config.telegram),
    ["sendArticleDetected", "sendAmbiguousArticle", "sendDiscountApplied"],
    "telegram",
  );
  const moysklad = wrapWithSafeMode(
    createMoySkladClient(config.moysklad),
    ["createCustomerOrderReservation", "appendPositionToCustomerOrder"],
    "moysklad",
  );
  const vk = wrapWithSafeMode(
    services.vk || createVkPublisher(config.vk),
    ["publishLotCard", "publishLotClosed", "publishDiscountUpdate", "publishReservationReply"],
    "vk",
  );
  const detectionConfig = config.articleExtraction;
  const reservationKeyword = "бронь";

  let activeDiscountApplier = null;
  telegram.setDiscountHandler(async (amount) => {
    if (activeDiscountApplier) {
      await activeDiscountApplier(amount);
    }
  });

  httpServer.on("upgrade", (request, socket, head) => {
    let pathname;

    try {
      ({ pathname } = new URL(request.url, "http://localhost"));
    } catch {
      logger.warn("ws", "bad_upgrade_url", { url: request.url });
      socket.destroy();
      return;
    }

    if (pathname !== "/ws/stt") {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (websocket) => {
      wsServer.emit("connection", websocket, request);
    });
  });

  wsServer.on("connection", (websocket) => {
    const connectionId = `ws-${nextConnectionId++}`;
    const sessionLog = createSessionLog();
    let session = null;
    let activeLot = null;
    let lastDetection = null;
    let triggerActiveUntil = 0;
    let triggerSessionFinals = [];
    let lastNotification = null;
    let lastAmbiguousNotification = null;
    let nextRunId = 1;
    let activeRunId = null;
    let activeDetectionActionId = null;
    let commentPollingGeneration = 0;
    let commentPollingActive = false;
    let customerOrdersByViewerId = new Map();
    let customerOrderSessionVersion = 1;
    activeDiscountApplier = applyDiscount;

    function emitState() {
      sendJson(websocket, {
        type: "state",
        activeLot,
        lastDetection,
        safeMode: isSafeMode(),
      });
    }

    const unsubscribeSafeMode = onSafeModeChange(() => {
      emitState();
    });

    function resetDetectionState() {
      commentPollingGeneration += 1;
      commentPollingActive = false;
      activeLot = null;
      lastDetection = null;
      activeDetectionActionId = null;
      triggerActiveUntil = 0;
      triggerSessionFinals = [];
      lastNotification = null;
      lastAmbiguousNotification = null;
    }

    function resetCustomerOrders() {
      customerOrdersByViewerId = new Map();
      customerOrderSessionVersion += 1;
    }

    function normalizeReservationText(text) {
      return String(text || "").trim().toLowerCase();
    }

    function ensureReservationState(lot) {
      if (!lot) {
        return null;
      }

      if (!lot.reservations) {
        lot.reservations = {
          lastCommentId: 0,
          seenCommentIds: [],
          acceptedUserIds: [],
          events: [],
          // Persistent counter, separate from the trimmed events buffer above.
          // Without this, lots with more than 20 reservations under-report and
          // the stock guard lets extra orders through.
          committedReservationCount: 0,
        };
      }

      return lot.reservations;
    }

    function rememberSeenComment(state, commentId) {
      state.seenCommentIds.push(commentId);
      state.seenCommentIds = state.seenCommentIds.slice(-200);
    }

    function hasSeenComment(state, commentId) {
      return state.seenCommentIds.includes(commentId);
    }

    function addReservationEvent(lot, event) {
      const state = ensureReservationState(lot);
      state.events.push(event);
      state.events = state.events.slice(-20);
    }

    function getReservationReplyMessage(event) {
      if (event.status === "out_of_stock") {
        return "Товар закончился. Бронь не создана.";
      }

      if (event.status === "waitlist_pending") {
        return "Бронь принята. Вы в очереди, подтвердим следующим сообщением.";
      }

      if (event.status === "reserved") {
        return "Бронь подтверждена. Заказ создан.";
      }

      if (event.status === "reserved_appended") {
        return "Бронь подтверждена. Товар добавлен в ваш заказ.";
      }

      if (event.status === "order_failed") {
        return "Не удалось обработать бронь. Напишите \"бронь\" ещё раз.";
      }

      return "";
    }

    function getCommittedReservationCount(state) {
      return Math.max(0, state?.committedReservationCount || 0);
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

    function notifyReservationStatus(lot, event) {
      const message = getReservationReplyMessage(event);
      if (!message) {
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

    function isReservationSessionCurrent(lot, reservationSessionVersion) {
      return reservationSessionVersion === customerOrderSessionVersion
        && activeLot?.lotSessionId === lot?.lotSessionId;
    }

    async function processReservationEvent(lot, event) {
      const state = ensureReservationState(lot);
      const reservationSessionVersion = customerOrderSessionVersion;

      if (isSafeMode()) {
        event.status = "safe_mode_logged";
        logger.warn("safe-mode", "reservation_logged_only", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          code: lot.code,
          commentId: event.commentId,
          viewerId: event.viewerId,
          viewerName: event.viewerName,
        });
        emitState();
        return;
      }

      if (state.primaryReservation) {
        event.status = "waitlist_pending";
        logger.info("vk", "reservation_waitlist_pending", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          commentId: event.commentId,
          viewerId: event.viewerId,
        });
        emitState();
        notifyReservationStatus(lot, event);
        return;
      }

      const remainingStock = getRemainingAvailableStock(lot, state);
      if (remainingStock !== null && remainingStock <= 0) {
        event.status = "out_of_stock";
        logger.info("vk", "reservation_out_of_stock", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          code: lot.code,
          commentId: event.commentId,
          viewerId: event.viewerId,
          availableStock: lot.product?.availableStock ?? null,
        });
        emitState();
        notifyReservationStatus(lot, event);
        return;
      }

      state.primaryReservation = {
        commentId: event.commentId,
        viewerId: event.viewerId,
      };
      event.status = "creating_order";
      state.committedReservationCount = (state.committedReservationCount || 0) + 1;
      emitState();

      let nextWaitlistEvent = null;

      try {
        const existingOrder = customerOrdersByViewerId.get(event.viewerId) || null;
        let order = null;

        if (existingOrder?.id) {
          await moysklad.appendPositionToCustomerOrder({
            orderId: existingOrder.id,
            activeLot: lot,
            productCard: {
              salePrice: lot.product?.salePrice,
            },
            reservation: event,
          });
          order = existingOrder;
        } else {
          order = await moysklad.createCustomerOrderReservation({
            activeLot: lot,
            productCard: {
              salePrice: lot.product?.salePrice,
            },
            reservation: event,
          });
        }

        // safe-mode flipped on between the early check and the wrapped call —
        // the safe-mode wrapper returns { skipped: true, safeMode: true } and
        // nothing was actually written to MoySklad. Mark the event accordingly
        // instead of falling through to the success path.
        if (order && order.skipped === true && order.safeMode === true) {
          event.status = "safe_mode_logged";
          // No MoySklad write happened — release the slot in the counter.
          state.committedReservationCount = Math.max(0, (state.committedReservationCount || 0) - 1);
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
          customerOrdersByViewerId.set(event.viewerId, order);
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
        logger.info("vk", "reservation_order_created", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          commentId: event.commentId,
          viewerId: event.viewerId,
          orderId: order?.id || null,
          appended: Boolean(existingOrder?.id),
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
        state.acceptedUserIds = state.acceptedUserIds.filter((viewerId) => viewerId !== event.viewerId);
        // Roll back the counter increment from line ~302 so a later viewer
        // isn't blocked by this failed write.
        state.committedReservationCount = Math.max(0, (state.committedReservationCount || 0) - 1);
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

      if (nextWaitlistEvent && activeLot?.lotSessionId === lot.lotSessionId) {
        nextWaitlistEvent.status = "pending_reservation";
        void processReservationEvent(lot, nextWaitlistEvent);
      }
    }

    function isFatalCommentReadError(error) {
      // Genuinely unrecoverable for THIS video: access denied, bad params,
      // video missing. Auth errors (code 5) are LOUD but recoverable on
      // token refresh, so they no longer kill the poll loop.
      const errorCode = getVkApiErrorCode(error);
      if (errorCode !== null) {
        return [15, 100].includes(errorCode);
      }

      const message = error instanceof Error ? error.message : String(error);
      return /video not found/i.test(message);
    }

    function startCommentPolling(lot) {
      const lotSessionId = lot?.lotSessionId;
      if (!lotSessionId) {
        return;
      }

      const generation = ++commentPollingGeneration;
      commentPollingActive = true;

      void (async function pollLoop() {
        let initialized = false;
        let consecutiveFailures = 0;

        while (generation === commentPollingGeneration && activeLot?.lotSessionId === lotSessionId) {
          try {
            const comments = await vk.getComments(100);
            if (generation !== commentPollingGeneration || activeLot?.lotSessionId !== lotSessionId) {
              break;
            }

            const currentLot = activeLot;
            const reservationState = ensureReservationState(currentLot);
            const profileMap = new Map((comments.profiles || []).map((profile) => [profile.id, profile]));
            const sortedItems = (comments.items || []).sort((left, right) => left.id - right.id);

            if (!initialized) {
              initialized = true;
              consecutiveFailures = 0;

              if (reservationState.lastCommentId <= 0) {
                reservationState.lastCommentId = sortedItems.at(-1)?.id || reservationState.lastCommentId;

                await new Promise((resolve) => {
                  setTimeout(resolve, 2000);
                });
                continue;
              }
            }

            const newItems = (comments.items || [])
              .filter((item) => item.id > reservationState.lastCommentId && !hasSeenComment(reservationState, item.id))
              .sort((left, right) => left.id - right.id);

            for (const comment of newItems) {
              reservationState.lastCommentId = Math.max(reservationState.lastCommentId, comment.id);
              rememberSeenComment(reservationState, comment.id);

              if (normalizeReservationText(comment.text) !== reservationKeyword) {
                continue;
              }

              const viewerId = comment.from_id;
              if (reservationState.acceptedUserIds.includes(viewerId)) {
                logger.info("vk", "reservation_duplicate_ignored", {
                  connectionId,
                  lotSessionId: currentLot.lotSessionId,
                  commentId: comment.id,
                  viewerId,
                });
                continue;
              }

              reservationState.acceptedUserIds.push(viewerId);
              reservationState.acceptedUserIds = reservationState.acceptedUserIds.slice(-200);

              const profile = profileMap.get(viewerId);
              const event = {
                commentId: comment.id,
                viewerId,
                viewerName: profile
                  ? [profile.first_name, profile.last_name].filter(Boolean).join(" ")
                  : "",
                text: comment.text,
                createdAt: new Date(comment.date * 1000).toISOString(),
                status: "pending_reservation",
              };

              addReservationEvent(currentLot, event);
              logger.info("vk", "reservation_detected", {
                connectionId,
                lotSessionId: currentLot.lotSessionId,
                code: currentLot.code,
                commentId: comment.id,
                viewerId,
                viewerName: event.viewerName,
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
                lotSessionId,
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
              lotSessionId,
              consecutiveFailures,
              errorCode,
              error,
            });

            if (isFatalCommentReadError(error)) {
              logger.warn("vk", "comment_poll_stopped", {
                connectionId,
                lotSessionId,
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

    function publishLotClosed(lot, reason) {
      if (!lot?.lotSessionId) {
        return;
      }

      void vk.publishLotClosed(lot).catch((error) => {
        logger.error("vk", "lot_close_publish_failed", {
          connectionId,
          code: lot.code,
          lotSessionId: lot.lotSessionId,
          reason,
          error,
        });
      });
    }

    async function applyDiscount(input) {
      if (!activeLot?.vkPublication?.commentId || !activeLot.product) {
        return;
      }

      const salePrice = activeLot.product.salePrice;
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
      sessionLog.logDiscount({ amount, originalPrice, newPrice, code: activeLot.code });

      await Promise.all([
        vk.publishDiscountUpdate(activeLot).catch((error) => {
          logger.error("vk", "discount_publish_failed", {
            connectionId,
            lotSessionId: activeLot?.lotSessionId,
            error,
          });
        }),
        telegram.sendDiscountApplied({
          discountAmount: amount,
          originalPrice,
          newPrice,
          code: activeLot.code,
          lotSessionId: activeLot.lotSessionId,
        }).catch((error) => {
          logger.error("telegram", "discount_notify_failed", {
            connectionId,
            lotSessionId: activeLot?.lotSessionId,
            error,
          });
        }),
      ]);

      emitState();
    }

    function rememberFinal(text) {
      if (transcriptHasTrigger(text, detectionConfig.triggers)) {
        triggerActiveUntil = Date.now() + detectionConfig.triggerWindowMs;
        triggerSessionFinals = [{ text, ts: Date.now() }];
        return;
      }

      if (Date.now() <= triggerActiveUntil) {
        triggerSessionFinals.push({ text, ts: Date.now() });
        triggerSessionFinals = triggerSessionFinals.slice(-Math.max(1, detectionConfig.finalBufferSize));
      }
    }

    function buildDetectionInputs(text) {
      const inputs = [text];

      if (Date.now() > triggerActiveUntil || triggerSessionFinals.length === 0) {
        return inputs;
      }

      for (let size = 1; size <= triggerSessionFinals.length; size += 1) {
        inputs.unshift(triggerSessionFinals.slice(-size).map((entry) => entry.text).join(" "));
      }

      return [...new Set(inputs.filter(Boolean))];
    }

    function shouldSendNotification(code, transcript) {
      const key = `${code}|${transcript}`;
      const now = Date.now();

      if (
        lastNotification
        && lastNotification.key === key
        && now - lastNotification.sentAt < detectionConfig.notificationDedupMs
      ) {
        return false;
      }

      lastNotification = { key, sentAt: now };
      return true;
    }

    function shouldSendAmbiguousNotification(detection) {
      const key = `${detection.transcript}|${detection.candidates.map((candidate) => candidate.code).join(",")}`;
      const now = Date.now();

      if (
        lastAmbiguousNotification
        && lastAmbiguousNotification.key === key
        && now - lastAmbiguousNotification.sentAt < detectionConfig.notificationDedupMs
      ) {
        return false;
      }

      lastAmbiguousNotification = { key, sentAt: now };
      return true;
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

    function buildConfirmedLot(detection, selectedCode, source = "telegram_manual", productCard = null) {
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
          availableStock: productCard.availableStock,
          hasPhoto: Boolean(productCard.photo),
        } : null,
        discountAmount: 0,
        vkPublication: null,
        reservations: {
          lastCommentId: 0,
          seenCommentIds: [],
          acceptedUserIds: [],
          events: [],
        },
      };
    }

    function activateConfirmedLot(detection, nextLot, source = "telegram_manual") {
      activeLot = nextLot;
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

      logger.info("article", "article_detected", {
        connectionId,
        code: nextLot.code,
        lotSessionId: nextLot.lotSessionId,
        source,
        transcript: detection.transcript,
      });

      triggerActiveUntil = 0;
      triggerSessionFinals = [];
      emitState();
      return nextLot;
    }

    async function handleConfirmedDetection(detection, selectedCode, source, options = {}) {
      const { runId = null, enforceActiveRun = false, expectedDetectionId = null } = options;

      if (!isDetectionStillActive({ runId, enforceActiveRun, expectedDetectionId })) {
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

      if (!isDetectionStillActive({ runId, enforceActiveRun, expectedDetectionId })) {
        return;
      }

      const previousLot = activeLot;

      if (previousLot?.lotSessionId) {
        try {
          await vk.publishLotClosed(previousLot);
        } catch (error) {
          logger.error("vk", "lot_close_publish_failed", {
            connectionId,
            code: previousLot.code,
            lotSessionId: previousLot.lotSessionId,
            error,
          });
        }

        if (!isDetectionStillActive({ runId, enforceActiveRun, expectedDetectionId })) {
          return;
        }
      }

      const confirmedLot = buildConfirmedLot(detection, selectedCode, source, productCard);
      let publicationCommentId = null;

      try {
        const publication = await vk.publishLotCard(confirmedLot, productCard);
        publicationCommentId = getVkPublicationCommentId(publication);
      } catch (error) {
        logger.error("vk", "lot_card_publish_failed", {
          connectionId,
          code: selectedCode,
          lotSessionId: confirmedLot.lotSessionId,
          error,
        });
      }

      if (!isDetectionStillActive({ runId, enforceActiveRun, expectedDetectionId })) {
        if (publicationCommentId !== null) {
          publishLotClosed(confirmedLot, "stale_detection");
        }
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
        availableStock: productCard?.availableStock ?? null,
        transcript: confirmedLot.transcript,
        source: confirmedLot.source,
      });
      startCommentPolling(confirmedLot);

      if (shouldSendNotification(selectedCode, detection.transcript)) {
        if (
          !isDetectionStillActive({ runId, enforceActiveRun, expectedDetectionId })
          || activeLot?.lotSessionId !== confirmedLot.lotSessionId
        ) {
          return;
        }

        await telegram.sendArticleDetected({
          code: confirmedLot.code,
          lotSessionId: confirmedLot.lotSessionId,
          transcript: confirmedLot.transcript,
          source: confirmedLot.source,
          productCard,
        });
      } else {
        logger.info("telegram", "message_skipped_duplicate", {
          connectionId,
          code: selectedCode,
          transcript: detection.transcript,
        });
      }

      triggerActiveUntil = 0;
      triggerSessionFinals = [];
    }

    logger.info("ws", "client_connected", { connectionId });

    websocket.on("message", (message, isBinary) => {
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
          sessionLog.logSessionStart({ connectionId, vkLiveVideoUrl: payload.vkLiveVideoUrl || null });
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
              sendJson(websocket, { type: "final", text, latencyMs });
              rememberFinal(text);

              const discountResult = detectDiscount(text, config.discount.triggers);
              if (discountResult) {
                // detectDiscount now returns { kind, value }. Pass the full
                // descriptor so percent discounts are scaled by current
                // salePrice — fixes the "скидка 30 процентов → 30₽" bug.
                void applyDiscount(discountResult).catch((error) => {
                  logger.error("discount", "apply_failed", { connectionId, text, error });
                });
              }

              void (async () => {
                const detectionInputs = buildDetectionInputs(text);
                let detection = null;

                for (const input of detectionInputs) {
                  const candidateDetection = await detectArticle(input, detectionConfig);

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
                    },
                  );
                } else if (detectionWithId.status === "ambiguous") {
                  logger.warn("article", "article_ambiguous", {
                    connectionId,
                    transcript: detectionWithId.transcript,
                    candidates: detectionWithId.candidates,
                  });

                  if (shouldSendAmbiguousNotification(detectionWithId)) {
                    activeDetectionActionId = detectionWithId.detectionId;
                    // Drain the accumulated finals window so a follow-up
                    // trigger doesn't splice the next phrase onto this one
                    // and produce a phantom code while the operator is busy
                    // confirming in Telegram.
                    triggerSessionFinals = [];
                    void telegram.sendAmbiguousArticle({
                      transcript: detectionWithId.transcript,
                      candidates: detectionWithId.candidates,
                      onConfirm: async (selectedCode) => {
                        await handleConfirmedDetection(detectionWithId, selectedCode, "telegram_manual", {
                          runId,
                          enforceActiveRun: true,
                          expectedDetectionId: detectionWithId.detectionId,
                        });
                      },
                    }).catch((error) => {
                      logger.error("telegram", "ambiguity_notification_failed", {
                        connectionId,
                        transcript: detectionWithId.transcript,
                        candidates: detectionWithId.candidates,
                        error,
                      });
                    });
                  }
                } else if (detectionWithId.status === "llm_error") {
                  logger.warn("article", "article_llm_error", {
                    connectionId,
                    transcript: detectionWithId.transcript,
                    error: detectionWithId.error,
                  });
                } else if (detectionWithId.status === "awaiting_continuation") {
                  logger.info("article", "article_awaiting_continuation", {
                    connectionId,
                    transcript: detectionWithId.transcript,
                  });
                }

                if (runId !== activeRunId) {
                  return;
                }

                emitState();
              })().catch((error) => {
                if (activeLot?.code) {
                  logger.error("telegram", "article_notification_failed", {
                    connectionId,
                    code: activeLot.code,
                    lotSessionId: activeLot.lotSessionId,
                    error,
                  });
                }

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
            onError: (error) => {
              if (runId !== activeRunId) {
                return;
              }

              publishLotClosed(activeLot, "stream_error");
              logger.error("speechkit", "stream_error", { connectionId, error });
              sessionLog.logSessionEnd({ reason: "stream_error" });
              activeRunId = null;
              session?.close();
              session = null;
              sendJson(websocket, { type: "error", message: error.message });
            },
            onEnd: () => {
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
                session = new SpeechKitStreamingSession(config.speechkit, speechKitHandlers, { connectionId });
                logger.info("speechkit", "stream_auto_reconnected", { connectionId });
                sendJson(websocket, { type: "info", message: "STT-поток перезапущен" });
              } catch (error) {
                logger.error("speechkit", "stream_auto_reconnect_failed", { connectionId, error });
                publishLotClosed(activeLot, "stream_end");
                sessionLog.logSessionEnd({ reason: "stream_end" });
                activeRunId = null;
                session = null;
                resetCustomerOrders();
                resetDetectionState();
                emitState();
                sendJson(websocket, { type: "error", message: "STT-поток оборвался и не удалось перезапустить" });
              }
            },
          };
          session = new SpeechKitStreamingSession(config.speechkit, speechKitHandlers, { connectionId });

          resetDetectionState();
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
          publishLotClosed(activeLot, "stream_stop");
          sessionLog.logSessionEnd({ reason: "stream_stop" });
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

    websocket.on("close", () => {
      logger.info("ws", "client_disconnected", { connectionId });
      publishLotClosed(activeLot, "socket_close");
      sessionLog.logSessionEnd({ reason: "socket_close" });
      activeRunId = null;
      session?.close();
      session = null;
      resetCustomerOrders();
      resetDetectionState();
      if (activeDiscountApplier === applyDiscount) {
        activeDiscountApplier = null;
      }
      unsubscribeSafeMode();
    });
  });

  return wsServer;
}
