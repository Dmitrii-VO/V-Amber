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
