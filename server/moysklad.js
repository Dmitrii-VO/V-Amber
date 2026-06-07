import { logger } from "./logger.js";
import {
  getAuthHeader,
  buildApiUrl,
  normalizeMoney,
  normalizeQuantity,
  toMinorUnits,
  getEffectiveSalePrice,
  extractEntityIdFromHref,
  extractViewerIdFromText,
  formatBroadcastDate,
  buildBroadcastMarker,
  buildEntityMeta,
  buildProductSnapshot,
} from "./moysklad-helpers.js";

// Статусы заказа клиента, считающиеся «закрытыми» — после них новые брони
// покупателя уходят в НОВЫЙ заказ, а не дописываются. Имена нормализуются
// (нижний регистр, ё→е, обрезка пробелов). «Отменён» учитываем тоже.
const CLOSED_ORDER_STATE_NAMES = new Set([
  "запакован",
  "отправлен",
  "доставлен",
  "отменен",
]);

const APPEND_BLOCKING_ORDER_STATE_NAMES = new Set([
  ...CLOSED_ORDER_STATE_NAMES,
  "оплачен",
  "частично оплачен",
  "оплачен частично",
]);

function normalizeStateName(name) {
  return String(name || "").trim().toLowerCase().replace(/ё/g, "е");
}

function buildCustomerOrderPosition({ config, activeLot, productCard, reservation }) {
  const quantity = Math.max(1, Number(reservation?.quantity) || 1);
  const salePrice = Number(getEffectiveSalePrice(activeLot, productCard) || 0);
  const discountAmount = Number(activeLot?.discountAmount || 0);
  const position = {
    quantity,
    price: toMinorUnits(salePrice),
    reserve: quantity,
    assortment: buildEntityMeta(config.baseUrl, "product", activeLot.product.id),
  };
  if (Number.isFinite(salePrice) && salePrice > 0 && Number.isFinite(discountAmount) && discountAmount > 0) {
    position.discount = Math.min(100, (discountAmount / salePrice) * 100);
  }
  return position;
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

  // DELETE-запрос. Используется для отмены брони (удаление позиции из
  // customerorder). Идемпотентность: MoySklad на повторное удаление уже
  // удалённой позиции отвечает 404 — трактуем как успех (alreadyGone:true),
  // чтобы ретрай оператора не приводил к ошибке. 200/204 без тела — тоже ок.
  async function deleteJson(path, options = {}) {
    const startedAt = Date.now();
    const callSource = options.source || undefined;
    let httpStatus = 0;
    let ok = false;
    let errorMessage = null;
    try {
      const response = await fetchWithTimeout(
        buildApiUrl(config.baseUrl, path),
        {
          method: "DELETE",
          headers: {
            Authorization: authHeader,
            Accept: "application/json;charset=utf-8",
          },
        },
        `DELETE ${path}`,
      );
      httpStatus = response.status;

      if (response.status === 404) {
        ok = true;
        return { ok: true, alreadyGone: true };
      }

      if (!response.ok) {
        errorMessage = `MoySklad HTTP ${response.status}`;
        throw new Error(errorMessage);
      }

      ok = true;
      return { ok: true };
    } catch (error) {
      errorMessage = errorMessage || (error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      emitCall({
        op: "DELETE",
        method: "DELETE",
        path,
        durationMs: Date.now() - startedAt,
        ok,
        httpStatus,
        idsExtracted: [],
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

    // Статусы заказа клиента из метаданных. Нужны для трёх вещей:
    //  1) href статуса «Новый» — под ним создаём заказ;
    //  2) множество «закрытых» статусов — после них заказ дополнять нельзя
    //     для сводок/старых open-order проверок;
    //  3) множество статусов, куда нельзя дописывать новые брони.
    // Тянем метаданные всегда (даже при заданном customerOrderStateId), иначе
    // не из чего собрать эти множества по именам статусов.
    let states = [];
    try {
      const metadata = await requestJson("entity/customerorder/metadata", {});
      states = Array.isArray(metadata.states) ? metadata.states : [];
    } catch (error) {
      logger.warn("moysklad", "customer_order_metadata_resolve_failed", { error });
    }

    if (!defaults.customerOrderStateId) {
      const newState = states.find((item) => /^нов/i.test(String(item?.name || "").trim()))
        || states[0];
      defaults.customerOrderStateId = newState?.id || "";
      defaults.customerOrderStateHref = newState?.meta?.href || "";
      logger.info("moysklad", "customer_order_state_resolved", {
        stateId: defaults.customerOrderStateId,
        stateName: newState?.name || null,
      });
    } else {
      defaults.customerOrderStateHref = `${config.baseUrl.replace(/\/$/, "")}/entity/customerorder/metadata/states/${defaults.customerOrderStateId}`;
    }

    // Закрытые статусы по решению оператора: «Запакован», «Отправлен»,
    // «Доставлен», «Отменён». В заказ с любым из них новые брони НЕ дописываем.
    const closedStates = states.filter((item) => CLOSED_ORDER_STATE_NAMES.has(normalizeStateName(item?.name)));
    defaults.closedStateHrefs = new Set(closedStates.map((item) => item?.meta?.href).filter(Boolean));
    logger.info("moysklad", "customer_order_closed_states_resolved", {
      closedCount: defaults.closedStateHrefs.size,
      closedNames: closedStates.map((item) => item?.name),
    });

    const appendBlockedStates = states.filter((item) => APPEND_BLOCKING_ORDER_STATE_NAMES.has(normalizeStateName(item?.name)));
    defaults.appendBlockedStateHrefs = new Set(appendBlockedStates.map((item) => item?.meta?.href).filter(Boolean));
    logger.info("moysklad", "customer_order_append_blocking_states_resolved", {
      blockedCount: defaults.appendBlockedStateHrefs.size,
      blockedNames: appendBlockedStates.map((item) => item?.name),
    });

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

  async function getCounterpartyById(counterpartyId) {
    if (!counterpartyId) {
      return null;
    }
    return requestJson(`entity/counterparty/${counterpartyId}`);
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

  function extractViewerIdFromCounterparty(counterparty, attributeId) {
    const attrValue = findVkIdAttributeValue(counterparty, attributeId);
    const normalizedAttr = String(attrValue || "").trim();
    if (/^\d+$/.test(normalizedAttr)) {
      return normalizedAttr;
    }
    return extractViewerIdFromText(counterparty?.description);
  }

  function isNewCustomerOrderState(order, defaults) {
    const state = order?.state || null;
    const stateName = String(state?.name || "").trim();
    if (stateName) {
      return /^нов/i.test(stateName);
    }
    const stateHref = state?.meta?.href || "";
    return Boolean(defaults?.customerOrderStateHref && stateHref === defaults.customerOrderStateHref);
  }

  // Открытым (= в сводку/дозапись) считаем заказ, чей статус НЕ в множестве
  // закрытых (Запакован/Отправлен/Доставлен/Отменён). Это совпадает с логикой
  // findLatestOpenCustomerOrder: Копит/Оплачен/Собран и т.п. — открыты. Если
  // закрытые статусы резолвить не удалось — fallback к «только Новый», чтобы
  // случайно не втянуть отгруженный заказ.
  function isOpenCustomerOrderState(order, defaults) {
    const closedHrefs = defaults?.closedStateHrefs instanceof Set ? defaults.closedStateHrefs : null;
    if (!closedHrefs || closedHrefs.size === 0) {
      return isNewCustomerOrderState(order, defaults);
    }
    const state = order?.state || null;
    const stateName = String(state?.name || "").trim();
    if (stateName) {
      return !CLOSED_ORDER_STATE_NAMES.has(normalizeStateName(stateName));
    }
    const stateHref = state?.meta?.href || "";
    if (!stateHref) {
      return true; // нет статуса — трактуем как открытый (как «Новый»)
    }
    return !closedHrefs.has(stateHref);
  }

  function isAppendableCustomerOrderState(order, defaults) {
    const blockedHrefs = defaults?.appendBlockedStateHrefs instanceof Set ? defaults.appendBlockedStateHrefs : null;
    const state = order?.state || null;
    const stateName = String(state?.name || "").trim();
    if (stateName) {
      return !APPEND_BLOCKING_ORDER_STATE_NAMES.has(normalizeStateName(stateName));
    }
    const stateHref = state?.meta?.href || "";
    if (!blockedHrefs || blockedHrefs.size === 0) {
      return true;
    }
    if (!stateHref) {
      return true;
    }
    return !blockedHrefs.has(stateHref);
  }

  function buildMoySkladCustomerOrderUrl(orderId) {
    return orderId ? `https://online.moysklad.ru/app/#customerorder/edit?id=${orderId}` : "";
  }

  function buildDigestClient({ order, counterparty, viewerId, positions }) {
    const total = positions.reduce((sum, item) => sum + item.sum, 0);
    const counterpartyId = counterparty?.id
      || order?.agent?.id
      || extractEntityIdFromHref(order?.agent?.meta?.href, "counterparty");
    return {
      viewerId: viewerId || null,
      viewerName: counterparty?.name || order?.agent?.name || "",
      counterpartyId: counterpartyId || null,
      orders: [{
        id: order.id,
        name: order.name || "",
        moment: order.moment || "",
        stateName: order.state?.name || "",
        url: buildMoySkladCustomerOrderUrl(order.id),
      }],
      positions,
      total,
    };
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
    const agentHref = `${config.baseUrl.replace(/\/$/, "")}/entity/counterparty/${counterpartyId}`;
    const closedHrefs = defaults.closedStateHrefs instanceof Set ? [...defaults.closedStateHrefs] : [];

    let filterParts;
    if (closedHrefs.length > 0) {
      // День значения не имеет: берём самый свежий заказ контрагента, чей
      // статус ещё НЕ закрыт (не «Запакован/Отправлен/Доставлен/Отменён»).
      // В него и дописываем брони, сколько бы дней ни прошло. `state!=` —
      // штатный оператор фильтра МойСклада; несколько `!=` объединяются по И.
      filterParts = [`agent=${agentHref}`, ...closedHrefs.map((href) => `state!=${href}`)];
    } else if (defaults.customerOrderStateHref) {
      // Фолбэк (закрытые статусы резолвить не удалось): прежнее поведение —
      // дописываем только в заказы статуса «Новый».
      filterParts = [`agent=${agentHref}`, `state=${defaults.customerOrderStateHref}`];
    } else {
      logger.warn("moysklad", "open_order_lookup_skipped_no_state", { counterpartyId });
      return null;
    }

    const payload = await requestJson("entity/customerorder", {
      filter: filterParts.join(";"),
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

  // Перепроверяет статус КОНКРЕТНОГО заказа: можно ли в него ещё дописывать.
  // Нужна для in-memory кэша заказов (customerOrdersByViewerId) — оператор мог
  // перевести заказ в закрытый статус прямо во время эфира, и слепой append по
  // кэшу дописал бы позицию в уже отгружённый/упакованный заказ.
  async function checkCustomerOrderAppendable(orderId, { source } = {}) {
    if (!orderId) {
      return false;
    }
    const defaults = await resolveDefaults();
    const blockedHrefs = defaults.appendBlockedStateHrefs instanceof Set ? defaults.appendBlockedStateHrefs : null;
    if (!blockedHrefs || blockedHrefs.size === 0) {
      // Блокирующие статусы резолвить не удалось → не блокируем кэшированный
      // append только из-за отсутствия метаданных.
      return true;
    }
    const order = await requestJson(`entity/customerorder/${orderId}`, { expand: "state" }, { source });
    return isAppendableCustomerOrderState(order, defaults);
  }

  async function findLatestBroadcastCustomerOrder(counterpartyId, { broadcastDate, source } = {}) {
    if (!counterpartyId) {
      return null;
    }

    const defaults = await resolveDefaults();
    const blockedHrefs = defaults.appendBlockedStateHrefs instanceof Set ? [...defaults.appendBlockedStateHrefs] : [];
    if (blockedHrefs.length === 0 && !defaults.customerOrderStateHref) {
      logger.warn("moysklad", "broadcast_order_lookup_skipped_no_state", { counterpartyId });
      return null;
    }

    const marker = buildBroadcastMarker(broadcastDate);
    const agentHref = `${config.baseUrl.replace(/\/$/, "")}/entity/counterparty/${counterpartyId}`;
    const filterParts = [`agent=${agentHref}`];
    if (blockedHrefs.length > 0) {
      filterParts.push(...blockedHrefs.map((href) => `state!=${href}`));
    } else {
      filterParts.push(`state=${defaults.customerOrderStateHref}`);
    }

    const limit = 100;
    let offset = 0;
    let row = null;
    while (true) {
      const payload = await requestJson("entity/customerorder", {
        filter: filterParts.join(";"),
        order: "moment,desc",
        limit,
        offset,
      }, { source });
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      row = rows
        .filter((item) => isAppendableCustomerOrderState(item, defaults))
        .find((item) => String(item?.description || "").includes(marker));
      if (row) {
        break;
      }

      offset += rows.length;
      const total = Number(payload?.meta?.size || 0);
      if (rows.length === 0 || rows.length < limit || (total > 0 && offset >= total)) {
        break;
      }
    }

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      counterpartyId,
      broadcastDate: formatBroadcastDate(broadcastDate),
    };
  }

  async function getOpenOrderProductIds(counterpartyId, { source } = {}) {
    const open = await findLatestOpenCustomerOrder(counterpartyId, { source });
    if (!open?.id) {
      return { open: null, productIds: new Set() };
    }

    // Тянем позиции открытого заказа один раз на клиента. limit 1000 покрывает
    // реалистичные объёмы; больший заказ уже требует отдельной операторской проверки.
    const positionsPayload = await requestJson(
      `entity/customerorder/${open.id}/positions`,
      { limit: 1000 },
      { source },
    );
    const rows = Array.isArray(positionsPayload?.rows) ? positionsPayload.rows : [];
    const productIds = new Set();
    for (const row of rows) {
      const productId = row?.assortment?.id
        || extractEntityIdFromHref(row?.assortment?.meta?.href, "product");
      if (productId) productIds.add(productId);
    }
    return { open, productIds };
  }

  async function ensureOrderHasBroadcastDescription(orderId, broadcastDate) {
    const order = await requestJson(`entity/customerorder/${orderId}`);
    const description = String(order.description || "");
    const marker = buildBroadcastMarker(broadcastDate);

    if (description.includes(marker)) {
      return order;
    }

    const nextDescription = description.trim()
      ? `${marker}\n${description}`
      : marker;

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
    // true, если в заказ можно дописать позицию (статус не закрыт). Используется
    // для перепроверки устаревшего in-memory кэша заказа перед append'ом.
    async isCustomerOrderAppendable(orderId, { source } = {}) {
      if (!isEnabled) {
        return true;
      }
      return checkCustomerOrderAppendable(orderId, { source });
    },
    async findBroadcastCustomerOrderForCounterparty(counterpartyId, { broadcastDate, source } = {}) {
      if (!isEnabled) {
        return null;
      }
      return findLatestBroadcastCustomerOrder(counterpartyId, { broadcastDate, source });
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
      const { open, productIds } = await getOpenOrderProductIds(counterpartyId, { source });
      if (!open?.id) return { inOpenOrder: false };
      return productIds.has(productId)
        ? { inOpenOrder: true, orderId: open.id, orderName: open.name || null }
        : { inOpenOrder: false };
    },
    async checkOpenOrderPositionsForEntries(entries, { source } = {}) {
      const result = {};
      const rows = Array.isArray(entries) ? entries : [];
      for (const entry of rows) {
        if (entry?.entryId) result[entry.entryId] = { inOpenOrder: false };
      }
      if (!isEnabled || rows.length === 0) {
        return result;
      }

      const byViewer = new Map();
      for (const entry of rows) {
        const entryId = entry?.entryId;
        const viewerId = entry?.viewerId == null ? "" : String(entry.viewerId);
        const productId = entry?.productId;
        if (!entryId || !viewerId || !productId) continue;
        if (!byViewer.has(viewerId)) {
          byViewer.set(viewerId, { viewerName: entry.viewerName || "", entries: [] });
        }
        byViewer.get(viewerId).entries.push({ entryId, productId });
      }

      for (const [viewerId, group] of byViewer) {
        let counterparty = null;
        try {
          counterparty = await this.ensureCounterparty({
            viewerId,
            viewerName: group.viewerName,
            createIfMissing: false,
          });
        } catch (error) {
          logger.warn("moysklad", "bulk_open_order_counterparty_lookup_failed", {
            viewerId,
            error: error?.message || String(error),
          });
          for (const entry of group.entries) {
            result[entry.entryId] = { inOpenOrder: false, error: "lookup_failed" };
          }
          continue;
        }

        if (!counterparty?.id) continue;

        let open;
        let productIds;
        try {
          ({ open, productIds } = await getOpenOrderProductIds(counterparty.id, { source }));
        } catch (error) {
          logger.warn("moysklad", "bulk_open_order_positions_lookup_failed", {
            viewerId,
            counterpartyId: counterparty.id,
            error: error?.message || String(error),
          });
          for (const entry of group.entries) {
            result[entry.entryId] = { inOpenOrder: false, error: "lookup_failed" };
          }
          continue;
        }

        if (!open?.id) continue;
        for (const entry of group.entries) {
          result[entry.entryId] = productIds.has(entry.productId)
            ? { inOpenOrder: true, orderId: open.id, orderName: open.name || null }
            : { inOpenOrder: false };
        }
      }

      return result;
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
          let byNameDetails = byName;
          try {
            byNameDetails = await getCounterpartyById(byName.id) || byName;
          } catch (error) {
            logger.warn("moysklad", "counterparty_name_detail_lookup_failed", {
              viewerId,
              counterpartyId: byName.id,
              counterpartyName,
              error,
            });
          }
          const existingViewerId = extractViewerIdFromCounterparty(byNameDetails, attributeId);
          if (existingViewerId === String(viewerId)) {
            logger.info("moysklad", "counterparty_reused", {
              viewerId,
              counterpartyId: byNameDetails.id,
              counterpartyName,
              source: "name",
            });
            return backfillIfMissing(byNameDetails, "name");
          }
          if (existingViewerId) {
            logger.warn("moysklad", "counterparty_name_collision_skipped", {
              viewerId,
              existingViewerId,
              counterpartyId: byNameDetails.id,
              counterpartyName,
            });
          } else {
            logger.warn("moysklad", "counterparty_name_unverified_skipped", {
              viewerId,
              counterpartyId: byNameDetails.id,
              counterpartyName,
            });
          }
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
    // Возвращает id первой позиции заказа отдельным GET. Нужен как фоллбэк для
    // create-пути (#16): POST entity/customerorder отдаёт positions без rows.
    // Ошибку глотаем — отсутствие positionId не должно ронять саму бронь, она
    // лишь сделает её неотменяемой из UI (оператор удалит позицию в МойСкладе).
    async resolveFirstOrderPositionId(orderId) {
      try {
        const payload = await requestJson(`entity/customerorder/${orderId}/positions`, { limit: 1 });
        return payload.rows?.[0]?.id || null;
      } catch (error) {
        logger.warn("moysklad", "order_position_id_lookup_failed", {
          orderId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    async createCustomerOrderReservation({ activeLot, productCard, reservation, counterparty: preResolvedCounterparty, broadcastDate }) {
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
        description: `${buildBroadcastMarker(broadcastDate)}\nVK reservation. lot=${activeLot.code}; lotSessionId=${activeLot.lotSessionId}; commentId=${reservation.commentId}; viewerId=${reservation.viewerId}`,
        organization: buildEntityMeta(config.baseUrl, "organization", defaults.organizationId),
        store: buildEntityMeta(config.baseUrl, "store", defaults.storeId),
        agent: buildEntityMeta(config.baseUrl, "counterparty", counterparty.id),
        positions: [
          buildCustomerOrderPosition({ config, activeLot, productCard, reservation }),
        ],
      };

      const order = await postJson("entity/customerorder", payload);
      // Позиция, созданная вместе с заказом, нужна для адресной отмены брони
      // (#16): DELETE по точному positionId, а не «первую попавшуюся» позицию
      // того же товара. На POST entity/customerorder МойСклад возвращает
      // positions как коллекцию { meta } БЕЗ rows (rows приходят только при
      // expand), поэтому inline-чтение чаще всего даёт null — в этом случае
      // дотягиваем позиции отдельным GET, иначе отмена брони не найдёт id.
      let positionId = order.positions?.rows?.[0]?.id || null;
      if (!positionId && order.id) {
        positionId = await this.resolveFirstOrderPositionId(order.id);
      }
      logger.info("moysklad", "customer_order_created", {
        lotSessionId: activeLot.lotSessionId,
        orderId: order.id,
        positionId,
        counterpartyId: counterparty.id,
        viewerId: reservation.viewerId,
      });

      return {
        id: order.id,
        name: order.name,
        positionId,
        counterpartyId: counterparty.id,
      };
    },
    async appendPositionToCustomerOrder({ orderId, activeLot, productCard, reservation, broadcastDate }) {
      if (!isEnabled || !orderId || !activeLot?.product?.id || !reservation?.viewerId) {
        return null;
      }

      await ensureOrderHasBroadcastDescription(orderId, broadcastDate);

      const payload = [
        buildCustomerOrderPosition({ config, activeLot, productCard, reservation }),
      ];

      const positions = await postJson(`entity/customerorder/${orderId}/positions`, payload);
      // POST /positions возвращает массив созданных позиций (иногда обёрнутый
      // в { rows }). Берём id первой — он понадобится для адресной отмены (#16).
      const createdRows = Array.isArray(positions)
        ? positions
        : (Array.isArray(positions?.rows) ? positions.rows : []);
      const positionId = createdRows[0]?.id || null;
      logger.info("moysklad", "customer_order_position_added", {
        orderId,
        positionId,
        lotSessionId: activeLot.lotSessionId,
        viewerId: reservation.viewerId,
        productId: activeLot.product.id,
      });

      return {
        orderId,
        positionId,
        positionsAdded: createdRows.length || 1,
      };
    },

    // Удаляет одну позицию из customerorder. Используется отменой брони (#16):
    // адресный DELETE по точному positionId исключает удаление «соседней»
    // позиции того же товара (кейс reserved_appended). 404 → already gone,
    // идемпотентно. Метод обёрнут wrapWithSafeMode в index.js — в safe-mode
    // вернётся { skipped:true, safeMode:true } и реального удаления не будет.
    async removePositionFromOrder({ orderId, positionId, source } = {}) {
      if (!isEnabled || !orderId || !positionId) {
        return null;
      }

      const result = await deleteJson(
        `entity/customerorder/${orderId}/positions/${positionId}`,
        { source },
      );
      logger.info("moysklad", "customer_order_position_removed", {
        orderId,
        positionId,
        alreadyGone: Boolean(result?.alreadyGone),
      });
      return { ok: true, alreadyGone: Boolean(result?.alreadyGone) };
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

    async getReservationDigestForDate(date, { source } = {}) {
      if (!isEnabled) {
        logger.info("moysklad", "reservation_digest_skipped_not_configured", { date });
        return { date, count: 0, clients: [] };
      }

      const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))
        ? String(date)
        : new Date().toISOString().slice(0, 10);
      const defaults = await resolveDefaults();
      const start = `${normalizedDate} 00:00:00`;
      const end = `${normalizedDate} 23:59:59`;
      const filter = [`moment>=${start}`, `moment<=${end}`].join(";");
      const attributeId = await resolveVkIdAttributeId();
      const clientsByKey = new Map();
      const limit = 100;
      let offset = 0;

      while (true) {
        const payload = await requestJson("entity/customerorder", {
          filter,
          order: "moment,asc",
          expand: "agent,state",
          limit,
          offset,
        }, { source, timeoutMs: bulkRequestTimeoutMs });
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];

        for (const order of rows) {
          const description = String(order?.description || "");
          if (!description.includes("#Эфир")) continue;
          if (!isOpenCustomerOrderState(order, defaults)) continue;
          if (!order?.id) continue;

          let counterparty = order.agent || null;
          const counterpartyHref = order.agent?.meta?.href || "";
          const counterpartyId = extractEntityIdFromHref(counterpartyHref, "counterparty");
          let viewerId = extractViewerIdFromText(description);
          if (!viewerId && counterpartyId && (!Array.isArray(counterparty?.attributes) || !counterparty?.description)) {
            try {
              counterparty = await requestJson(
                `entity/counterparty/${counterpartyId}`,
                {},
                { source },
              );
            } catch (error) {
              logger.warn("moysklad", "reservation_digest_counterparty_load_failed", {
                orderId: order.id,
                error: error?.message || String(error),
              });
            }
          }

          viewerId = viewerId || extractViewerIdFromCounterparty(counterparty, attributeId);
          const positionsPayload = await requestJson(
            `entity/customerorder/${order.id}/positions`,
            { expand: "assortment", limit: 1000 },
            { source, timeoutMs: bulkRequestTimeoutMs },
          );
          const positions = (Array.isArray(positionsPayload?.rows) ? positionsPayload.rows : [])
            .map((row) => {
              const quantity = normalizeQuantity(row.quantity);
              const price = normalizeMoney(row.price) ?? 0;
              const sum = normalizeMoney(row.sum) ?? quantity * price;
              const assortment = row.assortment || {};
              return {
                id: row.id || null,
                productId: assortment.id || extractEntityIdFromHref(assortment?.meta?.href, "product"),
                productCode: String(assortment.code || "").trim(),
                productName: assortment.name || "",
                quantity,
                price,
                sum,
              };
            })
            .filter((row) => row.quantity > 0);

          const client = buildDigestClient({ order, counterparty, viewerId, positions });
          const key = viewerId || `missing:${order.id}`;
          const existing = clientsByKey.get(key);
          if (existing) {
            existing.orders.push(...client.orders);
            existing.positions.push(...client.positions);
            existing.total += client.total;
          } else {
            clientsByKey.set(key, client);
          }
        }

        offset += rows.length;
        const total = Number(payload?.meta?.size || 0);
        if (rows.length === 0 || offset >= total) break;
      }

      const clients = [...clientsByKey.values()]
        .map((client) => ({
          ...client,
          orderIds: client.orders.map((order) => order.id).filter(Boolean),
          orderNames: client.orders.map((order) => order.name).filter(Boolean),
          canSend: Boolean(client.viewerId && client.positions.length > 0),
          cannotSendReason: !client.viewerId
            ? "missing_vk_id"
            : (client.positions.length === 0 ? "empty_positions" : null),
        }))
        .sort((a, b) => String(a.viewerName || a.viewerId || "").localeCompare(String(b.viewerName || b.viewerId || ""), "ru"));

      return { date: normalizedDate, count: clients.length, clients };
    },
  };
}
