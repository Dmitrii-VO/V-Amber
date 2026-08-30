// Pure helpers extracted from moysklad.js — no network I/O, no closure state.
// Easy to unit-test and reuse.

import { createHash } from "node:crypto";

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

// Детерминированный UUID (RFC 4122, версия 5) — тот же вход всегда даёт тот же
// идентификатор, в том числе после рестарта и на другой машине. Нужен для
// syncId: МойСклад принимает в это поле только UUID, а нам нужно, чтобы
// повторная отправка той же группы пришла с тем же значением.
export function buildDeterministicUuid(namespace, name) {
  const namespaceBytes = Buffer.from(String(namespace).replace(/-/g, ""), "hex");
  const digest = createHash("sha1")
    .update(Buffer.concat([namespaceBytes, Buffer.from(String(name), "utf8")]))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20),
  ].join("-");
}

// Пространство имён V-Amber. Константа: меняя её, мы теряем связь со всеми
// ранее отправленными закупочными заказами.
export const V_AMBER_UUID_NAMESPACE = "6f0c9b8a-2d41-4d8e-9f3a-5b7c1e2a4d60";

// syncId закупочного заказа — «внешний код» на стороне МойСклада. Собирается из
// тех же draftId и groupHash, что и ключ журнала внешних записей, поэтому
// повторная отправка той же группы приходит с тем же syncId, а соседние группы
// одной отправки — с разными.
//
// Даёт две вещи, обе проверены на рабочем аккаунте 2026-08-05
// (scripts/probe-moysklad-syncid.mjs):
//   1. Точный поиск заказа при неизвестном исходе: filter=syncId=<uuid>
//      работает, вместо угадывания по описанию.
//   2. Идемпотентность на стороне МойСклада: повторный POST с тем же syncId
//      ОБНОВЛЯЕТ существующий заказ и возвращает его id, а не создаёт второй.
//      То есть дубль невозможен даже если наша защита почему-то не сработает.
// Код всё равно не закладывается на (2) как на единственную линию обороны:
// журнал и поиск по syncId работают самостоятельно.
export function buildPurchaseOrderSyncId({ draftId, groupHash } = {}) {
  if (!draftId || !groupHash) return null;
  return buildDeterministicUuid(V_AMBER_UUID_NAMESPACE, `purchase-order::${draftId}::${groupHash}`);
}

// Отпечаток состава закупочного заказа: товар + количество + цена, независимо
// от порядка позиций. Нужен сверке — у закупочного заказа нет технической метки
// в description, и опознать «тот самый заказ» можно только по содержимому.
// Цена приводится к целым копейкам: МойСклад возвращает её именно так, а от
// вызывающего она приходит уже в копейках.
export function buildPurchaseOrderPositionsFingerprint(positions) {
  return (Array.isArray(positions) ? positions : [])
    .map((p) => [
      p?.productId || "",
      normalizeQuantity(p?.quantity),
      Math.round(Number(p?.price) || 0),
    ].join(":"))
    .sort()
    .join("|");
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
  };
}
