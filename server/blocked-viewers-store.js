// Чёрный список зрителей: viewerId → блокировка.
//
// Зачем: спамеры в комментариях эфира. Заблокированный зритель полностью
// исчезает из обработки — его комментарии не становятся бронями, не
// попадают в wishlist, не поднимают reservationAttention и не пишутся в
// имя-кеш. Фильтр стоит в самом начале ingestViewerComment (ws-server.js),
// то есть до парсинга, поэтому спам физически не может создать бронь.
//
// Блокировка «мягкая»: это фильтр на стороне V-Amber, а НЕ бан в
// VK-сообществе (groups.ban). Спамер продолжает писать в VK и видит свои
// комментарии — просто оператор их больше не обрабатывает. Так выбрано
// сознательно: действие обратимо, не требует прав на управление
// сообществом и не бьёт по случайно заблокированному покупателю. Если
// понадобится настоящий бан в VK — это отдельный слой поверх этого стора.
//
// Модель — append-only JSONL, как server/name-cache-store.js: блокировка и
// разблокировка дописываются строками, load() на старте сворачивает к
// «последняя запись на viewerId побеждает». PII: logs/blocked-viewers.jsonl
// содержит имена зрителей и НЕ включается в sendLogs-бандл — см.
// server/log-bundle.js.

import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(__dirname, "..", "logs", "blocked-viewers.jsonl");
const SCHEMA_VERSION = 1;

export function createBlockedViewersStore({ filePath = DEFAULT_FILE } = {}) {
  // viewerId(string) → { viewerId, name, reason, blockedAt, blockedBy }
  const blocked = new Map();
  let writeChain = Promise.resolve();
  let loaded = false;

  async function appendLine(record) {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
  }

  function applyRecord(record) {
    if (!record || record.viewerId == null) return;
    const key = String(record.viewerId);
    if (record.kind === "block") {
      blocked.set(key, {
        viewerId: record.viewerId,
        name: String(record.name || "").trim(),
        reason: String(record.reason || "").trim(),
        blockedAt: record.ts || new Date().toISOString(),
        blockedBy: record.blockedBy || "operator",
      });
      return;
    }
    if (record.kind === "unblock") {
      blocked.delete(key);
    }
  }

  function persist(record) {
    applyRecord(record);
    writeChain = writeChain
      .then(() => appendLine(record))
      .catch((error) => logger.warn("blocked-viewers-store", "append_failed", { error }));
  }

  return {
    async load() {
      if (loaded) return;
      loaded = true;
      if (!existsSync(filePath)) return;
      try {
        const stream = createReadStream(filePath, { encoding: "utf8" });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            applyRecord(JSON.parse(trimmed));
          } catch (err) {
            logger.warn("blocked-viewers-store", "skip_bad_line", { error: err?.message || String(err) });
          }
        }
      } catch (error) {
        logger.warn("blocked-viewers-store", "load_failed", { error });
      }
      if (blocked.size > 0) {
        logger.info("blocked-viewers-store", "loaded", { count: blocked.size });
      }
    },

    isBlocked(viewerId) {
      if (viewerId == null) return false;
      return blocked.has(String(viewerId));
    },

    get(viewerId) {
      if (viewerId == null) return null;
      return blocked.get(String(viewerId)) || null;
    },

    // Блокировка идемпотентна: повторный вызов обновляет причину/имя, но не
    // сдвигает blockedAt — оператор видит, когда спамер попал в список
    // впервые.
    block(viewerId, { name = "", reason = "", blockedBy = "operator" } = {}) {
      if (viewerId == null || viewerId === "") return null;
      const key = String(viewerId);
      const previous = blocked.get(key);
      const record = {
        v: SCHEMA_VERSION,
        kind: "block",
        ts: previous?.blockedAt || new Date().toISOString(),
        viewerId,
        name: String(name || previous?.name || "").trim(),
        reason: String(reason || previous?.reason || "").trim(),
        blockedBy,
      };
      persist(record);
      return blocked.get(key);
    },

    unblock(viewerId) {
      if (viewerId == null) return false;
      const key = String(viewerId);
      if (!blocked.has(key)) return false;
      persist({
        v: SCHEMA_VERSION,
        kind: "unblock",
        ts: new Date().toISOString(),
        viewerId,
      });
      return true;
    },

    // Свежие блокировки сверху — оператору в списке нужнее последние.
    list() {
      return [...blocked.values()].sort((left, right) =>
        String(right.blockedAt).localeCompare(String(left.blockedAt)));
    },

    size() {
      return blocked.size;
    },

    async flush() {
      try { await writeChain; } catch { /* logged inside */ }
    },
  };
}
