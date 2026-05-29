import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getVkPublicationCommentId,
  getVkApiErrorCode,
  formatBroadcastDate,
  normalizeReservationCode,
  createBoundedIdSet,
  addBoundedId,
  hasUsableSalePrice,
  getLotEffectivePrice,
  getReservationReplyMessage,
  getCommittedReservationCount,
  isFatalCommentReadError,
  RESERVATION_HISTORY_LIMIT,
} from "../server/ws-helpers.js";

test("getVkPublicationCommentId extracts numeric id from object or number", () => {
  assert.equal(getVkPublicationCommentId(42), 42);
  assert.equal(getVkPublicationCommentId({ comment_id: 7 }), 7);
  assert.equal(getVkPublicationCommentId({ commentId: 13 }), 13);
  assert.equal(getVkPublicationCommentId({ comment_id: "21" }), 21);
});

test("getVkPublicationCommentId rejects zero / negative / non-numeric", () => {
  assert.equal(getVkPublicationCommentId(0), null);
  assert.equal(getVkPublicationCommentId(-5), null);
  assert.equal(getVkPublicationCommentId({}), null);
  assert.equal(getVkPublicationCommentId(null), null);
  assert.equal(getVkPublicationCommentId({ comment_id: "abc" }), null);
});

test("getVkApiErrorCode reads vkErrorCode property directly", () => {
  assert.equal(getVkApiErrorCode({ vkErrorCode: 15 }), 15);
});

test("getVkApiErrorCode parses 'VK API NNN:' from message", () => {
  assert.equal(getVkApiErrorCode(new Error("VK API 100: Bad params")), 100);
  assert.equal(getVkApiErrorCode("VK API 801: comments closed"), 801);
});

test("getVkApiErrorCode returns null when no code present", () => {
  assert.equal(getVkApiErrorCode(new Error("network failure")), null);
  assert.equal(getVkApiErrorCode(null), null);
});

test("formatBroadcastDate formats Date to YYYY-MM-DD in local TZ", () => {
  const date = new Date(2026, 0, 5); // 5 Jan 2026 local
  assert.equal(formatBroadcastDate(date), "2026-01-05");
});

test("formatBroadcastDate accepts ISO string", () => {
  // Round-trip through new Date — local TZ. Use a date with day padding.
  const out = formatBroadcastDate("2026-03-09T12:00:00");
  assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
});

test("normalizeReservationCode trims and stringifies", () => {
  assert.equal(normalizeReservationCode("  abc "), "abc");
  assert.equal(normalizeReservationCode(123), "123");
  assert.equal(normalizeReservationCode(null), "");
  assert.equal(normalizeReservationCode(undefined), "");
});

test("createBoundedIdSet caps initial size at RESERVATION_HISTORY_LIMIT", () => {
  const oversized = Array.from({ length: RESERVATION_HISTORY_LIMIT + 50 }, (_, i) => i);
  const set = createBoundedIdSet(oversized);
  assert.equal(set.size, RESERVATION_HISTORY_LIMIT);
  // Oldest entries removed first.
  assert.equal(set.has(0), false);
  assert.equal(set.has(RESERVATION_HISTORY_LIMIT + 49), true);
});

test("createBoundedIdSet accepts non-array (returns empty)", () => {
  assert.equal(createBoundedIdSet(null).size, 0);
  assert.equal(createBoundedIdSet(undefined).size, 0);
});

test("addBoundedId moves existing id to the most-recent position", () => {
  const set = new Set([1, 2, 3]);
  addBoundedId(set, 1);
  // Insertion order is now [2, 3, 1].
  assert.deepEqual([...set], [2, 3, 1]);
});

test("addBoundedId enforces cap by dropping the oldest", () => {
  const set = createBoundedIdSet(
    Array.from({ length: RESERVATION_HISTORY_LIMIT }, (_, i) => i),
  );
  addBoundedId(set, "new");
  assert.equal(set.size, RESERVATION_HISTORY_LIMIT);
  assert.equal(set.has(0), false);
  assert.equal(set.has("new"), true);
});

test("hasUsableSalePrice requires positive finite number", () => {
  assert.equal(hasUsableSalePrice({ salePrice: 100 }), true);
  assert.equal(hasUsableSalePrice({ salePrice: 0 }), false);
  assert.equal(hasUsableSalePrice({ salePrice: -1 }), false);
  assert.equal(hasUsableSalePrice({ salePrice: NaN }), false);
  assert.equal(hasUsableSalePrice({}), false);
  assert.equal(hasUsableSalePrice(null), false);
});

test("getLotEffectivePrice prefers salePrice over voicePrice", () => {
  assert.equal(
    getLotEffectivePrice({ product: { salePrice: 500, voicePrice: 999 } }),
    500,
  );
});

test("getLotEffectivePrice falls back to voicePrice when salePrice is unusable", () => {
  assert.equal(
    getLotEffectivePrice({ product: { salePrice: 0, voicePrice: 250 } }),
    250,
  );
  assert.equal(
    getLotEffectivePrice({ product: { voicePrice: 250 } }),
    250,
  );
});

test("getLotEffectivePrice returns underlying salePrice when neither is usable", () => {
  // Undefined out — matches original behavior (returns lot.product.salePrice).
  assert.equal(getLotEffectivePrice({ product: { salePrice: 0 } }), 0);
});

test("getReservationReplyMessage produces status-specific text", () => {
  assert.match(
    getReservationReplyMessage({ status: "reserved", viewerName: "Анна" }),
    /Анна/,
  );
  assert.match(
    getReservationReplyMessage({ status: "reserved_appended", viewerName: "Боб" }),
    /Боб/,
  );
  assert.match(
    getReservationReplyMessage({ status: "product_not_found" }),
    /не найден/i,
  );
  assert.match(
    getReservationReplyMessage({ status: "waitlist_pending" }),
    /очере/i,
  );
  assert.match(
    getReservationReplyMessage({ status: "order_failed" }),
    /Не удалось/,
  );
});

test("getReservationReplyMessage out_of_stock branches on wishlistEntryId", () => {
  const withEntry = getReservationReplyMessage({
    status: "out_of_stock",
    viewerName: "Аня",
    wishlistEntryId: "entry-1",
  });
  assert.match(withEntry, /Добавили вас в список/);

  const withoutEntry = getReservationReplyMessage({
    status: "out_of_stock",
    viewerName: "Аня",
    lotCode: "03204",
  });
  assert.match(withoutEntry, /СПИСОК 03204/);
});

test("getReservationReplyMessage returns empty for unknown status", () => {
  assert.equal(getReservationReplyMessage({ status: "weird" }), "");
});

test("getCommittedReservationCount clamps negative / missing to 0", () => {
  assert.equal(getCommittedReservationCount({ committedReservationCount: 5 }), 5);
  assert.equal(getCommittedReservationCount({ committedReservationCount: -3 }), 0);
  assert.equal(getCommittedReservationCount({}), 0);
  assert.equal(getCommittedReservationCount(null), 0);
});

test("isFatalCommentReadError returns true for VK codes 15, 100, 801", () => {
  assert.equal(isFatalCommentReadError({ vkErrorCode: 15 }), true);
  assert.equal(isFatalCommentReadError({ vkErrorCode: 100 }), true);
  assert.equal(isFatalCommentReadError({ vkErrorCode: 801 }), true);
});

test("isFatalCommentReadError returns false for recoverable codes (5, etc.)", () => {
  assert.equal(isFatalCommentReadError({ vkErrorCode: 5 }), false);
  assert.equal(isFatalCommentReadError({ vkErrorCode: 6 }), false);
});

test("isFatalCommentReadError matches 'video not found' in message", () => {
  assert.equal(isFatalCommentReadError(new Error("Video not found in API")), true);
});

test("isFatalCommentReadError returns false for plain network errors", () => {
  assert.equal(isFatalCommentReadError(new Error("ECONNRESET")), false);
});
