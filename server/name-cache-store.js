// Персистентный кеш имён зрителей VK: viewerId → имя.
//
// Зачем: голосовая отмена брони (W3) сопоставляет произнесённое оператором
// имя с зрителями. In-memory состояние лота и customerOrdersByViewerId
// стираются на закрытии сокета (см. ws-server.js), а брони после рестарта
// не поднимаются автоматически — поэтому после стоп/старт эфира резолвить
// имя не из чего. Этот кеш переживает стоп/старт эфира и рестарт процесса
// и копит имена между эфирами, узнавая постоянных покупателей сразу.
//
// Модель — append-only JSONL, как server/wishlist-store.js: каждое
// резолвнутое VK-имя дописывается строкой; load() на старте сворачивает к
// «последнее имя на viewerId». PII: logs/viewer-names.jsonl НЕ включается в
// sendLogs-бандл (см. server/log-bundle.js). См. knowledge/wiki/
// operator-feedback.md (W3).

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "./logger.js";
import { appendJsonlLines, readJsonlRecords } from "./jsonl-store.js";
import { normalizeName } from "./name-matcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(__dirname, "..", "logs", "viewer-names.jsonl");
const SCHEMA_VERSION = 1;

export function createNameCacheStore({ filePath = DEFAULT_FILE } = {}) {
  // viewerId(string) → { viewerId, name, normalized, updatedAt }
  const byViewerId = new Map();
  let writeChain = Promise.resolve();
  let loaded = false;

  function applyRecord(record) {
    if (!record || record.kind !== "name" || record.viewerId == null) return;
    const name = String(record.name || "").trim();
    if (!name) return;
    const key = String(record.viewerId);
    const prev = byViewerId.get(key);
    // Последняя запись побеждает (load идёт по порядку файла; runtime-update
    // тоже монотонен по времени).
    if (prev && prev.updatedAt && record.ts && prev.updatedAt > record.ts) return;
    byViewerId.set(key, {
      viewerId: record.viewerId,
      name,
      normalized: normalizeName(name),
      updatedAt: record.ts || new Date().toISOString(),
    });
  }

  return {
    async load() {
      if (loaded) return;
      loaded = true;
      await readJsonlRecords(filePath, "name-cache-store", applyRecord);
    },

    // Запоминаем имя зрителя. No-op, если имя пустое или не изменилось —
    // чтобы не раздувать файл одинаковыми строками на каждый комментарий.
    remember(viewerId, name) {
      if (viewerId == null) return;
      const clean = String(name || "").trim();
      if (!clean) return;
      const key = String(viewerId);
      const prev = byViewerId.get(key);
      if (prev && prev.name === clean) return;

      const record = {
        v: SCHEMA_VERSION,
        kind: "name",
        ts: new Date().toISOString(),
        viewerId,
        name: clean,
      };
      applyRecord(record);
      writeChain = writeChain
        .then(() => appendJsonlLines(filePath, record))
        .catch((error) => logger.warn("name-cache-store", "append_failed", { error }));
    },

    getName(viewerId) {
      return byViewerId.get(String(viewerId))?.name || null;
    },

    // Список { viewerId, name } для матчера. Можно сузить набором id
    // (например, только зрители с активной бронью текущего лота).
    list(viewerIds = null) {
      if (!viewerIds) {
        return [...byViewerId.values()].map((e) => ({ viewerId: e.viewerId, name: e.name }));
      }
      const wanted = new Set([...viewerIds].map((id) => String(id)));
      const out = [];
      for (const [key, entry] of byViewerId) {
        if (wanted.has(key)) out.push({ viewerId: entry.viewerId, name: entry.name });
      }
      return out;
    },

    size() {
      return byViewerId.size;
    },

    async flush() {
      try { await writeChain; } catch { /* logged inside */ }
    },
  };
}
