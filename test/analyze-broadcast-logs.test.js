import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("analyzer deduplicates orphan audit events and reports close migrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "vamber-analyzer-"));
  const sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);

  const events = [
    { ts: "2026-08-04T10:00:00.000Z", kind: "session_started" },
    { ts: "2026-08-04T10:00:01.000Z", kind: "reservation_waitlist_pending", lotSessionId: "lot-1", lotCode: "03820", commentId: 11, viewerId: 101 },
    { ts: "2026-08-04T10:00:01.500Z", kind: "reservation_waitlist_pending", lotSessionId: "lot-1", lotCode: "03820", commentId: 12, viewerId: 102 },
    { ts: "2026-08-04T10:00:02.000Z", kind: "waitlist_migrated_to_wishlist", lotSessionId: "lot-1", lotCode: "03820", count: 1, entries: [{ commentId: 11, viewerId: 101 }] },
    { ts: "2026-08-04T10:00:03.000Z", kind: "orphan_waitlist", lotSessionId: "lot-1", lotCode: "03820", entries: [{ commentId: 11, viewerId: 101 }] },
    { ts: "2026-08-04T10:00:04.000Z", kind: "orphan_waitlist", lotSessionId: "lot-1", lotCode: "03820", entries: [{ commentId: 11, viewerId: 101 }] },
    { ts: "2026-08-04T10:00:05.000Z", kind: "session_ended", reason: "stream_stop" },
  ];
  await writeFile(
    join(sessionsDir, "2026-08-04_10-00-00.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  try {
    const result = spawnSync(
      process.execPath,
      ["scripts/analyze-broadcast-logs.mjs", root, "--date", "2026-08-04", "--json"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const report = JSON.parse(result.stdout);

    assert.equal(result.status, 1, "unique orphan remains a health flag");
    assert.deepEqual(report.waitlist, {
      pending: 2,
      promoted: 0,
      migrated: 1,
      legacyMigrated: 0,
      unresolved: 1,
      orphan: 1,
      orphanEvents: 2,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
