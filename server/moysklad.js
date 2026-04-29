import { logger } from "./logger.js";

function buildBasicAuthHeader(login, password) {
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

function getAuthHeader(config) {
  if (config.token) {
    return `Bearer ${config.token}`;
  }

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

  async function requestJson(path, searchParams) {
    const response = await fetch(buildApiUrl(config.baseUrl, path, searchParams), {
      headers: {
        Authorization: authHeader,
        Accept: "application/json;charset=utf-8",
      },
    });

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
    const response = await fetch(buildApiUrl(config.baseUrl, path), {
      method: "PUT",
      headers: {
        Authorization: authHeader,
        Accept: "application/json;charset=utf-8",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

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
    const response = await fetch(buildApiUrl(config.baseUrl, path), {
      method: "POST",
      headers: {
        Authorization: authHeader,
        Accept: "application/json;charset=utf-8",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

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
      const organizations = await requestJson("entity/organization", { limit: 1 });
      defaults.organizationId = organizations.rows?.[0]?.id || "";
    }

    if (!defaults.storeId) {
      const stores = await requestJson("entity/store", { limit: 10 });
      const preferredStore = stores.rows?.find((item) => item.name === "Аукцион") || stores.rows?.[0];
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

    const response = await fetch(imageHref, {
      headers: {
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      throw new Error(`MoySklad image HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();

    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: response.headers.get("content-type") || "application/octet-stream",
    };
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

      const normalizedViewerName = String(viewerName || "").trim() || `VK User ${viewerId}`;
      const counterpartyName = `VK: ${normalizedViewerName}`;
      const existing = await findCounterpartyByName(counterpartyName);
      if (existing) {
        logger.info("moysklad", "counterparty_reused", {
          viewerId,
          counterpartyId: existing.id,
          counterpartyName,
        });
        return existing;
      }

      const created = await postJson("entity/counterparty", {
        name: counterpartyName,
        description: `Создано из VK live comment. viewerId=${viewerId}`,
      });

      logger.info("moysklad", "counterparty_created", {
        viewerId,
        counterpartyId: created.id,
        counterpartyName,
      });

      return created;
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
        name: `VK-${activeLot.code}-${reservation.commentId}`,
        description: `#Эфир\nVK reservation. lotSessionId=${activeLot.lotSessionId}; commentId=${reservation.commentId}; viewerId=${reservation.viewerId}`,
        organization: buildEntityMeta(config.baseUrl, "organization", defaults.organizationId),
        store: buildEntityMeta(config.baseUrl, "store", defaults.storeId),
        agent: buildEntityMeta(config.baseUrl, "counterparty", counterparty.id),
        positions: [
          {
            quantity: 1,
            price: toMinorUnits(productCard?.salePrice ?? activeLot.product.salePrice),
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
          price: toMinorUnits(productCard?.salePrice ?? activeLot.product.salePrice),
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
