import { logger } from "./logger.js";

function buildBasicAuthHeader(login, password) {
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

function getAuthHeader(config) {
  if (config.login && config.password) {
    return buildBasicAuthHeader(config.login, config.password);
  }

  return "";
}

function buildApiUrl(baseUrl, path, searchParams) {
  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);

  for (const [key, value] of Object.entries(searchParams || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function normalizeMoney(value) {
  return typeof value === "number" ? value / 100 : null;
}

function toMinorUnits(value) {
  return typeof value === "number" ? Math.round(value * 100) : 0;
}

function buildEntityMeta(baseUrl, entity, id) {
  return {
    meta: {
      href: `${baseUrl.replace(/\/$/, "")}/entity/${entity}/${id}`,
      type: entity,
      mediaType: "application/json",
    },
  };
}

function buildProductSnapshot(product, stockRow) {
  const salePrice = normalizeMoney(stockRow?.salePrice)
    ?? normalizeMoney(product.salePrices?.[0]?.value);
  const stock = typeof stockRow?.stock === "number" ? stockRow.stock : null;
  const reserve = typeof stockRow?.reserve === "number" ? stockRow.reserve : null;
  const availableStock = typeof stockRow?.quantity === "number"
    ? stockRow.quantity
    : (stock !== null && reserve !== null ? stock - reserve : null);

  return {
    id: product.id,
    code: product.code,
    name: product.name,
    pathName: product.pathName || stockRow?.folder?.name || "",
    salePrice,
    stock,
    reserve,
    availableStock,
    imageHref: stockRow?.image?.meta?.href || "",
    imageFilename: stockRow?.image?.filename || "product.jpg",
  };
}

export function createMoySkladClient(config) {
  const authHeader = getAuthHeader(config || {});
  const isEnabled = Boolean(config?.baseUrl && authHeader);
  // Cap every API call. Without this, Node fetch can hang minutes on a TCP
  // half-open socket; the reservation hot path (findCounterpartyByVkId,
  // createCustomerOrderReservation) is especially sensitive — a stalled
  // request blocks the whole бронь queue while customers wait.
  const requestTimeoutMs = Math.max(1000, Number(config?.requestTimeoutMs || 8000));

  async function fetchWithTimeout(url, init, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await fetch(url, { ...(init || {}), signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(`MoySklad ${label} timed out after ${requestTimeoutMs}ms`);
        timeoutError.code = "MOYSKLAD_TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestJson(path, searchParams) {
    const response = await fetchWithTimeout(
      buildApiUrl(config.baseUrl, path, searchParams),
      {
        headers: {
          Authorization: authHeader,
          Accept: "application/json;charset=utf-8",
        },
      },
      `GET ${path}`,
    );

    if (!response.ok) {
      throw new Error(`MoySklad HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      throw new Error(payload.errors.map((item) => item.error).join("; "));
    }

    return payload;
  }

  async function patchJson(path, payload) {
    const response = await fetchWithTimeout(
      buildApiUrl(config.baseUrl, path),
      {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          Accept: "application/json;charset=utf-8",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      `PUT ${path}`,
    );

    if (!response.ok) {
      throw new Error(`MoySklad HTTP ${response.status}`);
    }

    const responsePayload = await response.json();
    if (Array.isArray(responsePayload?.errors) && responsePayload.errors.length > 0) {
      throw new Error(responsePayload.errors.map((item) => item.error).join("; "));
    }

    return responsePayload;
  }

  async function postJson(path, payload) {
    const response = await fetchWithTimeout(
      buildApiUrl(config.baseUrl, path),
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          Accept: "application/json;charset=utf-8",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      `POST ${path}`,
    );

    if (!response.ok) {
      throw new Error(`MoySklad HTTP ${response.status}`);
    }

    const responsePayload = await response.json();
    if (Array.isArray(responsePayload?.errors) && responsePayload.errors.length > 0) {
      throw new Error(responsePayload.errors.map((item) => item.error).join("; "));
    }

    return responsePayload;
  }

  let cachedDefaults = null;

  async function resolveDefaults() {
    if (cachedDefaults) {
      return cachedDefaults;
    }

    const defaults = {
      organizationId: config.organizationId,
      storeId: config.storeId,
      customerOrderStateId: config.customerOrderStateId,
      salesChannelId: config.salesChannelId,
    };

    if (!defaults.organizationId) {
      const organizations = await requestJson("entity/organization", { limit: 50 });
      const preferredOrganization = organizations.rows?.find((item) => item.name === config.preferredOrganizationName)
        || organizations.rows?.[0];
      defaults.organizationId = preferredOrganization?.id || "";
    }

    if (!defaults.storeId) {
      const stores = await requestJson("entity/store", { limit: 10 });
      const preferredStore = stores.rows?.find((item) => item.name === config.preferredStoreName) || stores.rows?.[0];
      defaults.storeId = preferredStore?.id || "";
    }

    cachedDefaults = defaults;
    return defaults;
  }

  async function findCounterpartyByName(name) {
    const payload = await requestJson("entity/counterparty", {
      search: name,
      limit: 10,
    });

    return (payload.rows || []).find((item) => item.name === name) || null;
  }

  const configuredVkIdAttributeId = config.vkIdAttributeId || "";
  const vkIdAttributeName = config.vkIdAttributeName || "VK ID";
  let resolvedVkIdAttributeId = configuredVkIdAttributeId;
  let vkIdAttributeResolvePromise = null;

  async function resolveVkIdAttributeId() {
    if (resolvedVkIdAttributeId) {
      return resolvedVkIdAttributeId;
    }
    if (vkIdAttributeResolvePromise) {
      return vkIdAttributeResolvePromise;
    }

    vkIdAttributeResolvePromise = (async () => {
      try {
        const payload = await requestJson("entity/counterparty/metadata/attributes");
        const attributes = Array.isArray(payload?.rows) ? payload.rows : [];
        const match = attributes.find((attr) => attr?.name === vkIdAttributeName);
        if (match?.id) {
          resolvedVkIdAttributeId = match.id;
          logger.info("moysklad", "vk_id_attribute_discovered", {
            attributeName: vkIdAttributeName,
            attributeId: match.id,
          });
          return match.id;
        }
        logger.warn("moysklad", "vk_id_attribute_missing", {
          attributeName: vkIdAttributeName,
          available: attributes.map((a) => a?.name).filter(Boolean),
        });
        return "";
      } catch (error) {
        logger.warn("moysklad", "vk_id_attribute_lookup_failed", {
          error: error?.message || String(error),
        });
        return "";
      } finally {
        vkIdAttributeResolvePromise = null;
      }
    })();

    return vkIdAttributeResolvePromise;
  }

  function buildVkIdAttributePayload(viewerId, attributeId) {
    return {
      meta: {
        href: `${config.baseUrl.replace(/\/$/, "")}/entity/counterparty/metadata/attributes/${attributeId}`,
        type: "attributemetadata",
        mediaType: "application/json",
      },
      value: String(viewerId),
    };
  }

  function findVkIdAttributeValue(counterparty, attributeId) {
    if (!attributeId) {
      return null;
    }
    const attr = (counterparty?.attributes || []).find((item) => item?.id === attributeId);
    return attr?.value ?? null;
  }

  async function findCounterpartyByVkId(viewerId, attributeId) {
    if (!attributeId) {
      return null;
    }

    const attributeHref = `${config.baseUrl.replace(/\/$/, "")}/entity/counterparty/metadata/attributes/${attributeId}`;
    const payload = await requestJson("entity/counterparty", {
      filter: `${attributeHref}=${viewerId}`,
      limit: 1,
    });

    return payload.rows?.[0] || null;
  }

  async function findCounterpartyByViewerIdInDescription(viewerId) {
    const marker = `viewerId=${viewerId}`;
    const payload = await requestJson("entity/counterparty", {
      search: marker,
      limit: 25,
    });
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    return rows.find((item) => String(item?.description || "").includes(marker)) || null;
  }

  async function stampVkIdOnCounterparty(counterparty, viewerId, attributeId) {
    if (!attributeId || !counterparty?.id) {
      return counterparty;
    }

    const existingAttrs = Array.isArray(counterparty.attributes) ? counterparty.attributes : [];
    const merged = existingAttrs
      .filter((attr) => attr?.id !== attributeId)
      .concat([buildVkIdAttributePayload(viewerId, attributeId)]);

    return patchJson(`entity/counterparty/${counterparty.id}`, { attributes: merged });
  }

  const counterpartyLocks = new Map();

  async function ensureOrderHasBroadcastDescription(orderId) {
    const order = await requestJson(`entity/customerorder/${orderId}`);
    const description = String(order.description || "");

    if (description.includes("#Эфир")) {
      return order;
    }

    const nextDescription = description.trim()
      ? `#Эфир\n${description}`
      : "#Эфир";

    return patchJson(`entity/customerorder/${orderId}`, {
      description: nextDescription,
    });
  }

  async function downloadImage(imageHref) {
    if (!imageHref) {
      return null;
    }

    const timeoutMs = Math.max(1000, Number(config?.imageDownloadTimeoutMs || 10000));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(imageHref, {
        headers: {
          Authorization: authHeader,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`MoySklad image HTTP ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();

      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: response.headers.get("content-type") || "application/octet-stream",
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`MoySklad image download timed out after ${timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    isEnabled,
    async getProductCardByCode(code) {
      if (!isEnabled) {
        logger.info("moysklad", "lookup_skipped_not_configured", { code });
        return null;
      }

      const productPayload = await requestJson("entity/product", {
        filter: `code=${code}`,
        limit: 1,
      });

      const product = productPayload.rows?.[0] || null;
      if (!product) {
        logger.warn("moysklad", "product_not_found", { code });
        return null;
      }

      const stockPayload = await requestJson("report/stock/all", {
        filter: `product=${product.meta?.href}`,
        limit: 1,
      });

      const stockRow = stockPayload.rows?.[0] || null;
      const productCard = buildProductSnapshot(product, stockRow);

      if (productCard.imageHref) {
        try {
          const image = await downloadImage(productCard.imageHref);
          productCard.photo = image
            ? {
              ...image,
              filename: productCard.imageFilename,
            }
            : null;
        } catch (error) {
          logger.warn("moysklad", "product_image_download_failed", {
            code,
            productId: product.id,
            error,
          });
          productCard.photo = null;
        }
      } else {
        productCard.photo = null;
      }

      logger.info("moysklad", "product_card_loaded", {
        code,
        productId: product.id,
        hasPhoto: Boolean(productCard.photo),
      });

      return productCard;
    },
    async ensureCounterparty({ viewerId, viewerName }) {
      if (!isEnabled) {
        return null;
      }

      const lockKey = String(viewerId);
      const inflight = counterpartyLocks.get(lockKey);
      if (inflight) {
        return inflight;
      }

      const promise = (async () => {
        const normalizedViewerName = String(viewerName || "").trim() || `VK User ${viewerId}`;
        const counterpartyName = `VK: ${normalizedViewerName}`;
        const attributeId = await resolveVkIdAttributeId();

        async function backfillIfMissing(found, source) {
          if (!attributeId) return found;
          if (findVkIdAttributeValue(found, attributeId)) return found;
          try {
            const updated = await stampVkIdOnCounterparty(found, viewerId, attributeId);
            logger.info("moysklad", "counterparty_backfilled_vk_id", {
              viewerId,
              counterpartyId: found.id,
              source,
            });
            return updated;
          } catch (error) {
            logger.warn("moysklad", "counterparty_backfill_vk_id_failed", {
              viewerId,
              counterpartyId: found.id,
              source,
              error,
            });
            return found;
          }
        }

        // 1. Поиск по атрибуту VK ID (основной путь).
        if (attributeId) {
          const byVkId = await findCounterpartyByVkId(viewerId, attributeId);
          if (byVkId) {
            logger.info("moysklad", "counterparty_matched_by_vk_id", {
              viewerId,
              counterpartyId: byVkId.id,
              counterpartyName: byVkId.name,
            });
            return byVkId;
          }
        }

        // 2. Fallback: поиск по имени `VK: <name>`.
        const byName = await findCounterpartyByName(counterpartyName);
        if (byName) {
          logger.info("moysklad", "counterparty_reused", {
            viewerId,
            counterpartyId: byName.id,
            counterpartyName,
            source: "name",
          });
          return backfillIfMissing(byName, "name");
        }

        // 3. Fallback: поиск по маркеру `viewerId=N` в description.
        //    Закрывает старых контрагентов до бэкфилла и кейс «имя в МойСклад
        //    отредактировали вручную».
        const byDescription = await findCounterpartyByViewerIdInDescription(viewerId);
        if (byDescription) {
          logger.info("moysklad", "counterparty_reused", {
            viewerId,
            counterpartyId: byDescription.id,
            counterpartyName: byDescription.name,
            source: "description",
          });
          return backfillIfMissing(byDescription, "description");
        }

        // 4. Создаём нового — сразу с VK ID в атрибуте, если он известен.
        const payload = {
          name: counterpartyName,
          description: `Создано из VK live comment. viewerId=${viewerId}`,
        };
        if (attributeId) {
          payload.attributes = [buildVkIdAttributePayload(viewerId, attributeId)];
        }

        const created = await postJson("entity/counterparty", payload);
        logger.info("moysklad", "counterparty_created", {
          viewerId,
          counterpartyId: created.id,
          counterpartyName,
          vkIdStamped: Boolean(attributeId),
        });

        return created;
      })().finally(() => {
        counterpartyLocks.delete(lockKey);
      });

      counterpartyLocks.set(lockKey, promise);
      return promise;
    },
    async createCustomerOrderReservation({ activeLot, productCard, reservation }) {
      if (!isEnabled || !activeLot?.product?.id || !reservation?.viewerId) {
        return null;
      }

      const defaults = await resolveDefaults();
      if (!defaults.organizationId || !defaults.storeId) {
        throw new Error("MoySklad defaults are incomplete: organization/store is required");
      }

      const counterparty = await this.ensureCounterparty({
        viewerId: reservation.viewerId,
        viewerName: reservation.viewerName,
      });

      const payload = {
        description: `#Эфир\nVK reservation. lot=${activeLot.code}; lotSessionId=${activeLot.lotSessionId}; commentId=${reservation.commentId}; viewerId=${reservation.viewerId}`,
        organization: buildEntityMeta(config.baseUrl, "organization", defaults.organizationId),
        store: buildEntityMeta(config.baseUrl, "store", defaults.storeId),
        agent: buildEntityMeta(config.baseUrl, "counterparty", counterparty.id),
        positions: [
          {
            quantity: 1,
            price: toMinorUnits((productCard?.salePrice ?? activeLot.product.salePrice) - (activeLot.discountAmount || 0)),
            reserve: 1,
            assortment: buildEntityMeta(config.baseUrl, "product", activeLot.product.id),
          },
        ],
      };

      const order = await postJson("entity/customerorder", payload);
      logger.info("moysklad", "customer_order_created", {
        lotSessionId: activeLot.lotSessionId,
        orderId: order.id,
        counterpartyId: counterparty.id,
        viewerId: reservation.viewerId,
      });

      return {
        id: order.id,
        name: order.name,
        counterpartyId: counterparty.id,
      };
    },
    async appendPositionToCustomerOrder({ orderId, activeLot, productCard, reservation }) {
      if (!isEnabled || !orderId || !activeLot?.product?.id || !reservation?.viewerId) {
        return null;
      }

      await ensureOrderHasBroadcastDescription(orderId);

      const payload = [
        {
          quantity: 1,
          price: toMinorUnits((productCard?.salePrice ?? activeLot.product.salePrice) - (activeLot.discountAmount || 0)),
          reserve: 1,
          assortment: buildEntityMeta(config.baseUrl, "product", activeLot.product.id),
        },
      ];

      const positions = await postJson(`entity/customerorder/${orderId}/positions`, payload);
      logger.info("moysklad", "customer_order_position_added", {
        orderId,
        lotSessionId: activeLot.lotSessionId,
        viewerId: reservation.viewerId,
        productId: activeLot.product.id,
      });

      return {
        orderId,
        positionsAdded: Array.isArray(positions.rows) ? positions.rows.length : 1,
      };
    },
  };
}
