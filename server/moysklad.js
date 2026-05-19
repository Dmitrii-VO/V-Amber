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

export function createMoySkladClient(config, options = {}) {
  const authHeader = getAuthHeader(config || {});
  const isEnabled = Boolean(config?.baseUrl && authHeader);
  // Diagnostic sink: optional callback that receives a sanitized event per
  // MoySklad call (no payload, no auth headers). Used by the server to route
  // moysklad_call events into the active session jsonl. If the sink throws
  // we never let it affect the actual API path.
  const onCall = typeof options.onCall === "function" ? options.onCall : null;
  function emitCall(event) {
    if (!onCall) return;
    try { onCall(event); } catch { /* swallowed: diagnostics must never fail the request */ }
  }
  function extractIdsFromResponse(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (payload.id) return { id: payload.id };
    if (Array.isArray(payload.rows)) {
      return { rowCount: payload.rows.length };
    }
    return null;
  }
  // Cap every API call. Without this, Node fetch can hang minutes on a TCP
  // half-open socket; the reservation hot path (findCounterpartyByVkId,
  // createCustomerOrderReservation) is especially sensitive — a stalled
  // request blocks the whole бронь queue while customers wait.
  const requestTimeoutMs = Math.max(1000, Number(config?.requestTimeoutMs || 8000));
  // Bulk-операции (загрузка каталога продуктов на сотни/тысячи позиций)
  // выходят за горячий budget — у них отдельный потолок.
  const bulkRequestTimeoutMs = Math.max(requestTimeoutMs, Number(config?.bulkRequestTimeoutMs || 60000));

  async function fetchWithTimeout(url, init, label, timeoutMs) {
    const effectiveTimeoutMs = Math.max(1000, Number(timeoutMs || requestTimeoutMs));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    try {
      return await fetch(url, { ...(init || {}), signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(`MoySklad ${label} timed out after ${effectiveTimeoutMs}ms`);
        timeoutError.code = "MOYSKLAD_TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestJson(path, searchParams, options = {}) {
    const startedAt = Date.now();
    let httpStatus = 0;
    let ok = false;
    let errorMessage = null;
    let payload = null;
    const callSource = options.source || undefined;
    try {
      const response = await fetchWithTimeout(
        buildApiUrl(config.baseUrl, path, searchParams),
        {
          headers: {
            Authorization: authHeader,
            Accept: "application/json;charset=utf-8",
          },
        },
        `GET ${path}`,
        options.timeoutMs,
      );
      httpStatus = response.status;

      if (!response.ok) {
        errorMessage = `MoySklad HTTP ${response.status}`;
        throw new Error(errorMessage);
      }

      payload = await response.json();
      if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
        errorMessage = payload.errors.map((item) => item.error).join("; ");
        throw new Error(errorMessage);
      }

      ok = true;
      return payload;
    } catch (error) {
      errorMessage = errorMessage || (error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      emitCall({
        op: "GET",
        method: "GET",
        path,
        durationMs: Date.now() - startedAt,
        ok,
        httpStatus,
        idsExtracted: extractIdsFromResponse(payload),
        errorMessage: ok ? null : errorMessage,
        source: callSource,
      });
    }
  }

  async function patchJson(path, payload, options = {}) {
    const startedAt = Date.now();
    const callSource = options.source || undefined;
    let httpStatus = 0;
    let ok = false;
    let errorMessage = null;
    let responsePayload = null;
    try {
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
      httpStatus = response.status;

      if (!response.ok) {
        errorMessage = `MoySklad HTTP ${response.status}`;
        throw new Error(errorMessage);
      }

      responsePayload = await response.json();
      if (Array.isArray(responsePayload?.errors) && responsePayload.errors.length > 0) {
        errorMessage = responsePayload.errors.map((item) => item.error).join("; ");
        throw new Error(errorMessage);
      }

      ok = true;
      return responsePayload;
    } catch (error) {
      errorMessage = errorMessage || (error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      emitCall({
        op: "PUT",
        method: "PUT",
        path,
        durationMs: Date.now() - startedAt,
        ok,
        httpStatus,
        idsExtracted: extractIdsFromResponse(responsePayload),
        errorMessage: ok ? null : errorMessage,
        source: callSource,
      });
    }
  }

  async function postJson(path, payload, options = {}) {
    const startedAt = Date.now();
    const callSource = options.source || undefined;
    let httpStatus = 0;
    let ok = false;
    let errorMessage = null;
    let responsePayload = null;
    try {
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
      httpStatus = response.status;

      if (!response.ok) {
        errorMessage = `MoySklad HTTP ${response.status}`;
        throw new Error(errorMessage);
      }

      responsePayload = await response.json();
      if (Array.isArray(responsePayload?.errors) && responsePayload.errors.length > 0) {
        errorMessage = responsePayload.errors.map((item) => item.error).join("; ");
        throw new Error(errorMessage);
      }

      ok = true;
      return responsePayload;
    } catch (error) {
      errorMessage = errorMessage || (error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      emitCall({
        op: "POST",
        method: "POST",
        path,
        durationMs: Date.now() - startedAt,
        ok,
        httpStatus,
        idsExtracted: extractIdsFromResponse(responsePayload),
        errorMessage: ok ? null : errorMessage,
        source: callSource,
      });
    }
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

    // Список складов нужен и для выбора storeId, и для расчёта суммарного
    // остатка по разрешённым складам. Берём его один раз и переиспользуем.
    const storeRows = await requestJson("entity/store", { limit: 100 });
    const stores = Array.isArray(storeRows.rows) ? storeRows.rows : [];

    if (!defaults.storeId) {
      const preferredStore = stores.find((item) => item.name === config.preferredStoreName) || stores[0];
      defaults.storeId = preferredStore?.id || "";
    }

    const excluded = new Set(
      (Array.isArray(config.excludedStoreNames) ? config.excludedStoreNames : [])
        .map((name) => String(name || "").trim())
        .filter(Boolean),
    );
    defaults.stockStoreHrefs = stores
      .filter((item) => item?.name && !excluded.has(item.name))
      .map((item) => item.meta?.href)
      .filter(Boolean);

    logger.info("moysklad", "stock_stores_resolved", {
      includedCount: defaults.stockStoreHrefs.length,
      excludedNames: [...excluded],
      includedNames: stores
        .filter((item) => item?.name && !excluded.has(item.name))
        .map((item) => item.name),
    });

    // Резолвим UUID статуса «Новый» один раз: нужен для поиска ранее
    // созданного заказа клиента, в который можно дописать позицию вместо
    // создания нового customer order на каждую бронь.
    if (!defaults.customerOrderStateId) {
      try {
        const metadata = await requestJson("entity/customerorder/metadata", {});
        const states = Array.isArray(metadata.states) ? metadata.states : [];
        const newState = states.find((item) => /^нов/i.test(String(item?.name || "").trim()))
          || states[0];
        defaults.customerOrderStateId = newState?.id || "";
        defaults.customerOrderStateHref = newState?.meta?.href || "";
        logger.info("moysklad", "customer_order_state_resolved", {
          stateId: defaults.customerOrderStateId,
          stateName: newState?.name || null,
        });
      } catch (error) {
        logger.warn("moysklad", "customer_order_state_resolve_failed", { error });
      }
    } else {
      defaults.customerOrderStateHref = `${config.baseUrl.replace(/\/$/, "")}/entity/customerorder/metadata/states/${defaults.customerOrderStateId}`;
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

  async function findLatestOpenCustomerOrder(counterpartyId, { source } = {}) {
    if (!counterpartyId) {
      return null;
    }

    const defaults = await resolveDefaults();
    if (!defaults.customerOrderStateHref) {
      // Без href статуса «Новый» нельзя надёжно отличить открытые заказы
      // от завершённых; лучше вернуть null и создать новый заказ, чем
      // дописать позицию в уже отгружённый.
      logger.warn("moysklad", "open_order_lookup_skipped_no_state", { counterpartyId });
      return null;
    }

    const agentHref = `${config.baseUrl.replace(/\/$/, "")}/entity/counterparty/${counterpartyId}`;
    const filter = [
      `agent=${agentHref}`,
      `state=${defaults.customerOrderStateHref}`,
    ].join(";");

    const payload = await requestJson("entity/customerorder", {
      filter,
      order: "moment,desc",
      limit: 1,
    }, { source });

    const row = payload.rows?.[0] || null;
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      counterpartyId,
    };
  }

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

      // Суммируем остаток по разрешённым складам (по умолчанию все, кроме
      // «Брак»). report/stock/all агрегирует одну строку на продукт, а
      // несколько `store=...` сегментов в filter работают как OR — поэтому
      // отфильтрованный ответ возвращает уже сумму по нужным складам.
      const { stockStoreHrefs } = await resolveDefaults();
      const stockFilterParts = [`product=${product.meta?.href}`];
      if (Array.isArray(stockStoreHrefs) && stockStoreHrefs.length > 0) {
        for (const href of stockStoreHrefs) {
          stockFilterParts.push(`store=${href}`);
        }
      }
      const stockPayload = await requestJson("report/stock/all", {
        filter: stockFilterParts.join(";"),
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
        productName: productCard.name,
        pathName: productCard.pathName,
        salePrice: productCard.salePrice,
        stock: productCard.stock,
        reserve: productCard.reserve,
        availableStock: productCard.availableStock,
        hasPhoto: Boolean(productCard.photo),
      });

      return productCard;
    },
    async getProductCodes() {
      if (!isEnabled) {
        logger.info("moysklad", "product_code_cache_skipped_not_configured");
        return [];
      }

      const codes = [];
      // Меньше rows на страницу = быстрее одиночный ответ = меньше шанс
      // упереться в bulk-таймаут на медленной сети. 500 — компромисс между
      // числом запросов и устойчивостью.
      const limit = 500;
      let offset = 0;

      while (true) {
        const payload = await requestJson(
          "entity/product",
          { limit, offset },
          { timeoutMs: bulkRequestTimeoutMs },
        );
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        for (const product of rows) {
          if (product?.archived === true) {
            continue;
          }
          const code = String(product?.code || "").trim();
          if (/^\d{1,10}$/.test(code)) {
            codes.push(code);
          }
        }

        offset += rows.length;
        const total = Number(payload?.meta?.size || 0);
        if (rows.length === 0 || offset >= total) {
          break;
        }
      }

      return [...new Set(codes)];
    },
    async findOpenCustomerOrderForCounterparty(counterpartyId) {
      if (!isEnabled) {
        return null;
      }
      return findLatestOpenCustomerOrder(counterpartyId);
    },
    // Проверяет: есть ли у контрагента открытый customerorder, в который УЖЕ
    // добавлена позиция с productId. Используется для UI-пометки «✔ уже в
    // открытом заказе» в Wish list — чтобы оператор не создавал дубль PO.
    // Если открытого заказа нет → inOpenOrder:false. Если есть, но позиции
    // не пересекаются → тоже false. inOpenOrder:true только когда обнаружено
    // совпадение по assortment.id.
    async hasPositionForProduct(counterpartyId, productId, { source } = {}) {
      if (!isEnabled || !counterpartyId || !productId) {
        return { inOpenOrder: false };
      }
      const open = await findLatestOpenCustomerOrder(counterpartyId, { source });
      if (!open?.id) return { inOpenOrder: false };

      // Тянем позиции открытого заказа. limit 1000 покрывает все реалистичные
      // объёмы — клиент с заказом из 1000+ позиций уже сам по себе аномалия.
      const positionsPayload = await requestJson(
        `entity/customerorder/${open.id}/positions`,
        { limit: 1000 },
        { source },
      );
      const rows = Array.isArray(positionsPayload?.rows) ? positionsPayload.rows : [];
      const productHrefSuffix = `/entity/product/${productId}`;
      const found = rows.some((row) => {
        const href = row?.assortment?.meta?.href || "";
        return href.endsWith(productHrefSuffix);
      });
      return found
        ? { inOpenOrder: true, orderId: open.id, orderName: open.name || null }
        : { inOpenOrder: false };
    },
    async ensureCounterparty({ viewerId, viewerName, createIfMissing = true }) {
      if (!isEnabled) {
        return null;
      }

      // Lock key включает режим: read-only check не должен подхватывать
      // write-promise (это сделало бы проверку «пересечений» косвенно пишущей)
      // и write-flow не должен подхватывать read-promise (тогда контрагент не
      // создастся и реальная бронь упадёт). До этого ключевалось только по
      // viewerId, и при гонке двух flow один из них получал не свой результат.
      const lockKey = `${viewerId}:${createIfMissing ? "write" : "read"}`;
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
          // В read-only режиме (check-customerorders) не пишем backfill, чтобы
          // «проверка пересечений» оставалась полностью read-only.
          if (!createIfMissing) return found;
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

        // Read-only режим: не нашли → возвращаем null, в МС ничего не пишем.
        if (!createIfMissing) {
          return null;
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
    async createCustomerOrderReservation({ activeLot, productCard, reservation, counterparty: preResolvedCounterparty }) {
      if (!isEnabled || !activeLot?.product?.id || !reservation?.viewerId) {
        return null;
      }

      const defaults = await resolveDefaults();
      if (!defaults.organizationId || !defaults.storeId) {
        throw new Error("MoySklad defaults are incomplete: organization/store is required");
      }

      const counterparty = preResolvedCounterparty?.id
        ? preResolvedCounterparty
        : await this.ensureCounterparty({
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

    // Bulk-выгрузка обогащённой информации по товарам: id, имя, поставщик
    // (id+name), закупочная цена (buyPrice.value уже в копейках по схеме МС —
    // НЕ прогонять через toMinorUnits!). Используется product-code-cache для
    // подсветки supplier/buyPrice в wish-list без запроса в горячем пути.
    async getProductsBulk({ source } = {}) {
      if (!isEnabled) {
        logger.info("moysklad", "products_bulk_skipped_not_configured");
        return new Map();
      }

      const result = new Map();
      const limit = 500;
      let offset = 0;

      while (true) {
        const payload = await requestJson(
          "entity/product",
          { limit, offset, expand: "supplier" },
          { timeoutMs: bulkRequestTimeoutMs, source },
        );
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        for (const product of rows) {
          if (product?.archived === true) continue;
          const code = String(product?.code || "").trim();
          if (!/^\d{1,10}$/.test(code)) continue;
          const buyPrice = typeof product?.buyPrice?.value === "number" ? product.buyPrice.value : null;
          const supplier = product?.supplier || null;
          // supplier.meta.href выглядит как .../entity/counterparty/<uuid>.
          // Достаём uuid руками — отдельного id поля у meta-объекта нет.
          let supplierId = null;
          let supplierName = "";
          if (supplier?.meta?.href) {
            const match = /\/counterparty\/([0-9a-f-]+)/i.exec(supplier.meta.href);
            if (match) supplierId = match[1];
            supplierName = supplier?.name || "";
          }
          result.set(code, {
            id: product.id,
            name: product.name || "",
            supplierId,
            supplierName,
            buyPrice,
          });
        }

        offset += rows.length;
        const total = Number(payload?.meta?.size || 0);
        if (rows.length === 0 || offset >= total) break;
      }

      return result;
    },

    async listSuppliers({ source } = {}) {
      if (!isEnabled) return [];
      const all = [];
      const limit = 100;
      let offset = 0;
      while (true) {
        const payload = await requestJson(
          "entity/counterparty",
          { limit, offset },
          { timeoutMs: bulkRequestTimeoutMs, source },
        );
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        for (const row of rows) {
          if (!row?.id) continue;
          all.push({
            id: row.id,
            name: row.name || "",
            companyType: row.companyType || null,
            tags: Array.isArray(row.tags) ? row.tags : [],
          });
        }
        offset += rows.length;
        const total = Number(payload?.meta?.size || 0);
        if (rows.length === 0 || offset >= total) break;
      }
      return all;
    },

    async listStores({ source } = {}) {
      if (!isEnabled) return [];
      const payload = await requestJson("entity/store", { limit: 100 }, { source });
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      return rows.map((row) => ({ id: row.id, name: row.name || "" }));
    },

    // POST entity/purchaseorder. Обязательные поля по схеме МС: organization,
    // agent (поставщик). store по схеме не обязателен, но на уровне приложения
    // мы требуем его перед вызовом (проверка в http-handler). positions[].inTransit
    // = quantity — маркирует, что эти товары «заказаны и ожидаются».
    // price передаётся уже в копейках от вызывающего (buyPrice.value из МС).
    // Публичный доступ к резолвленным дефолтам (organizationId, storeId,
     // customerOrderStateId и т.д.) — нужен для PO handler, который не хочет
     // знать тонкости MS-discovery (preferredOrganizationName и т.д.).
    async getDefaults() {
      if (!isEnabled) return null;
      return resolveDefaults();
    },
    async createPurchaseOrder({ organizationId, storeId, agentId, positions, description, source = "http" }) {
      if (!isEnabled) {
        // Раньше возвращали skipped — HTTP handler принимал это за успех и
        // помечал записи consumed без созданного PO. Теперь бросаем; handler
        // штатно отметит группу failed и оставит entries активными.
        throw new Error("createPurchaseOrder: MoySklad client is not configured");
      }
      if (!organizationId || !agentId) {
        throw new Error("createPurchaseOrder: organizationId and agentId are required");
      }
      if (!Array.isArray(positions) || positions.length === 0) {
        throw new Error("createPurchaseOrder: positions must be a non-empty array");
      }

      const payload = {
        organization: buildEntityMeta(config.baseUrl, "organization", organizationId),
        agent: buildEntityMeta(config.baseUrl, "counterparty", agentId),
        positions: positions.map((p) => ({
          quantity: p.quantity,
          inTransit: p.quantity,
          price: typeof p.price === "number" ? p.price : 0,
          assortment: buildEntityMeta(config.baseUrl, "product", p.productId),
        })),
      };
      if (storeId) {
        payload.store = buildEntityMeta(config.baseUrl, "store", storeId);
      }
      if (description) {
        payload.description = String(description).slice(0, 4000);
      }

      const created = await postJson("entity/purchaseorder", payload, { source });
      logger.info("moysklad", "purchase_order_created", {
        orderId: created.id,
        agentId,
        positionsCount: positions.length,
      });
      return {
        id: created.id,
        name: created.name,
        agentId,
      };
    },
  };
}
