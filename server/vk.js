import { logger } from "./logger.js";

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseLiveVideoReference(value) {
  if (!value) {
    return { ownerId: "", videoId: "", source: "" };
  }

  const input = String(value).trim();
  const directMatch = /video(-?\d+)_(\d+)/.exec(input);
  if (directMatch) {
    return {
      ownerId: directMatch[1],
      videoId: directMatch[2],
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

function buildLotCardMessage(activeLot, placeholderImageUrl = "") {
  const product = activeLot?.product;
  const lines = [];

  if (product?.name) {
    lines.push(product.name);
  }

  lines.push(`Код товара: ${activeLot.code}`);

  if (product) {
    lines.push(`Цена: ${formatPrice(product.salePrice)}`);
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
    throw new Error(`VK API ${payload.error.error_code}: ${payload.error.error_msg}`);
  }

  return payload.response;
}

function buildPhotoAttachment(photo) {
  const accessKey = photo?.access_key ? `_${photo.access_key}` : "";
  return `photo${photo.owner_id}_${photo.id}${accessKey}`;
}

export function createVkPublisher(config) {
  const userToken = config?.userToken || "";
  const apiVersion = config?.apiVersion || "5.199";
  const placeholderImageUrl = config?.placeholderImageUrl || "";
  const liveVideo = parseLiveVideoReference(config?.liveVideoUrl || config?.liveVideoRef || "");
  const liveOwnerId = config?.liveOwnerId || liveVideo.ownerId;
  const liveVideoId = config?.liveVideoId || liveVideo.videoId;
  const isEnabled = Boolean(userToken && liveOwnerId && liveVideoId);

  async function callVkApi(method, params) {
    const url = new URL(`https://api.vk.com/method/${method}`);

    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    url.searchParams.set("access_token", userToken);
    url.searchParams.set("v", apiVersion);

    const response = await fetch(url, { method: "POST" });
    return parseVkResponse(response);
  }

  async function uploadCommentPhoto(photo) {
    const groupId = String(config?.groupId || "").replace(/^-/, "");
    const uploadServer = await callVkApi("photos.getWallUploadServer", {
      group_id: groupId || undefined,
    });

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
    });

    const photoItem = Array.isArray(savedPhoto) ? savedPhoto[0] : null;
    if (!photoItem?.owner_id || !photoItem?.id) {
      throw new Error("VK saved photo payload is incomplete");
    }

    return buildPhotoAttachment(photoItem);
  }

  async function fetchComments(count = 20) {
    const response = await callVkApi("video.getComments", {
      owner_id: liveOwnerId,
      video_id: liveVideoId,
      count,
      extended: 1,
      sort: "asc",
    });

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
        logger.warn("vk", "publish_failed", {
          ...meta,
          attempt,
          error,
        });

        if (attempt < 3) {
          await delay(400 * attempt);
        }
      }
    }

    throw lastError;
  }

  return {
    isEnabled,
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
        const attachments = productCard?.photo
          ? await uploadCommentPhoto(productCard.photo)
          : undefined;

        return callVkApi("video.createComment", {
          owner_id: liveOwnerId,
          video_id: liveVideoId,
          message,
          attachments,
        });
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
        () => callVkApi("video.createComment", {
          owner_id: liveOwnerId,
          video_id: liveVideoId,
          message,
        }),
        {
          kind: "lot_closed",
          code: activeLot.code,
          lotSessionId: activeLot.lotSessionId,
          ownerId: liveOwnerId,
          videoId: liveVideoId,
        },
      );
    },
  };
}

export function resolveVkConfig(env) {
  const liveVideo = parseLiveVideoReference(env.VK_LIVE_VIDEO_URL?.trim() || "");

  return {
    userToken: env.VK_USER_TOKEN?.trim() || "",
    accessToken: env.VK_ACCESS_TOKEN?.trim() || "",
    groupId: env.VK_GROUP_ID?.trim() || "",
    apiVersion: env.VK_API_VERSION?.trim() || "5.199",
    placeholderImageUrl: env.LOT_DEFAULT_PLACEHOLDER_IMAGE_URL?.trim() || "",
    liveVideoUrl: env.VK_LIVE_VIDEO_URL?.trim() || "",
    liveOwnerId: env.VK_LIVE_OWNER_ID?.trim() || liveVideo.ownerId,
    liveVideoId: env.VK_LIVE_VIDEO_ID?.trim() || liveVideo.videoId,
  };
}
