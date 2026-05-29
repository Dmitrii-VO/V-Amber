// Pure helpers extracted from moysklad.js — no network I/O, no closure state.
// Easy to unit-test and reuse.

export function buildBasicAuthHeader(login, password) {
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

export function getAuthHeader(config) {
  if (config.login && config.password) {
    return buildBasicAuthHeader(config.login, config.password);
  }
  return "";
}

export function buildApiUrl(baseUrl, path, searchParams) {
  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(searchParams || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export function normalizeMoney(value) {
  return typeof value === "number" ? value / 100 : null;
}

export function normalizeQuantity(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function toMinorUnits(value) {
  return typeof value === "number" ? Math.round(value * 100) : 0;
}

// Effective sale price: prefer productCard / activeLot salePrice when usable,
// otherwise fall back to voicePrice. Mirrors the helper in ws-helpers but on
// the MoySklad side these have additional fallback layers via productCard.
export function getEffectiveSalePrice(activeLot, productCard) {
  const salePrice = productCard?.salePrice ?? activeLot?.product?.salePrice;
  if (typeof salePrice === "number" && Number.isFinite(salePrice) && salePrice > 0) {
    return salePrice;
  }
  const voicePrice = productCard?.voicePrice ?? activeLot?.product?.voicePrice;
  return typeof voicePrice === "number" && Number.isFinite(voicePrice) && voicePrice > 0
    ? voicePrice
    : salePrice;
}

export function extractEntityIdFromHref(href, entity) {
  const escaped = String(entity || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`/entity/${escaped}/([0-9a-f-]+)`, "i").exec(String(href || ""));
  return match?.[1] || null;
}

export function extractViewerIdFromText(text) {
  const match = /viewerId\s*=\s*(\d+)/i.exec(String(text || ""));
  return match?.[1] || null;
}

export function formatBroadcastDate(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return formatBroadcastDate(new Date());
  }
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function buildBroadcastMarker(broadcastDate) {
  return `#Эфир ${formatBroadcastDate(broadcastDate)}`;
}

export function buildEntityMeta(baseUrl, entity, id) {
  return {
    meta: {
      href: `${baseUrl.replace(/\/$/, "")}/entity/${entity}/${id}`,
      type: entity,
      mediaType: "application/json",
    },
  };
}

export function buildProductSnapshot(product, stockRow) {
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
