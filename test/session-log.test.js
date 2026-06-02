import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";

import { createSessionLog } from "../server/session-log.js";

async function cleanup(paths) {
  await Promise.all(paths.filter(Boolean).map((path) => rm(path, { force: true }).catch(() => {})));
}

test("session log creates unique files for rapid restarts", async () => {
  const first = createSessionLog();
  first.logSessionStart({ connectionId: "conn-a" });
  const firstMd = first.getFilePath();
  const firstJsonl = first.getJsonl().getFilePath();
  await first.flush();

  const second = createSessionLog();
  second.logSessionStart({ connectionId: "conn-b" });
  const secondMd = second.getFilePath();
  const secondJsonl = second.getJsonl().getFilePath();
  await second.flush();

  try {
    assert.notEqual(firstMd, secondMd);
    assert.notEqual(firstJsonl, secondJsonl);
  } finally {
    await cleanup([firstMd, firstJsonl, secondMd, secondJsonl]);
  }
});

test("session JSONL carries connection id and final reservation status", async () => {
  const log = createSessionLog();
  log.logSessionStart({ connectionId: "conn-jsonl" });
  const mdPath = log.getFilePath();
  const jsonlPath = log.getJsonl().getFilePath();

  log.logReservationDetected({ lotSessionId: "lot-1", code: "03204", commentId: 101, status: "pending_reservation" });
  log.logReservationFinalized({ lotSessionId: "lot-1", code: "03204", commentId: 101, status: "reserved", orderId: "co-1" });
  log.logSessionEnd({ reason: "stream_stop" });
  await log.flush();

  try {
    const records = (await readFile(jsonlPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    assert.ok(records.some((record) => record.kind === "reservation_detected"));
    const finalized = records.find((record) => record.kind === "reservation_finalized");
    assert.equal(finalized.connectionId, "conn-jsonl");
    assert.equal(finalized.status, "reserved");
    assert.equal(finalized.orderId, "co-1");
    assert.equal(records.at(-1).kind, "session_ended");
    assert.equal(records.at(-1).connectionId, "conn-jsonl");
  } finally {
    await cleanup([mdPath, jsonlPath]);
  }
});
