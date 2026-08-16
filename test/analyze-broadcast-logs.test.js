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

// Секция [8] — замер, которым сравнивают эфиры до и после правки тормозов
// (knowledge/wiki/broadcast-slowdown.md). Отдельно ловим главный регресс:
// снимок состояния, который пишут не по таймеру, а на каждое изменение лота.
test("analyzer reports interface load per bucket and flags snapshot storms", async () => {
  const root = await mkdtemp(join(tmpdir(), "vamber-analyzer-load-"));
  const sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);

  const at = (minutes, seconds = 0) =>
    new Date(Date.UTC(2026, 7, 4, 10, minutes, seconds)).toISOString();
  const events = [
    { ts: at(0), kind: "session_started" },
    { ts: at(0, 1), kind: "transcript_final", text: "первая", latencyMs: 900 },
    { ts: at(1), kind: "transcript_partial", text: "втор" },
    { ts: at(1, 30), kind: "transcript_final", text: "вторая", latencyMs: 1100 },
    { ts: at(2), kind: "moysklad_call", durationMs: 200 },
    // 60 снимков в первой корзине — вдвое чаще, чем даёт таймер 30 с.
    ...Array.from({ length: 60 }, (_, i) => ({
      ts: at(3, i), kind: "state_snapshot",
      openLots: [{ code: "03820" }, { code: "03821" }],
    })),
    // Вторая корзина: снимков мало, зато лотов больше.
    { ts: at(20), kind: "transcript_final", text: "третья", latencyMs: 1000 },
    {
      ts: at(21), kind: "state_snapshot",
      openLots: [{ code: "03820" }, { code: "03821" }, { code: "03822" }],
    },
    { ts: at(25), kind: "session_ended", reason: "stream_stop" },
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

    assert.equal(report.load.bucketMinutes, 15);
    assert.equal(report.load.buckets.length, 2);

    const [first, second] = report.load.buckets;
    assert.equal(first.partials, 1);
    assert.equal(first.finals, 2);
    assert.equal(first.transcriptLines, 2);
    assert.equal(first.openLots, 2);
    assert.equal(first.snapshots, 60);
    assert.equal(first.sttP50, 1100);
    assert.equal(first.moyskladP50, 200);

    // Длина ленты накопительная: она и есть множитель старой перерисовки.
    assert.equal(second.transcriptLines, 3);
    assert.equal(second.openLots, 3);
    assert.equal(second.snapshots, 1);

    assert.ok(
      report.flags.some((f) => f.includes("state_snapshot")),
      "частые снимки должны стать красным флагом",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Без --date первый позиционный аргумент раньше молча выпадал из разбора:
// одиночный файл не запускался вовсе, из глоба терялась первая сессия.
test("analyzer accepts a bundle path without --date", async () => {
  const root = await mkdtemp(join(tmpdir(), "vamber-analyzer-nodate-"));
  const sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir);
  const events = [
    { ts: "2026-08-04T10:00:00.000Z", kind: "session_started" },
    { ts: "2026-08-04T10:00:01.000Z", kind: "lot_opened", code: "03820", availableStock: 3 },
    { ts: "2026-08-04T10:00:02.000Z", kind: "session_ended", reason: "stream_stop" },
  ];
  await writeFile(
    join(sessionsDir, "2026-08-04_10-00-00.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  try {
    const result = spawnSync(
      process.execPath,
      ["scripts/analyze-broadcast-logs.mjs", root, "--json"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const report = JSON.parse(result.stdout);
    assert.equal(report.sessions, 1);
    assert.equal(report.events, events.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
