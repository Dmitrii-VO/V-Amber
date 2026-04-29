import { WebSocketServer } from "ws";
import { logger } from "./logger.js";
import { SpeechKitStreamingSession } from "./speechkit-stream.js";
import { detectArticle, transcriptHasTrigger } from "./article-extractor.js";
import { createTelegramNotifier } from "./telegram.js";
import { createMoySkladClient } from "./moysklad.js";
import { createVkPublisher } from "./vk.js";

let nextConnectionId = 1;
let nextLotSessionId = 1;

function sendJson(socket, payload) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(payload));
  }
}

export function attachWsServer(httpServer, config) {
  const wsServer = new WebSocketServer({ noServer: true });
  const telegram = createTelegramNotifier(config.telegram);
  const moysklad = createMoySkladClient(config.moysklad);
  const vk = createVkPublisher(config.vk);
  const detectionConfig = config.articleExtraction;
  const reservationKeyword = "бронь";

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
    let session = null;
    let activeLot = null;
    let lastDetection = null;
    let triggerActiveUntil = 0;
    let triggerSessionFinals = [];
    let lastNotification = null;
    let lastAmbiguousNotification = null;
    let nextRunId = 1;
    let activeRunId = null;
    let commentPollingGeneration = 0;
    let commentPollingActive = false;
    let customerOrdersByViewerId = new Map();

    function emitState() {
      sendJson(websocket, {
        type: "state",
        activeLot,
        lastDetection,
      });
    }

    function resetDetectionState() {
      commentPollingGeneration += 1;
      commentPollingActive = false;
      activeLot = null;
      lastDetection = null;
      triggerActiveUntil = 0;
      triggerSessionFinals = [];
      lastNotification = null;
      lastAmbiguousNotification = null;
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

    async function processReservationEvent(lot, event) {
      const state = ensureReservationState(lot);

      if (state.primaryReservation) {
        event.status = "waitlist_pending";
        logger.info("vk", "reservation_waitlist_pending", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          commentId: event.commentId,
          viewerId: event.viewerId,
        });
        emitState();
        return;
      }

      state.primaryReservation = {
        commentId: event.commentId,
        viewerId: event.viewerId,
      };
      event.status = "creating_order";
      emitState();

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
          if (order?.id) {
            customerOrdersByViewerId.set(event.viewerId, order);
          }
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
      } catch (error) {
        state.primaryReservation = null;
        event.status = "order_failed";
        event.error = error instanceof Error ? error.message : String(error);
        logger.error("moysklad", "reservation_order_failed", {
          connectionId,
          lotSessionId: lot.lotSessionId,
          commentId: event.commentId,
          viewerId: event.viewerId,
          error,
        });
      }

      emitState();
    }

    function isFatalCommentReadError(error) {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("VK API 15") || message.includes("video not found");
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
            const comments = await vk.getComments(50);
            const currentLot = activeLot?.lotSessionId === lotSessionId ? activeLot : lot;
            const reservationState = ensureReservationState(currentLot);
            const profileMap = new Map((comments.profiles || []).map((profile) => [profile.id, profile]));
            const sortedItems = (comments.items || []).sort((left, right) => left.id - right.id);

            if (!initialized) {
              reservationState.lastCommentId = sortedItems.at(-1)?.id || reservationState.lastCommentId;
              initialized = true;
              consecutiveFailures = 0;

              await new Promise((resolve) => {
                setTimeout(resolve, 2000);
              });
              continue;
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
                  lotSessionId: activeLot.lotSessionId,
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

              addReservationEvent(activeLot, event);
              logger.info("vk", "reservation_detected", {
                connectionId,
                lotSessionId: currentLot.lotSessionId,
                code: currentLot.code,
                commentId: comment.id,
                viewerId,
                viewerName: event.viewerName,
              });
              emitState();
              void processReservationEvent(currentLot, event);
            }

            consecutiveFailures = 0;
          } catch (error) {
            consecutiveFailures += 1;
            logger.warn("vk", "comment_poll_failed", {
              connectionId,
              lotSessionId,
              consecutiveFailures,
              error,
            });

            if (isFatalCommentReadError(error) || consecutiveFailures >= 5) {
              logger.warn("vk", "comment_poll_stopped", {
                connectionId,
                lotSessionId,
                reason: isFatalCommentReadError(error) ? "fatal_api_error" : "too_many_failures",
              });
              break;
            }
          }

          await new Promise((resolve) => {
            setTimeout(resolve, 2000);
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

    function confirmDetectedCode(detection, selectedCode, source = "telegram_manual", productCard = null) {
      const previousLot = activeLot;

      const nextLot = {
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
        vkPublication: null,
        reservations: {
          lastCommentId: 0,
          seenCommentIds: [],
          acceptedUserIds: [],
          events: [],
        },
      };

      activeLot = nextLot;

      lastDetection = {
        ...detection,
        status: "confirmed",
        chosen: {
          code: selectedCode,
          source,
          fragment: detection.transcript,
          confidence: 1,
        },
      };

      logger.info("article", "article_detected", {
        connectionId,
        code: selectedCode,
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
      const { runId = null, enforceActiveRun = false } = options;

      if (enforceActiveRun && runId !== activeRunId) {
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

      if (enforceActiveRun && runId !== activeRunId) {
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

        if (enforceActiveRun && runId !== activeRunId) {
          return;
        }
      }

      const confirmedLot = confirmDetectedCode(detection, selectedCode, source, productCard);

      try {
        const publication = await vk.publishLotCard(confirmedLot, productCard);

        if ((!enforceActiveRun || runId === activeRunId) && activeLot?.lotSessionId === confirmedLot.lotSessionId) {
          activeLot.vkPublication = publication?.comment_id || publication
            ? {
              commentId: publication?.comment_id ?? publication,
            }
            : activeLot.vkPublication;
          emitState();
        }
      } catch (error) {
        logger.error("vk", "lot_card_publish_failed", {
          connectionId,
          code: selectedCode,
          lotSessionId: activeLot.lotSessionId,
          error,
        });
      }

      if ((!enforceActiveRun || runId === activeRunId) && activeLot?.lotSessionId === confirmedLot.lotSessionId) {
        startCommentPolling(confirmedLot);
      }

      if (shouldSendNotification(selectedCode, detection.transcript)) {
        if ((enforceActiveRun && runId !== activeRunId) || activeLot?.lotSessionId !== confirmedLot.lotSessionId) {
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

          customerOrdersByViewerId = new Map();
          activeRunId = null;
          session?.close();
          session = null;
          logger.info("ws", "stream_start_requested", {
            connectionId,
            sampleRate: payload.sampleRate,
            encoding: payload.encoding,
            deviceId: payload.deviceId,
          });
          activeRunId = runId;
          session = new SpeechKitStreamingSession(config.speechkit, {
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

                lastDetection = detection;

                if (detection.status === "confirmed" && detection.chosen) {
                  await handleConfirmedDetection(
                    detection,
                    detection.chosen.code,
                    detection.chosen.source,
                    {
                      runId,
                      enforceActiveRun: true,
                    },
                  );
                } else if (detection.status === "ambiguous") {
                  logger.warn("article", "article_ambiguous", {
                    connectionId,
                    transcript: detection.transcript,
                    candidates: detection.candidates,
                  });

                  if (shouldSendAmbiguousNotification(detection)) {
                    void telegram.sendAmbiguousArticle({
                      transcript: detection.transcript,
                      candidates: detection.candidates,
                      onConfirm: async (selectedCode) => {
                        await handleConfirmedDetection(detection, selectedCode, "telegram_manual");
                      },
                    }).catch((error) => {
                      logger.error("telegram", "ambiguity_notification_failed", {
                        connectionId,
                        transcript: detection.transcript,
                        candidates: detection.candidates,
                        error,
                      });
                    });
                  }
                } else if (detection.status === "llm_error") {
                  logger.warn("article", "article_llm_error", {
                    connectionId,
                    transcript: detection.transcript,
                    error: detection.error,
                  });
                } else if (detection.status === "awaiting_continuation") {
                  logger.info("article", "article_awaiting_continuation", {
                    connectionId,
                    transcript: detection.transcript,
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
              activeRunId = null;
              session?.close();
              session = null;
              sendJson(websocket, { type: "error", message: error.message });
            },
            onEnd: () => {
              if (runId !== activeRunId) {
                return;
              }

              logger.info("speechkit", "stream_ended", { connectionId });
              publishLotClosed(activeLot, "stream_end");
              activeRunId = null;
              session?.close();
              session = null;
              resetDetectionState();
              emitState();
            },
          }, { connectionId });

          resetDetectionState();
          emitState();
          return;
        }

        if (payload.type === "stop") {
          logger.info("ws", "stream_stop_requested", { connectionId });
          publishLotClosed(activeLot, "stream_stop");
          activeRunId = null;
          session?.close();
          session = null;
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
      activeRunId = null;
      session?.close();
      session = null;
      resetDetectionState();
    });
  });

  return wsServer;
}
