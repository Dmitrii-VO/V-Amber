import { logger } from "./logger.js";

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeVkOwnerId(value) {
  const normalized = String(value || "").trim();
  return /^-?\d+$/.test(normalized) && normalized !== "0" ? normalized : "";
}

function normalizeVkVideoId(value) {
  const normalized = String(value || "").trim();
  return /^\d+$/.test(normalized) && normalized !== "0" ? normalized : "";
}

function parseLiveVideoReference(value) {
  if (!value) {
    return { ownerId: "", videoId: "", source: "" };
  }

  const input = String(value).trim();
  const directMatch = /video(-?\d+)_(\d+)/.exec(input);
  if (directMatch) {
    const ownerId = normalizeVkOwnerId(directMatch[1]);
    const videoId = normalizeVkVideoId(directMatch[2]);
    return {
      ownerId,
      videoId,
      source: input,
    };
  }

  return { ownerId: "", videoId: "", source: input };
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

function getLotPrice(activeLot) {
  const salePrice = activeLot?.product?.salePrice;
  if (typeof salePrice === "number" && Number.isFinite(salePrice) && salePrice > 0) {
    return salePrice;
  }

  const voicePrice = activeLot?.product?.voicePrice;
  return typeof voicePrice === "number" && Number.isFinite(voicePrice) && voicePrice > 0
    ? voicePrice
    : salePrice;
}

function buildLotCardMessage(activeLot, placeholderImageUrl = "") {
  const product = activeLot?.product;
  const discountAmount = activeLot?.discountAmount || 0;
  const lines = [];

  if (product?.name) {
    lines.push(product.name);
  }

  lines.push(`Код товара: ${activeLot.code}`);

  if (product) {
    const price = getLotPrice(activeLot);
    if (discountAmount > 0) {
      const effectivePrice = price - discountAmount;
      lines.push(`Цена: ${formatPrice(effectivePrice)} (скидка −${formatPrice(discountAmount)})`);
    } else {
      lines.push(`Цена: ${formatPrice(price)}`);
    }
    lines.push(`Доступный остаток: ${formatStock(product.availableStock)} шт`);

    if (product.pathName) {
      lines.push(`Категория: ${product.pathName}`);
    }
  }

  lines.push(`lotSessionId: ${activeLot.lotSessionId}`);

  if (placeholderImageUrl && !activeLot?.product?.hasPhoto) {
    lines.push(`Фото: ${placeholderImageUrl}`);
  }

  return lines.join("\n");
}

async function parseVkResponse(response) {
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`VK HTTP ${response.status}`);
  }

  if (payload?.error) {
    const error = new Error(`VK API ${payload.error.error_code}: ${payload.error.error_msg}`);
    error.vkErrorCode = Number(payload.error.error_code);
    throw error;
  }

  return payload.response;
}

function buildPhotoAttachment(photo) {
  const accessKey = photo?.access_key ? `_${photo.access_key}` : "";
  return `photo${photo.owner_id}_${photo.id}${accessKey}`;
}

function isVkRateLimitError(error) {
  return error?.vkErrorCode === 6;
}

// Ошибки, которые не лечатся ретраем: повторный запрос даст то же самое,
// а квоту мы потратим. Бросаем сразу, выше по стеку лот может быть помечен
// «битым» и опрос/публикации для него остановлены.
//   14  — нужна капча (программно не решить);
//   15  — доступ запрещён, видео приватное или удалено;
//   100 — невалидный параметр (баг в коде, не в окружении);
//   801 — комментарии у видео закрыты оператором.
const VK_FATAL_ERROR_CODES = new Set([14, 15, 100, 801]);

function isVkFatalError(error) {
  return VK_FATAL_ERROR_CODES.has(error?.vkErrorCode);
}

export function isVkStreamFatalError(error) {
  // Условие «дальше публиковать под этим видео бесполезно»: видео скрыто/
  // удалено/без прав/комментарии закрыты — все эти кейсы одинаково ломают
  // массовое закрытие лотов на конце эфира.
  return VK_FATAL_ERROR_CODES.has(error?.vkErrorCode);
}

export function isUsableCommentPhoto(photo) {
  return Boolean(photo?.buffer && photo?.contentType && photo?.filename);
}

export function buildVideoCommentParams({ ownerId, videoId, message, attachments, replyToComment }) {
  const params = {
    owner_id: ownerId,
    video_id: videoId,
    message,
  };
  if (attachments) {
    params.attachments = attachments;
  }
  if (replyToComment) {
    params.reply_to_comment = replyToComment;
  }
  return params;
}

export function createVkPublisher(config) {
  const userToken = config?.userToken || "";
  const groupToken = config?.groupToken || "";
  const accessToken = config?.accessToken || "";
  // Этап 5: токен, под которым публикуем комментарии и грузим фото к
  // live-видео. Должен принадлежать сообществу (Amberry), иначе reply-
  // комментарии пойдут от user identity оператора. Допускаем оба имени —
  // VK_GROUP_TOKEN или VK_ACCESS_TOKEN. userToken оставляем как
  // back-compat fallback для старых конфигов.
  const commentToken = groupToken || accessToken || userToken;
  // Токен для read-методов, которые VK не принимает от имени сообщества
  // (например video.get → error_code 5 "invalid token type"). Для таких
  // вызовов нужен user-токен; commentToken оставляем fallback'ом на случай
  // конфигов без VK_USER_TOKEN.
  const readToken = userToken || commentToken;
  const apiVersion = config?.apiVersion || "5.199";
  const placeholderImageUrl = config?.placeholderImageUrl || "";
  const liveVideo = parseLiveVideoReference(config?.liveVideoUrl || config?.liveVideoRef || "");
  let liveOwnerId = normalizeVkOwnerId(config?.liveOwnerId || liveVideo.ownerId);
  let liveVideoId = normalizeVkVideoId(config?.liveVideoId || liveVideo.videoId);
  const isEnabled = Boolean(commentToken);
  const minApiIntervalMs = parsePositiveInt(config?.apiMinIntervalMs, 1100);
  const rateLimitBackoffMs = parsePositiveInt(config?.apiRateLimitBackoffMs, 1500);
  // Адаптивный backoff: при каждой ошибке 6 удваиваем «штраф» к интервалу,
  // при первом успешном ответе сбрасываем. Так после серии rate-limit'ов
  // мы автоматически замедляемся, а после восстановления — возвращаемся
  // к норме без ручной настройки.
  const MAX_BACKOFF_MULTIPLIER = 8;
  let backoffMultiplier = 1;
  let apiQueue = Promise.resolve();
  let nextApiCallAt = 0;

  function enqueueVkApiCall(method, operation) {
    const run = apiQueue.then(async () => {
      const waitMs = Math.max(0, nextApiCallAt - Date.now());
      if (waitMs > 0) {
        await delay(waitMs);
      }

      try {
        const result = await operation();
        // Успех — затухание адаптивного штрафа.
        if (backoffMultiplier > 1) {
          backoffMultiplier = 1;
          logger.info("vk", "api_rate_limit_recovered", { method });
        }
        return result;
      } catch (error) {
        if (isVkRateLimitError(error)) {
          // Внутренний ретрай убран: пусть верхний sendWithRetry решает,
          // повторять ли. Здесь только наращиваем штраф к следующему вызову,
          // чтобы не уходить в стену повторно сразу же.
          const previousMultiplier = backoffMultiplier;
          backoffMultiplier = Math.min(MAX_BACKOFF_MULTIPLIER, backoffMultiplier * 2);
          logger.warn("vk", "api_rate_limited", {
            method,
            previousMultiplier,
            nextMultiplier: backoffMultiplier,
            adaptiveDelayMs: minApiIntervalMs * backoffMultiplier,
            error,
          });
        }
        throw error;
      } finally {
        // При rate-limit прибавляем не minApiIntervalMs, а штрафованный.
        nextApiCallAt = Date.now() + minApiIntervalMs * backoffMultiplier;
      }
    });

    apiQueue = run.catch(() => {});
    return run;
  }

  async function callVkApi(method, params, token = userToken) {
    const url = new URL(`https://api.vk.com/method/${method}`);

    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    url.searchParams.set("access_token", token);
    url.searchParams.set("v", apiVersion);

    return enqueueVkApiCall(method, async () => {
      const response = await fetch(url, { method: "POST" });
      return parseVkResponse(response);
    });
  }

  async function uploadCommentPhoto(photo) {
    const groupId = String(config?.groupId || "").replace(/^-/, "");
    const uploadServer = await callVkApi("photos.getWallUploadServer", {
      group_id: groupId || undefined,
    }, commentToken);

    const formData = new FormData();
    formData.set("photo", new Blob([photo.buffer], { type: photo.contentType }), photo.filename);

    const uploadResponse = await fetch(uploadServer.upload_url, {
      method: "POST",
      body: formData,
    });

    if (!uploadResponse.ok) {
      throw new Error(`VK upload HTTP ${uploadResponse.status}`);
    }

    const uploadPayload = await uploadResponse.json();
    const savedPhoto = await callVkApi("photos.saveWallPhoto", {
      group_id: groupId || undefined,
      photo: uploadPayload.photo,
      server: String(uploadPayload.server),
      hash: uploadPayload.hash,
    }, commentToken);

    const photoItem = Array.isArray(savedPhoto) ? savedPhoto[0] : null;
    if (!photoItem?.owner_id || !photoItem?.id) {
      throw new Error("VK saved photo payload is incomplete");
    }

    return buildPhotoAttachment(photoItem);
  }

  async function fetchComments(count = 20) {
    // sort=desc → VK returns the LATEST `count` comments. With sort=asc on a
    // long livestream this would return the earliest comments forever and
    // miss every reservation. Items are re-sorted ascending on the caller
    // side via id, so behaviour downstream is unchanged.
    const response = await callVkApi("video.getComments", {
      owner_id: liveOwnerId,
      video_id: liveVideoId,
      count: Math.min(Math.max(count, 1), 100),
      extended: 1,
      sort: "desc",
    }, commentToken);

    return {
      items: response?.items || [],
      profiles: response?.profiles || [],
      groups: response?.groups || [],
      canPost: Boolean(response?.can_post),
    };
  }

  async function sendWithRetry(operation, meta) {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await operation();
        logger.info("vk", "publish_sent", {
          ...meta,
          attempt,
          commentId: response?.comment_id ?? response ?? null,
        });
        return response;
      } catch (error) {
        lastError = error;

        // Безнадёжные ошибки (капча, закрытые комментарии и т.п.) — повтор
        // не поможет, бросаем сразу. Это снижает шум в логах и экономит
        // квоту: один такой запрос больше не превращается в 3+ выстрела.
        if (isVkFatalError(error)) {
          logger.warn("vk", "publish_failed_fatal", {
            ...meta,
            attempt,
            vkErrorCode: error.vkErrorCode,
            error,
          });
          throw error;
        }

        logger.warn("vk", "publish_failed", {
          ...meta,
          attempt,
          error,
        });

        if (attempt < 3) {
          // Экспоненциальная пауза 400ms → 800ms. На rate-limit поверх
          // этого ещё сработает адаптивный backoff в enqueueVkApiCall.
          await delay(400 * attempt);
        }
      }
    }

    throw lastError;
  }

  return {
    isEnabled,
    dmEnabled: Boolean(groupToken),
    buildLotCardMessage(activeLot) {
      return buildLotCardMessage(activeLot, placeholderImageUrl);
    },
    async getLiveTarget() {
      if (!userToken) {
        return null;
      }

      return {
        ownerId: liveOwnerId || null,
        videoId: liveVideoId || null,
        source: liveVideo.source || null,
      };
    },
    async getComments(count = 20) {
      if (!isEnabled) {
        logger.info("vk", "read_skipped_not_configured", {
          kind: "comments",
          hasUserToken: Boolean(userToken),
          ownerId: liveOwnerId || null,
          videoId: liveVideoId || null,
        });
        return {
          items: [],
          profiles: [],
          groups: [],
          canPost: false,
        };
      }

      return fetchComments(count);
    },
    async publishLotCard(activeLot, productCard = null) {
      if (!isEnabled) {
        logger.info("vk", "publish_skipped_not_configured", {
          kind: "lot_card",
          code: activeLot?.code,
          lotSessionId: activeLot?.lotSessionId,
          hasUserToken: Boolean(userToken),
          ownerId: liveOwnerId || null,
          videoId: liveVideoId || null,
        });
        return { ok: false, skipped: true };
      }

      const message = buildLotCardMessage(activeLot, placeholderImageUrl);
      const meta = {
        kind: "lot_card",
        code: activeLot.code,
        lotSessionId: activeLot.lotSessionId,
        ownerId: liveOwnerId,
        videoId: liveVideoId,
      };

      return sendWithRetry(async () => {
        const attachments = isUsableCommentPhoto(productCard?.photo)
          ? await uploadCommentPhoto(productCard.photo)
          : undefined;

        return callVkApi("video.createComment", buildVideoCommentParams({
          ownerId: liveOwnerId,
          videoId: liveVideoId,
          message,
          attachments,
        }), commentToken);
      }, meta);
    },
    async publishLotClosed(activeLot) {
      if (!isEnabled || !activeLot?.lotSessionId) {
        logger.info("vk", "publish_skipped_not_configured", {
          kind: "lot_closed",
          lotSessionId: activeLot?.lotSessionId || null,
          hasUserToken: Boolean(userToken),
          ownerId: liveOwnerId || null,
          videoId: liveVideoId || null,
        });
        return { ok: false, skipped: true };
      }

      const message = [
        "Лот закрыт.",
        `Код товара: ${activeLot.code}`,
        `lotSessionId: ${activeLot.lotSessionId}`,
      ].join("\n");

      return sendWithRetry(
        () => callVkApi("video.createComment", buildVideoCommentParams({
          ownerId: liveOwnerId,
          videoId: liveVideoId,
          message,
        }), commentToken),
        {
          kind: "lot_closed",
          code: activeLot.code,
          lotSessionId: activeLot.lotSessionId,
          ownerId: liveOwnerId,
          videoId: liveVideoId,
        },
      );
    },
    async publishReservationReply({ commentId, message, lotSessionId, code, viewerId, status }) {
      if (!isEnabled || !commentId || !message) {
        logger.info("vk", "publish_skipped_not_configured", {
          kind: "reservation_reply",
          commentId: commentId || null,
          lotSessionId: lotSessionId || null,
          code: code || null,
          viewerId: viewerId || null,
          status: status || null,
          hasUserToken: Boolean(userToken),
          ownerId: liveOwnerId || null,
          videoId: liveVideoId || null,
        });
        return { ok: false, skipped: true };
      }

      return sendWithRetry(
        () => callVkApi("video.createComment", buildVideoCommentParams({
          ownerId: liveOwnerId,
          videoId: liveVideoId,
          message,
          replyToComment: commentId,
        }), commentToken),
        {
          kind: "reservation_reply",
          commentId,
          lotSessionId,
          code,
          viewerId,
          status,
          ownerId: liveOwnerId,
          videoId: liveVideoId,
        },
      );
    },
    async publishDiscountUpdate(activeLot) {
      if (!isEnabled || !activeLot?.lotSessionId) {
        logger.info("vk", "publish_skipped_not_configured", {
          kind: "discount_update",
          lotSessionId: activeLot?.lotSessionId || null,
          hasUserToken: Boolean(userToken),
          ownerId: liveOwnerId || null,
          videoId: liveVideoId || null,
        });
        return { ok: false, skipped: true };
      }

      const discountAmount = activeLot.discountAmount || 0;
      const effectivePrice = (getLotPrice(activeLot) || 0) - discountAmount;
      const message = [
        `Обновлённая цена: ${formatPrice(effectivePrice)}`,
        `Скидка: −${formatPrice(discountAmount)}`,
        `Код товара: ${activeLot.code}`,
        `lotSessionId: ${activeLot.lotSessionId}`,
      ].join("\n");

      return sendWithRetry(
        () => callVkApi("video.createComment", buildVideoCommentParams({
          ownerId: liveOwnerId,
          videoId: liveVideoId,
          message,
        }), commentToken),
        {
          kind: "discount_update",
          code: activeLot.code,
          lotSessionId: activeLot.lotSessionId,
          ownerId: liveOwnerId,
          videoId: liveVideoId,
        },
      );
    },

    async publishPriceUpdate(activeLot) {
      if (!isEnabled || !activeLot?.lotSessionId) {
        logger.info("vk", "publish_skipped_not_configured", {
          kind: "price_update",
          lotSessionId: activeLot?.lotSessionId || null,
          hasUserToken: Boolean(userToken),
          ownerId: liveOwnerId || null,
          videoId: liveVideoId || null,
        });
        return { ok: false, skipped: true };
      }

      const price = getLotPrice(activeLot);
      const message = [
        `Цена: ${formatPrice(price)}`,
        `Код товара: ${activeLot.code}`,
        `lotSessionId: ${activeLot.lotSessionId}`,
      ].join("\n");

      return sendWithRetry(
        () => callVkApi("video.createComment", buildVideoCommentParams({
          ownerId: liveOwnerId,
          videoId: liveVideoId,
          message,
        }), commentToken),
        {
          kind: "price_update",
          code: activeLot.code,
          lotSessionId: activeLot.lotSessionId,
          ownerId: liveOwnerId,
          videoId: liveVideoId,
        },
      );
    },

    async checkDmAllowed(userId) {
      if (!groupToken) {
        logger.info("vk", "dm_check_skipped_not_configured", {
          userId: userId || null,
          hasGroupToken: Boolean(groupToken),
        });
        return { allowed: false, skipped: true, reason: "no_group_token" };
      }

      const groupId = String(config?.groupId || "").replace(/^-/, "");
      const response = await callVkApi("messages.isMessagesFromGroupAllowed", {
        group_id: groupId || undefined,
        user_id: userId,
      }, groupToken);

      return { allowed: Boolean(response?.is_allowed), raw: response };
    },

    async sendDirectMessage({ userId, message, randomId }) {
      if (!groupToken || !userId || !message) {
        logger.info("vk", "dm_skipped_not_configured", {
          userId: userId || null,
          hasGroupToken: Boolean(groupToken),
          hasMessage: Boolean(message),
        });
        return { ok: false, skipped: true };
      }

      return sendWithRetry(
        () => callVkApi("messages.send", {
          user_id: userId,
          message,
          random_id: randomId || Date.now(),
        }, groupToken),
        {
          kind: "reservation_digest_dm",
          userId,
        },
      );
    },

    setLiveVideoUrl(url) {
      const parsed = parseLiveVideoReference(url || "");
      liveOwnerId = normalizeVkOwnerId(parsed.ownerId);
      liveVideoId = normalizeVkVideoId(parsed.videoId);
      logger.info("vk", "live_video_url_updated", { url, liveOwnerId, liveVideoId });
    },

    getLiveVideoUrl() {
      return liveOwnerId && liveVideoId ? `https://vk.com/video${liveOwnerId}_${liveVideoId}` : "";
    },

    async validateLiveVideoUrl(url) {
      if (!isEnabled) {
        return { ok: false, code: "no_token", message: "VK не настроен (нет VK_GROUP_TOKEN / VK_ACCESS_TOKEN / VK_USER_TOKEN)" };
      }

      const trimmed = String(url || "").trim();
      if (!trimmed) {
        return { ok: false, code: "no_url", message: "Ссылка не указана" };
      }

      const parsed = parseLiveVideoReference(trimmed);
      const ownerId = normalizeVkOwnerId(parsed.ownerId);
      const videoId = normalizeVkVideoId(parsed.videoId);
      if (!ownerId || !videoId) {
        return {
          ok: false,
          code: "bad_url",
          message: "Не удалось разобрать ссылку. Ожидаю что-то вроде https://vk.com/video-123_456",
        };
      }

      try {
        // video.get — read-метод, который VK отклоняет для community-токенов
        // (error_code 5 "invalid token type"). Поэтому валидацию делаем
        // readToken'ом (user-токен с fallback на commentToken). Публикация
        // комментариев ниже по-прежнему идёт под commentToken от имени группы.
        const response = await callVkApi("video.get", {
          owner_id: ownerId,
          videos: `${ownerId}_${videoId}`,
          extended: 1,
        }, readToken);
        const video = response?.items?.[0];
        if (!video) {
          return {
            ok: false,
            code: "not_found",
            message: "Видео не найдено или у токена нет к нему доступа",
            ownerId,
            videoId,
          };
        }
        if (video.can_comment === 0) {
          return {
            ok: false,
            code: "comments_closed",
            message: "У видео закрыты комментарии — брони не смогут прийти",
            title: video.title || "",
            ownerId,
            videoId,
          };
        }
        return {
          ok: true,
          title: video.title || "",
          ownerId,
          videoId,
          isLive: video.live_status === "started",
          liveStatus: video.live_status || null,
        };
      } catch (error) {
        const vkErrorCode = error?.vkErrorCode ?? null;
        let code = "api_error";
        let message = error?.message || String(error);
        if (vkErrorCode === 5) {
          code = "auth_failed";
          message = "VK-токен недействителен (обновите VK_TOKEN в .env и перезапустите)";
        } else if (vkErrorCode === 15) {
          code = "access_denied";
          message = "Доступ запрещён — видео приватное или скрыто";
        } else if (vkErrorCode === 100) {
          code = "not_found";
          message = "VK не распознал owner_id/video_id";
        }
        return { ok: false, code, message, vkErrorCode, ownerId, videoId };
      }
    },
  };
}

export function resolveVkConfig(env) {
  const liveVideo = parseLiveVideoReference(env.VK_LIVE_VIDEO_URL?.trim() || "");

  return {
    userToken: env.VK_USER_TOKEN?.trim() || "",
    groupToken: env.VK_GROUP_TOKEN?.trim() || "",
    accessToken: env.VK_ACCESS_TOKEN?.trim() || "",
    groupId: env.VK_GROUP_ID?.trim() || "",
    apiVersion: env.VK_API_VERSION?.trim() || "5.199",
    apiMinIntervalMs: env.VK_API_MIN_INTERVAL_MS?.trim() || "1100",
    apiRateLimitBackoffMs: env.VK_API_RATE_LIMIT_BACKOFF_MS?.trim() || "1500",
    placeholderImageUrl: env.LOT_DEFAULT_PLACEHOLDER_IMAGE_URL?.trim() || "",
    liveVideoUrl: env.VK_LIVE_VIDEO_URL?.trim() || "",
    liveOwnerId: env.VK_LIVE_OWNER_ID?.trim() || liveVideo.ownerId,
    liveVideoId: env.VK_LIVE_VIDEO_ID?.trim() || liveVideo.videoId,
  };
}
