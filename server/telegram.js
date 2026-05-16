import crypto from "node:crypto";
import { logger } from "./logger.js";

function createToken() {
  return crypto.randomBytes(16).toString("hex");
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildTelegramApiUrl(botToken, method) {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

function formatPrice(price) {
  if (typeof price !== "number") {
    return "-";
  }

  return `${new Intl.NumberFormat("ru-RU").format(price)} ₽`;
}

function formatStock(value, fallback = "-") {
  return typeof value === "number" ? String(value) : fallback;
}

function buildArticleCardText({ code, lotSessionId, transcript, productCard }) {
  const lines = ["Новый активный лот"];

  if (productCard?.name) {
    lines.push(`Товар: ${productCard.name}`);
  }

  lines.push(`Код: ${code}`);

  if (productCard) {
    lines.push(`Цена: ${formatPrice(productCard.salePrice)}`);
    lines.push(`Доступно: ${formatStock(productCard.availableStock)} шт`);

    if (productCard.pathName) {
      lines.push(`Категория: ${productCard.pathName}`);
    }
  }

  lines.push(`lotSessionId: ${lotSessionId}`);

  if (transcript) {
    lines.push(`Фраза: ${transcript}`);
  }

  return lines.join("\n");
}

export function createTelegramNotifier(config) {
  const chatIds = config?.chatIds?.length ? config.chatIds : [config?.primaryChatId].filter(Boolean);
  const primaryChatId = config?.primaryChatId || chatIds[0] || "";
  const isEnabled = Boolean(config?.botToken && primaryChatId);
  const pendingConfirmations = new Map();
  let lastUpdateId = 0;
  let pollingStarted = false;
  let pollingActive = false;
  let discountHandler = null;

  function pruneExpiredConfirmations() {
    const now = Date.now();

    for (const [token, pending] of pendingConfirmations.entries()) {
      if (now > pending.expiresAt) {
        pendingConfirmations.delete(token);
      }
    }
  }

  async function callTelegram(method, payload, options = {}) {
    const headers = options.headers || (options.body ? undefined : {
      "Content-Type": "application/json",
    });

    const response = await fetch(buildTelegramApiUrl(config.botToken, method), {
      method: "POST",
      headers,
      body: options.body || JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Telegram HTTP ${response.status}`);
    }

    const responsePayload = await response.json();
    if (!responsePayload?.ok) {
      throw new Error(responsePayload?.description || "Telegram API returned not ok");
    }

    return responsePayload;
  }

  async function answerCallbackQuery(callbackQueryId, text) {
    if (!isEnabled) {
      return;
    }

    try {
      await callTelegram("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
      });
    } catch (error) {
      logger.warn("telegram", "callback_answer_failed", {
        callbackQueryId,
        error,
      });
    }
  }

  async function editMessageText(chatId, messageId, text) {
    if (!isEnabled) {
      return;
    }

    try {
      await callTelegram("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
      });
    } catch (error) {
      logger.warn("telegram", "message_edit_failed", {
        chatId,
        messageId,
        error,
      });
    }
  }

  async function handleCallbackQuery(callbackQuery) {
    const data = callbackQuery?.data || "";
    const match = /^article-confirm:([^:]+):(.+)$/.exec(data);
    if (!match) {
      await answerCallbackQuery(callbackQuery.id, "Неизвестное действие");
      return;
    }

    const [, token, selectedCode] = match;
    const pending = pendingConfirmations.get(token);
    if (!pending) {
      await answerCallbackQuery(callbackQuery.id, "Подтверждение устарело");
      return;
    }

    if (Date.now() > pending.expiresAt) {
      pendingConfirmations.delete(token);
      await answerCallbackQuery(callbackQuery.id, "Подтверждение истекло");
      return;
    }

    pendingConfirmations.delete(token);

    try {
      await pending.onConfirm(selectedCode, pending);
      await answerCallbackQuery(callbackQuery.id, `Подтвержден код ${selectedCode}`);
      await editMessageText(
        callbackQuery.message?.chat?.id || pending.chatId,
        pending.messageId,
        `Подтвержден код товара ${selectedCode}\nФраза: ${pending.transcript}`,
      );
      logger.info("telegram", "ambiguity_confirmed", {
        token,
        selectedCode,
        messageId: pending.messageId,
      });
    } catch (error) {
      await answerCallbackQuery(callbackQuery.id, "Ошибка подтверждения");
      logger.error("telegram", "ambiguity_confirm_failed", {
        token,
        selectedCode,
        error,
      });
    }
  }

  async function handleTextMessage(message) {
    const text = (message?.text || "").trim();
    const match = /^\/скидка\s+(\d+)/i.exec(text);
    if (!match || !discountHandler) {
      return;
    }

    const senderChatId = String(message.chat?.id || "");
    if (!chatIds.includes(senderChatId)) {
      logger.warn("telegram", "discount_command_unauthorized", { senderChatId });
      return;
    }

    const amount = parseInt(match[1], 10);
    if (amount > 0) {
      try {
        await discountHandler(amount);
      } catch (error) {
        logger.warn("telegram", "discount_command_failed", { amount, error });
      }
    }
  }

  async function pollUpdatesLoop() {
    if (!isEnabled || pollingActive) {
      return;
    }

    pollingActive = true;

    while (pollingStarted) {
      try {
        pruneExpiredConfirmations();

        const payload = await callTelegram("getUpdates", {
          offset: lastUpdateId + 1,
          timeout: config.pollingTimeoutSec,
          allowed_updates: ["callback_query", "message"],
        });

        for (const update of payload.result || []) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
          }
          if (update.message?.text) {
            await handleTextMessage(update.message);
          }
        }
      } catch (error) {
        logger.warn("telegram", "polling_failed", { error });
        await delay(1500);
      }
    }

    pollingActive = false;
  }

  function ensurePollingStarted() {
    if (!isEnabled || pollingStarted) {
      return;
    }

    pollingStarted = true;
    void pollUpdatesLoop();
    logger.info("telegram", "polling_started", {
      timeoutSec: config.pollingTimeoutSec,
    });
  }

  async function sendMessage(text, meta = {}) {
    if (!isEnabled) {
      logger.info("telegram", "send_skipped_not_configured", meta);
      return { ok: false, skipped: true };
    }

    let lastError = null;

    let firstMessageId = null;
    const failedChatIds = [];

    for (const chatId of chatIds) {
      let delivered = false;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const payload = await callTelegram("sendMessage", {
            chat_id: chatId,
            text,
          });

          if (firstMessageId === null) {
            firstMessageId = payload.result?.message_id ?? null;
          }

          logger.info("telegram", "message_sent", {
            ...meta,
            attempt,
            chatId,
            messageId: payload.result?.message_id,
          });

          delivered = true;
          break;
        } catch (error) {
          lastError = error;
          logger.warn("telegram", "message_send_failed", {
            ...meta,
            attempt,
            chatId,
            error,
          });

          if (attempt < 3) {
            await delay(400 * attempt);
          }
        }
      }

      if (!delivered) {
        failedChatIds.push(chatId);
      }
    }

    if (firstMessageId !== null) {
      if (failedChatIds.length > 0) {
        logger.warn("telegram", "message_partial_delivery", {
          ...meta,
          failedChatIds,
        });
      }

      return {
        ok: true,
        skipped: false,
        messageId: firstMessageId,
        failedChatIds,
      };
    }

    throw lastError;
  }

  async function sendPhoto({ caption, photo, meta = {} }) {
    if (!isEnabled) {
      logger.info("telegram", "send_skipped_not_configured", meta);
      return { ok: false, skipped: true };
    }

    let lastError = null;
    let firstMessageId = null;
    const failedChatIds = [];

    for (const chatId of chatIds) {
      let delivered = false;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const formData = new FormData();
          formData.set("chat_id", chatId);
          formData.set("caption", caption);
          formData.set("photo", new Blob([photo.buffer], { type: photo.contentType }), photo.filename);

          const payload = await callTelegram("sendPhoto", null, {
            body: formData,
          });

          if (firstMessageId === null) {
            firstMessageId = payload.result?.message_id ?? null;
          }

          logger.info("telegram", "photo_sent", {
            ...meta,
            attempt,
            chatId,
            messageId: payload.result?.message_id,
          });

          delivered = true;
          break;
        } catch (error) {
          lastError = error;
          logger.warn("telegram", "photo_send_failed", {
            ...meta,
            attempt,
            chatId,
            error,
          });

          if (attempt < 3) {
            await delay(400 * attempt);
          }
        }
      }

      if (!delivered) {
        failedChatIds.push(chatId);
      }
    }

    if (firstMessageId !== null) {
      if (failedChatIds.length > 0) {
        logger.warn("telegram", "photo_partial_delivery", {
          ...meta,
          failedChatIds,
        });
      }

      return {
        ok: true,
        skipped: false,
        messageId: firstMessageId,
        failedChatIds,
      };
    }

    throw lastError;
  }

  async function sendDocument({ filename, buffer, contentType = "application/octet-stream", caption = "", meta = {} }) {
    if (!isEnabled) {
      logger.info("telegram", "send_skipped_not_configured", { ...meta, kind: "document" });
      return { ok: false, skipped: true };
    }

    let lastError = null;
    let firstMessageId = null;
    const failedChatIds = [];

    for (const chatId of chatIds) {
      let delivered = false;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const formData = new FormData();
          formData.set("chat_id", chatId);
          if (caption) {
            formData.set("caption", caption);
          }
          formData.set("document", new Blob([buffer], { type: contentType }), filename);

          const payload = await callTelegram("sendDocument", null, { body: formData });

          if (firstMessageId === null) {
            firstMessageId = payload.result?.message_id ?? null;
          }

          logger.info("telegram", "document_sent", {
            ...meta,
            attempt,
            chatId,
            filename,
            size: buffer.length,
            messageId: payload.result?.message_id,
          });

          delivered = true;
          break;
        } catch (error) {
          lastError = error;
          logger.warn("telegram", "document_send_failed", {
            ...meta,
            attempt,
            chatId,
            filename,
            error,
          });

          if (attempt < 3) {
            await delay(400 * attempt);
          }
        }
      }

      if (!delivered) {
        failedChatIds.push(chatId);
      }
    }

    if (firstMessageId !== null) {
      return { ok: true, skipped: false, messageId: firstMessageId, failedChatIds };
    }

    throw lastError;
  }

  return {
    isEnabled,
    sendDocument,
    async sendArticleDetected({ code, lotSessionId, transcript, productCard }) {
      ensurePollingStarted();
      const text = buildArticleCardText({ code, lotSessionId, transcript, productCard });

      if (productCard?.photo?.buffer) {
        return sendPhoto({
          caption: text,
          photo: productCard.photo,
          meta: {
            kind: "article_detected",
            code,
            lotSessionId,
          },
        });
      }

      return sendMessage(text, {
        kind: "article_detected",
        code,
        lotSessionId,
      });
    },
    async sendAmbiguousArticle({ transcript, candidates, onConfirm }) {
      ensurePollingStarted();

      if (!isEnabled) {
        logger.info("telegram", "send_skipped_not_configured", {
          kind: "article_ambiguous",
          transcript,
          candidates,
        });
        return { ok: false, skipped: true };
      }

      const token = createToken();
      pruneExpiredConfirmations();
      const topCandidates = candidates.slice(0, 3);
      const text = [
        "Неоднозначный код товара",
        `Фраза: ${transcript}`,
        `Кандидаты: ${topCandidates.map((candidate) => candidate.code).join(", ")}`,
        "Выберите правильный код:",
      ].join("\n");

      const payload = await callTelegram("sendMessage", {
        chat_id: primaryChatId,
        text,
        reply_markup: {
          inline_keyboard: [
            topCandidates.map((candidate) => ({
              text: candidate.code,
              callback_data: `article-confirm:${token}:${candidate.code}`,
            })),
          ],
        },
      });

      pendingConfirmations.set(token, {
        token,
        transcript,
        candidates: topCandidates,
        onConfirm,
        chatId: primaryChatId,
        messageId: payload.result?.message_id ?? null,
        expiresAt: Date.now() + config.confirmationTtlMs,
      });

      logger.info("telegram", "ambiguity_sent", {
        token,
        messageId: payload.result?.message_id,
        transcript,
        candidates: topCandidates.map((candidate) => candidate.code),
      });

      return {
        ok: true,
        skipped: false,
        token,
        messageId: payload.result?.message_id ?? null,
      };
    },
    setDiscountHandler(fn) {
      discountHandler = fn;
    },
    async sendDiscountApplied({ discountAmount, originalPrice, newPrice, code, lotSessionId }) {
      const text = [
        `Скидка применена: −${formatPrice(discountAmount)}`,
        `Новая цена: ${formatPrice(newPrice)}`,
        `Исходная цена: ${formatPrice(originalPrice)}`,
        `Код товара: ${code}`,
        `lotSessionId: ${lotSessionId}`,
      ].join("\n");

      return sendMessage(text, {
        kind: "discount_applied",
        code,
        lotSessionId,
        discountAmount,
      });
    },
  };
}
