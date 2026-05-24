import { appendFile, readFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = join(__dirname, "..", "logs", "wishlist.jsonl");

const SCHEMA_VERSION = 1;

const TERMINAL_NON_MIGRATE = new Set(["reserved", "reserved_appended", "safe_mode_logged"]);

function dedupKey(viewerId, productCode) {
  return `${viewerId}::${productCode}`;
}

async function appendLines(lines) {
  if (!lines.length) return;
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, lines.join("\n") + "\n", "utf8");
}

export function createWishlistStore({ onChange } = {}) {
  // Active entries: key (viewerId+code) -> entry object (current state).
  const active = new Map();
  // All entries by id, including archived (consumed/removed).
  const byId = new Map();
  const subscribers = new Set();
  const eventSubscribers = new Set();
  if (typeof onChange === "function") subscribers.add(onChange);

  let writeChain = Promise.resolve();
  let loaded = false;

  function notify() {
    const event = { activeCount: active.size };
    for (const listener of subscribers) {
      try { listener(event); }
      catch (err) { logger.warn("wishlist-store", "on_change_failed", { error: err }); }
    }
  }

  function notifyEvent(record) {
    for (const listener of eventSubscribers) {
      try { listener(record); }
      catch (err) { logger.warn("wishlist-store", "on_event_failed", { error: err }); }
    }
  }

  function applyEvent(record) {
    if (!record || typeof record !== "object" || !record.kind) return;
    switch (record.kind) {
      case "added": {
        const entry = {
          id: record.id,
          viewerId: record.viewerId,
          viewerName: record.viewerName || `id${record.viewerId}`,
          productCode: record.productCode,
          productId: record.productId || null,
          productName: record.productName || "",
          supplierId: record.supplierId || null,
          supplierName: record.supplierName || "",
          buyPrice: typeof record.buyPrice === "number" ? record.buyPrice : null,
          salePrice: typeof record.salePrice === "number" ? record.salePrice : null,
          discountAmount: typeof record.discountAmount === "number" ? record.discountAmount : 0,
          effectivePrice: typeof record.effectivePrice === "number" ? record.effectivePrice : null,
          quantity: typeof record.quantity === "number" ? record.quantity : 1,
          lotCode: record.lotCode || null,
          lotSessionId: record.lotSessionId || null,
          fromCommentId: record.fromCommentId || null,
          trigger: record.trigger || "out_of_stock",
          createdAt: record.ts,
          updatedAt: record.ts,
          seenEvents: [{
            ts: record.ts,
            lotSessionId: record.lotSessionId || null,
            commentId: record.fromCommentId || null,
          }],
          status: "active",
          consumed: null,
        };
        byId.set(entry.id, entry);
        if (entry.viewerId != null && entry.productCode) {
          active.set(dedupKey(entry.viewerId, entry.productCode), entry);
        }
        break;
      }
      case "seen_again": {
        const entry = byId.get(record.entryId);
        if (!entry || entry.status !== "active") return;
        entry.seenEvents.push({
          ts: record.ts,
          lotSessionId: record.lotSessionId || null,
          commentId: record.commentId || null,
        });
        entry.updatedAt = record.ts;
        entry.quantity = entry.seenEvents.length;
        break;
      }
      case "edited": {
        const entry = byId.get(record.entryId);
        if (!entry) return;
        const changes = record.changes || {};
        for (const [key, change] of Object.entries(changes)) {
          if (change && Object.prototype.hasOwnProperty.call(change, "to")) {
            entry[key] = change.to;
          }
        }
        entry.updatedAt = record.ts;
        break;
      }
      case "removed": {
        const entry = byId.get(record.entryId);
        if (!entry) return;
        entry.status = "removed";
        entry.removedAt = record.ts;
        entry.removedReason = record.reason || null;
        if (entry.viewerId != null && entry.productCode) {
          const key = dedupKey(entry.viewerId, entry.productCode);
          if (active.get(key)?.id === entry.id) {
            active.delete(key);
          }
        }
        break;
      }
      case "consumed": {
        const entry = byId.get(record.entryId);
        if (!entry) return;
        entry.status = "consumed";
        entry.consumedAt = record.ts;
        entry.consumed = {
          purchaseOrderId: record.purchaseOrderId || null,
          purchaseOrderName: record.purchaseOrderName || null,
          draftId: record.draftId || null,
          groupHash: record.groupHash || null,
        };
        if (entry.viewerId != null && entry.productCode) {
          const key = dedupKey(entry.viewerId, entry.productCode);
          if (active.get(key)?.id === entry.id) {
            active.delete(key);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  async function write(records) {
    if (!records || records.length === 0) return;
    const lines = records.map((r) => JSON.stringify(r));
    // Сериализуем И мутацию state, И append на диск через одну writeChain.
    // Раньше applyEvent выполнялся синхронно ДО постановки в очередь —
    // при параллельных add/edit/consume in-memory state мог опередить файл,
    // и порядок применения событий не совпадал с порядком записей в JSONL.
    writeChain = writeChain
      .then(async () => {
        records.forEach(applyEvent);
        await appendLines(lines);
      })
      .catch((error) => {
        logger.warn("wishlist-store", "append_failed", { error });
      });
    await writeChain;
    notify();
    // Событийный поток — после успешной записи на диск, чтобы JSONL-эмиттер
    // не выдал событие для записи, которой потом физически не оказалось.
    for (const record of records) notifyEvent(record);
  }

  function buildProductMeta(productMetaInput) {
    const meta = productMetaInput || {};
    return {
      productId: meta.productId || meta.id || null,
      productName: meta.productName || meta.name || "",
      supplierId: meta.supplierId || null,
      supplierName: meta.supplierName || "",
      buyPrice: typeof meta.buyPrice === "number" ? meta.buyPrice : null,
    };
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
            const record = JSON.parse(trimmed);
            applyEvent(record);
          } catch (err) {
            logger.warn("wishlist-store", "skip_bad_line", { error: err?.message || String(err) });
          }
        }
      } catch (error) {
        logger.warn("wishlist-store", "load_failed", { error });
      }
    },

    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },

    subscribeEvents(listener) {
      eventSubscribers.add(listener);
      return () => eventSubscribers.delete(listener);
    },

    // Дождаться завершения всех отложенных append'ов. Используется на
    // закрытии лота / сокета, чтобы гарантировать запись миграции в .jsonl
    // ДО clearActiveState() и потенциального завершения процесса.
    async flush() {
      try { await writeChain; } catch { /* logged inside */ }
    },

    getActiveCount() {
      return active.size;
    },

    listActive() {
      return [...active.values()];
    },

    listArchive() {
      return [...byId.values()].filter((e) => e.status !== "active");
    },

    getById(entryId) {
      return byId.get(entryId) || null;
    },

    listByGroupedSupplier() {
      const groups = new Map();
      for (const entry of active.values()) {
        const key = entry.supplierId || "__no_supplier__";
        if (!groups.has(key)) {
          groups.set(key, {
            supplierId: entry.supplierId || null,
            supplierName: entry.supplierName || (entry.supplierId ? "" : "Без поставщика"),
            entries: [],
          });
        }
        groups.get(key).entries.push(entry);
      }
      return [...groups.values()];
    },

    async addFromOutOfStock({ event, lot, productMeta, trigger = "out_of_stock" }) {
      if (!event || !lot) return null;
      const productCode = lot.code || productMeta?.productCode || "";
      const viewerId = event.viewerId;
      const meta = buildProductMeta({ ...productMeta, productCode });
      if (!productCode || viewerId == null) {
        logger.warn("wishlist-store", "add_skipped_missing_keys", {
          productCode, viewerId,
        });
        return null;
      }

      const key = dedupKey(viewerId, productCode);
      const existing = active.get(key);
      const rawSalePrice = lot?.product?.salePrice ?? lot?.product?.voicePrice ?? null;
      const salePrice = typeof rawSalePrice === "number" && Number.isFinite(rawSalePrice) ? rawSalePrice : null;
      const discountAmount = Number(lot?.discountAmount || 0);
      const effectivePrice = salePrice == null ? null : Math.max(0, salePrice - discountAmount);

      if (existing) {
        const record = {
          v: SCHEMA_VERSION,
          id: randomUUID(),
          kind: "seen_again",
          ts: new Date().toISOString(),
          entryId: existing.id,
          lotSessionId: lot.lotSessionId || null,
          commentId: event.commentId || null,
        };
        await write([record]);
        return existing;
      }

      const record = {
        v: SCHEMA_VERSION,
        id: randomUUID(),
        kind: "added",
        ts: new Date().toISOString(),
        viewerId,
        viewerName: event.viewerName || `id${viewerId}`,
        productCode,
        productId: meta.productId,
        productName: meta.productName,
        supplierId: meta.supplierId,
        supplierName: meta.supplierName,
        buyPrice: meta.buyPrice,
        salePrice,
        discountAmount,
        effectivePrice,
        quantity: 1,
        lotCode: lot.code || null,
        lotSessionId: lot.lotSessionId || null,
        fromCommentId: event.commentId || null,
        trigger,
      };
      await write([record]);
      return byId.get(record.id) || null;
    },

    async addFromWaitlistOnClose({ events, lot, reason, productMetaResolver }) {
      if (!Array.isArray(events) || events.length === 0) return [];
      const records = [];
      const ts = new Date().toISOString();
      const seen = new Set();

      for (const event of events) {
        const code = event?.lotCode || lot?.code || "";
        const viewerId = event?.viewerId;
        if (!code || viewerId == null) continue;
        const key = dedupKey(viewerId, code);
        if (seen.has(key)) continue;
        seen.add(key);
        if (active.has(key)) {
          records.push({
            v: SCHEMA_VERSION,
            id: randomUUID(),
            kind: "seen_again",
            ts,
            entryId: active.get(key).id,
            lotSessionId: lot?.lotSessionId || event?.lotSessionId || null,
            commentId: event?.commentId || null,
          });
          continue;
        }
        const meta = productMetaResolver ? buildProductMeta(productMetaResolver(code)) : buildProductMeta(null);
        const trigger = event?.status === "order_failed" ? "order_failed" : (reason === "crash_recovery" ? "crash_recovery" : "waitlist_close");
        records.push({
          v: SCHEMA_VERSION,
          id: randomUUID(),
          kind: "added",
          ts,
          viewerId,
          viewerName: event?.viewerName || `id${viewerId}`,
          productCode: code,
          productId: meta.productId,
          productName: meta.productName,
          supplierId: meta.supplierId,
          supplierName: meta.supplierName,
          buyPrice: meta.buyPrice,
          quantity: 1,
          lotCode: lot?.code || code,
          lotSessionId: lot?.lotSessionId || event?.lotSessionId || null,
          fromCommentId: event?.commentId || null,
          trigger,
        });
      }

      await write(records);
      return records;
    },

    async addManual({ viewerName, viewerId, productCode, quantity, supplierId, supplierName, buyPrice, productId, productName, lotCode }) {
      if (!productCode) return null;
      const resolvedViewerId = viewerId != null ? viewerId : `manual-${randomUUID().slice(0, 8)}`;
      const record = {
        v: SCHEMA_VERSION,
        id: randomUUID(),
        kind: "added",
        ts: new Date().toISOString(),
        viewerId: resolvedViewerId,
        viewerName: viewerName || "Ручная позиция",
        productCode,
        productId: productId || null,
        productName: productName || "",
        supplierId: supplierId || null,
        supplierName: supplierName || "",
        buyPrice: typeof buyPrice === "number" ? buyPrice : null,
        quantity: typeof quantity === "number" && quantity > 0 ? Math.floor(quantity) : 1,
        lotCode: lotCode || null,
        lotSessionId: null,
        fromCommentId: null,
        trigger: "manual",
      };
      await write([record]);
      return byId.get(record.id) || null;
    },

    async edit(entryId, changes, actor = "operator") {
      const entry = byId.get(entryId);
      if (!entry) return null;
      const allowed = ["quantity", "buyPrice", "supplierId", "supplierName", "productName"];
      const diff = {};
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(changes, key) && changes[key] !== entry[key]) {
          diff[key] = { from: entry[key], to: changes[key] };
        }
      }
      if (Object.keys(diff).length === 0) return entry;
      const record = {
        v: SCHEMA_VERSION,
        id: randomUUID(),
        kind: "edited",
        ts: new Date().toISOString(),
        entryId,
        changes: diff,
        actor,
      };
      await write([record]);
      return byId.get(entryId);
    },

    async remove(entryId, reason = "manual_delete") {
      const entry = byId.get(entryId);
      if (!entry || entry.status !== "active") return null;
      const record = {
        v: SCHEMA_VERSION,
        id: randomUUID(),
        kind: "removed",
        ts: new Date().toISOString(),
        entryId,
        reason,
      };
      await write([record]);
      return byId.get(entryId);
    },

    async consume({ entryIds, purchaseOrderId, purchaseOrderName, draftId, groupHash }) {
      if (!Array.isArray(entryIds) || entryIds.length === 0) return [];
      const ts = new Date().toISOString();
      const records = [];
      for (const entryId of entryIds) {
        const entry = byId.get(entryId);
        if (!entry || entry.status !== "active") continue;
        records.push({
          v: SCHEMA_VERSION,
          id: randomUUID(),
          kind: "consumed",
          ts,
          entryId,
          purchaseOrderId,
          purchaseOrderName,
          draftId,
          groupHash,
        });
      }
      await write(records);
      return records.map((r) => r.entryId);
    },

    async reconcileConsumedFromSubmissions(submissionsStore) {
      if (!submissionsStore?.listAll) return;
      const drafts = submissionsStore.listAll();
      const reconciledRecords = [];
      const ts = new Date().toISOString();
      for (const [draftId, draft] of Object.entries(drafts)) {
        for (const [groupHash, groupResult] of Object.entries(draft.groups || {})) {
          if (groupResult.status !== "ok") continue;
          const consumedIds = groupResult.consumedEntryIds || [];
          for (const entryId of consumedIds) {
            const entry = byId.get(entryId);
            if (!entry) continue;
            if (entry.status === "consumed") continue;
            reconciledRecords.push({
              v: SCHEMA_VERSION,
              id: randomUUID(),
              kind: "consumed",
              ts,
              entryId,
              purchaseOrderId: groupResult.purchaseOrderId || null,
              purchaseOrderName: groupResult.purchaseOrderName || null,
              draftId,
              groupHash,
              reconciled: true,
            });
          }
        }
      }
      if (reconciledRecords.length > 0) {
        logger.warn("wishlist-store", "reconcile_consumed", {
          count: reconciledRecords.length,
        });
        await write(reconciledRecords);
      }
      return reconciledRecords.length;
    },
  };
}
