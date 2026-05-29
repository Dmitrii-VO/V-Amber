import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBasicAuthHeader,
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
} from "../server/moysklad-helpers.js";

test("buildBasicAuthHeader encodes login:password as base64", () => {
  const header = buildBasicAuthHeader("user", "pass");
  assert.equal(header, `Basic ${Buffer.from("user:pass").toString("base64")}`);
});

test("getAuthHeader returns Basic when both login and password set", () => {
  assert.match(getAuthHeader({ login: "u", password: "p" }), /^Basic /);
});

test("getAuthHeader returns empty string when credentials are missing", () => {
  assert.equal(getAuthHeader({}), "");
  assert.equal(getAuthHeader({ login: "u" }), "");
  assert.equal(getAuthHeader({ password: "p" }), "");
});

test("buildApiUrl joins base and path correctly", () => {
  const url = buildApiUrl("https://api.example.com/api/v1", "entity/product", {});
  // Implementation appends a trailing slash to the base before resolving,
  // so the path is treated as a child of /api/v1/ rather than replacing v1.
  assert.equal(url.toString(), "https://api.example.com/api/v1/entity/product");
});

test("buildApiUrl handles trailing slash on base", () => {
  const url = buildApiUrl("https://api.example.com/api/v1/", "entity/product", {});
  assert.equal(url.toString(), "https://api.example.com/api/v1/entity/product");
});

test("buildApiUrl appends defined search params", () => {
  const url = buildApiUrl("https://api.example.com/", "entity/product", {
    limit: 100,
    offset: 0,
    filter: "name=foo",
  });
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.get("offset"), "0");
  assert.equal(url.searchParams.get("filter"), "name=foo");
});

test("buildApiUrl skips undefined, null, and empty-string params", () => {
  const url = buildApiUrl("https://api.example.com/", "entity/product", {
    a: undefined,
    b: null,
    c: "",
    d: "x",
  });
  assert.equal(url.searchParams.has("a"), false);
  assert.equal(url.searchParams.has("b"), false);
  assert.equal(url.searchParams.has("c"), false);
  assert.equal(url.searchParams.get("d"), "x");
});

test("normalizeMoney divides minor units by 100", () => {
  assert.equal(normalizeMoney(10000), 100);
  assert.equal(normalizeMoney(0), 0);
});

test("normalizeMoney returns null for non-numeric input", () => {
  assert.equal(normalizeMoney(null), null);
  assert.equal(normalizeMoney(undefined), null);
  assert.equal(normalizeMoney("100"), null);
});

test("normalizeQuantity returns finite number or 0", () => {
  assert.equal(normalizeQuantity(5), 5);
  assert.equal(normalizeQuantity("3"), 3);
  assert.equal(normalizeQuantity("abc"), 0);
  assert.equal(normalizeQuantity(null), 0);
  assert.equal(normalizeQuantity(undefined), 0);
});

test("toMinorUnits multiplies by 100 and rounds", () => {
  assert.equal(toMinorUnits(99.99), 9999);
  assert.equal(toMinorUnits(0), 0);
  // 1.5 → 150; IEEE-754 makes the 1.005 case unstable (1.005 * 100 ≈ 100.499…)
  // so we test a less hostile value.
  assert.equal(toMinorUnits(1.5), 150);
});

test("toMinorUnits returns 0 for non-numeric", () => {
  assert.equal(toMinorUnits(null), 0);
  assert.equal(toMinorUnits("10"), 0);
});

test("getEffectiveSalePrice prefers productCard.salePrice", () => {
  assert.equal(
    getEffectiveSalePrice(
      { product: { salePrice: 100, voicePrice: 200 } },
      { salePrice: 50 },
    ),
    50,
  );
});

test("getEffectiveSalePrice falls back to activeLot.product.salePrice", () => {
  assert.equal(
    getEffectiveSalePrice({ product: { salePrice: 100 } }, null),
    100,
  );
});

test("getEffectiveSalePrice falls back to voicePrice when salePrice unusable", () => {
  assert.equal(
    getEffectiveSalePrice({ product: { salePrice: 0, voicePrice: 250 } }, null),
    250,
  );
});

test("extractEntityIdFromHref parses /entity/<name>/<uuid>", () => {
  const href = "https://api.moysklad.ru/api/remap/1.2/entity/product/abc-123-def";
  assert.equal(extractEntityIdFromHref(href, "product"), "abc-123-def");
});

test("extractEntityIdFromHref returns null for non-matching entity", () => {
  const href = "https://api.moysklad.ru/api/remap/1.2/entity/product/abc-123";
  assert.equal(extractEntityIdFromHref(href, "customerorder"), null);
});

test("extractEntityIdFromHref returns null for empty href", () => {
  assert.equal(extractEntityIdFromHref("", "product"), null);
  assert.equal(extractEntityIdFromHref(null, "product"), null);
});

test("extractViewerIdFromText parses 'viewerId=<digits>'", () => {
  assert.equal(extractViewerIdFromText("VK comment, viewerId=12345"), "12345");
  assert.equal(extractViewerIdFromText("viewerId = 999"), "999");
});

test("extractViewerIdFromText returns null when missing", () => {
  assert.equal(extractViewerIdFromText("no viewer here"), null);
  assert.equal(extractViewerIdFromText(""), null);
  assert.equal(extractViewerIdFromText(null), null);
});

test("formatBroadcastDate formats Date to YYYY-MM-DD local", () => {
  const out = formatBroadcastDate(new Date(2026, 4, 5));
  assert.equal(out, "2026-05-05");
});

test("formatBroadcastDate falls back to today for invalid input", () => {
  const out = formatBroadcastDate("not a date");
  assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
});

test("formatBroadcastDate uses now() when called without args", () => {
  const out = formatBroadcastDate();
  assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
});

test("buildBroadcastMarker prepends '#Эфир '", () => {
  assert.equal(
    buildBroadcastMarker(new Date(2026, 4, 5)),
    "#Эфир 2026-05-05",
  );
});

test("buildEntityMeta produces a MoySklad-shaped meta object", () => {
  const meta = buildEntityMeta("https://api.moysklad.ru/api/remap/1.2", "product", "uuid-1");
  assert.equal(meta.meta.href, "https://api.moysklad.ru/api/remap/1.2/entity/product/uuid-1");
  assert.equal(meta.meta.type, "product");
  assert.equal(meta.meta.mediaType, "application/json");
});

test("buildEntityMeta strips trailing slash from baseUrl", () => {
  const meta = buildEntityMeta("https://api.moysklad.ru/api/remap/1.2/", "product", "id");
  assert.equal(meta.meta.href, "https://api.moysklad.ru/api/remap/1.2/entity/product/id");
});

test("buildProductSnapshot prefers stockRow salePrice over product.salePrices", () => {
  const snap = buildProductSnapshot(
    { id: "p1", code: "C", name: "N", salePrices: [{ value: 5000 }] },
    { salePrice: 9900 },
  );
  assert.equal(snap.salePrice, 99); // 9900 / 100
});

test("buildProductSnapshot falls back to product.salePrices[0]", () => {
  const snap = buildProductSnapshot(
    { id: "p1", code: "C", name: "N", salePrices: [{ value: 5000 }] },
    null,
  );
  assert.equal(snap.salePrice, 50);
});

test("buildProductSnapshot derives availableStock = stock - reserve when quantity missing", () => {
  const snap = buildProductSnapshot(
    { id: "p1", code: "C", name: "N" },
    { stock: 10, reserve: 3 },
  );
  assert.equal(snap.stock, 10);
  assert.equal(snap.reserve, 3);
  assert.equal(snap.availableStock, 7);
});

test("buildProductSnapshot uses quantity directly when present", () => {
  const snap = buildProductSnapshot(
    { id: "p1", code: "C", name: "N" },
    { stock: 10, reserve: 3, quantity: 5 },
  );
  assert.equal(snap.availableStock, 5);
});

test("buildProductSnapshot defaults imageFilename to 'product.jpg'", () => {
  const snap = buildProductSnapshot({ id: "p1", code: "C", name: "N" }, {});
  assert.equal(snap.imageFilename, "product.jpg");
  assert.equal(snap.imageHref, "");
});

test("buildProductSnapshot falls back pathName to stockRow.folder.name", () => {
  const snap = buildProductSnapshot(
    { id: "p1", code: "C", name: "N" },
    { folder: { name: "Каталог/Подкатегория" } },
  );
  assert.equal(snap.pathName, "Каталог/Подкатегория");
});
