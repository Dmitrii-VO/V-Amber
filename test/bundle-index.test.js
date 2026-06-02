import { test } from "node:test";
import assert from "node:assert/strict";

import { generateIndexMd } from "../server/bundle-index.js";

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("bundle index counts accepted reservations from finalized statuses", () => {
  const content = jsonl([
    { ts: "2026-06-01T10:00:00.000Z", kind: "session_started" },
    { ts: "2026-06-01T10:00:01.000Z", kind: "reservation_detected", commentId: 1 },
    { ts: "2026-06-01T10:00:02.000Z", kind: "reservation_finalized", commentId: 1, status: "out_of_stock" },
    { ts: "2026-06-01T10:00:03.000Z", kind: "reservation_detected", commentId: 2 },
    { ts: "2026-06-01T10:00:04.000Z", kind: "reservation_finalized", commentId: 2, status: "reserved" },
    { ts: "2026-06-01T10:00:05.000Z", kind: "session_ended", reason: "stream_stop" },
  ]);

  const index = generateIndexMd({
    sessions: [{ name: "sessions/test.jsonl", content }],
    generatedAt: "2026-06-01T10:00:06.000Z",
  });

  assert.match(index, /\*\*Броней принято:\*\* 1/);
  assert.match(index, /\*\*Комментариев с бронью распознано:\*\* 2/);
});

test("bundle index does not count a reservation that was later cancelled", () => {
  // reservation_finalized — append-only: бронь сперва reserved, затем при
  // отмене оператором финализируется повторно как cancelled с тем же
  // lotSessionId+commentId+viewerId+positionId. Должна считаться по
  // ПОСЛЕДНЕМУ статусу — то есть НЕ попадать в «принято».
  const content = jsonl([
    { ts: "2026-06-01T10:00:00.000Z", kind: "session_started" },
    // Бронь A: reserved и осталась.
    { ts: "2026-06-01T10:00:01.000Z", kind: "reservation_detected", commentId: 1 },
    { ts: "2026-06-01T10:00:02.000Z", kind: "reservation_finalized", lotSessionId: "lot-1", commentId: 1, viewerId: 5001, positionId: "pos-A", status: "reserved" },
    // Бронь B: reserved → затем отменена.
    { ts: "2026-06-01T10:00:03.000Z", kind: "reservation_detected", commentId: 2 },
    { ts: "2026-06-01T10:00:04.000Z", kind: "reservation_finalized", lotSessionId: "lot-1", commentId: 2, viewerId: 5002, positionId: "pos-B", status: "reserved" },
    { ts: "2026-06-01T10:00:05.000Z", kind: "reservation_finalized", lotSessionId: "lot-1", commentId: 2, viewerId: 5002, positionId: "pos-B", status: "cancelled", reason: "operator_cancelled" },
    { ts: "2026-06-01T10:00:06.000Z", kind: "session_ended", reason: "stream_stop" },
  ]);

  const index = generateIndexMd({
    sessions: [{ name: "sessions/cancel.jsonl", content }],
    generatedAt: "2026-06-01T10:00:07.000Z",
  });

  // Только бронь A осталась принятой; распознано 2 комментария.
  assert.match(index, /\*\*Броней принято:\*\* 1/);
  assert.match(index, /\*\*Комментариев с бронью распознано:\*\* 2/);
});

test("bundle index keeps an appended position counted when only one of two is cancelled", () => {
  // Один зритель: исходная позиция + дописанная голосом (тот же commentId,
  // разный positionId). Отмена дописанной не должна снимать исходную.
  const content = jsonl([
    { ts: "2026-06-01T10:00:00.000Z", kind: "session_started" },
    { ts: "2026-06-01T10:00:01.000Z", kind: "reservation_detected", commentId: 1 },
    { ts: "2026-06-01T10:00:02.000Z", kind: "reservation_finalized", lotSessionId: "lot-1", commentId: 1, viewerId: 5001, positionId: "pos-A", status: "reserved" },
    { ts: "2026-06-01T10:00:03.000Z", kind: "reservation_finalized", lotSessionId: "lot-1", commentId: 1, viewerId: 5001, positionId: "pos-B", status: "reserved_appended" },
    { ts: "2026-06-01T10:00:04.000Z", kind: "reservation_finalized", lotSessionId: "lot-1", commentId: 1, viewerId: 5001, positionId: "pos-B", status: "cancelled", reason: "operator_cancelled" },
    { ts: "2026-06-01T10:00:05.000Z", kind: "session_ended", reason: "stream_stop" },
  ]);

  const index = generateIndexMd({
    sessions: [{ name: "sessions/append-cancel.jsonl", content }],
    generatedAt: "2026-06-01T10:00:06.000Z",
  });

  // Исходная (pos-A) осталась, дописанная (pos-B) отменена → принято 1.
  assert.match(index, /\*\*Броней принято:\*\* 1/);
});

test("bundle index falls back to legacy reservation_accepted when no final statuses exist", () => {
  const content = jsonl([
    { ts: "2026-06-01T10:00:00.000Z", kind: "session_started" },
    { ts: "2026-06-01T10:00:01.000Z", kind: "reservation_accepted", commentId: 1 },
    { ts: "2026-06-01T10:00:02.000Z", kind: "session_ended", reason: "stream_stop" },
  ]);

  const index = generateIndexMd({
    sessions: [{ name: "sessions/legacy.jsonl", content }],
    generatedAt: "2026-06-01T10:00:03.000Z",
  });

  assert.match(index, /\*\*Броней принято:\*\* 1/);
});
