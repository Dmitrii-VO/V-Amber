// Разбор после эфира: строки «требует внимания», пережившие сам эфир.
//
// Зачем. Строка возникает, когда покупатель написал код, а однозначного
// открытого лота под него нет — лот закрылся раньше, был в другой день
// кампании, или код подошёл нескольким лотам сразу. До сих пор она жила
// только в баннере дашборда во время эфира и умирала вместе с сессией.
// По логам 13 эфиров этим не воспользовались НИ РАЗУ: attention-строк было
// 6488, а броней из них создано 0. Причина не в баннере — во время эфира
// оператор держит телефон как камеру и в ноутбук не смотрит, поэтому любой
// механизм «система заметила → человек посмотрит и нажмёт» превращается в
// «ничего не произошло».
//
// Поэтому строки теперь переживают эфир и разбираются ПОСЛЕ него, когда
// глаза и руки у оператора свободны.
//
// Модель — append-only JSONL, как blocked-viewers-store.js: создание и разбор
// дописываются строками, load() сворачивает к «последняя запись на id
// побеждает». PII: файл содержит имена зрителей и тексты комментариев и в
// sendLogs-бандл не включается (см. server/log-bundle.js).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "./logger.js";
import { appendJsonlLines, readJsonlRecords } from "./jsonl-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(__dirname, "..", "logs", "attention.jsonl");
const SCHEMA_VERSION = 1;

// Сколько дней строка остаётся в списке разбора. Кампания эфиров — несколько
// дней подряд (campaignMaxGapDays = 3), плюс запас на «разберу на выходных».
// Дальше бронь по строке всё равно уедет в новый заказ, а не в кампанийный.
const DEFAULT_RETENTION_DAYS = 14;

export function createAttentionStore({
  filePath = DEFAULT_FILE,
  retentionDays = DEFAULT_RETENTION_DAYS,
} = {}) {
  // id → строка разбора
  const rows = new Map();
  let writeChain = Promise.resolve();
  let loaded = false;
  let nextLocalId = 1;

  function applyRecord(record) {
    if (!record?.id) return;
    if (record.kind === "attention") {
      rows.set(record.id, {
        id: record.id,
        createdAt: record.ts || new Date().toISOString(),
        code: String(record.code || ""),
        originalCode: record.originalCode || null,
        viewerId: record.viewerId ?? null,
        viewerName: String(record.viewerName || ""),
        commentId: record.commentId ?? null,
        text: String(record.text || ""),
        quantity: Math.max(1, Number(record.quantity) || 1),
        source: record.source || "vk",
        reason: record.reason || "no_open_lot",
        // Строку можно превратить в бронь только когда код однозначно
        // разрешился в каталоге. При ambiguous выбирать товар за оператора
        // в денежном пути нельзя — такие идут в разбор «на посмотреть».
        bookable: record.bookable === true,
        status: "open",
        resolvedAt: null,
        resolution: null,
      });
      return;
    }
    if (record.kind === "resolved") {
      const row = rows.get(record.id);
      if (!row) return;
      row.status = record.status || "dismissed";
      row.resolvedAt = record.ts || new Date().toISOString();
      row.resolution = record.resolution || null;
    }
  }

  function persist(record) {
    applyRecord(record);
    writeChain = writeChain
      .then(() => appendJsonlLines(filePath, record))
      .catch((error) => logger.warn("attention-store", "append_failed", { error }));
  }

  function isFresh(row) {
    const createdAt = Date.parse(row.createdAt);
    if (!Number.isFinite(createdAt)) return true;
    return Date.now() - createdAt <= retentionDays * 24 * 3600_000;
  }

  return {
    async load() {
      if (loaded) return;
      loaded = true;
      await readJsonlRecords(filePath, "attention-store", applyRecord);
      const open = [...rows.values()].filter((row) => row.status === "open" && isFresh(row));
      if (open.length > 0) {
        logger.info("attention-store", "loaded", { open: open.length, total: rows.size });
      }
    },

    // Возвращает id созданной строки — он же ложится в WS-сообщение оператору,
    // чтобы клик по живому баннеру и клик в разборе после эфира вели в одну
    // и ту же строку, а не создавали две записи об одном покупателе.
    add({ code, originalCode, viewerId, viewerName, commentId, text, quantity, source, reason, bookable }) {
      const id = `att-${Date.now()}-${nextLocalId++}`;
      persist({
        v: SCHEMA_VERSION,
        kind: "attention",
        id,
        ts: new Date().toISOString(),
        code,
        originalCode: originalCode || null,
        viewerId: viewerId ?? null,
        viewerName: viewerName || "",
        text: typeof text === "string" ? text.slice(0, 200) : "",
        commentId: commentId ?? null,
        quantity: Math.max(1, Number(quantity) || 1),
        source: source || "vk",
        reason: reason || "no_open_lot",
        bookable: bookable === true,
      });
      return id;
    },

    get(id) {
      const row = rows.get(String(id || ""));
      return row && row.status === "open" ? row : null;
    },

    // Разбор: строка ушла в бронь либо снята оператором. Идемпотентно —
    // повторный разбор уже разобранной строки ничего не портит.
    resolve(id, { status = "dismissed", resolution = null } = {}) {
      const row = rows.get(String(id || ""));
      if (!row || row.status !== "open") return false;
      persist({
        v: SCHEMA_VERSION,
        kind: "resolved",
        id: row.id,
        ts: new Date().toISOString(),
        status,
        resolution,
      });
      return true;
    },

    list({ includeResolved = false } = {}) {
      return [...rows.values()]
        .filter((row) => isFresh(row) && (includeResolved || row.status === "open"))
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    },

    openCount() {
      return [...rows.values()].filter((row) => row.status === "open" && isFresh(row)).length;
    },

    async flush() {
      await writeChain;
    },
  };
}
