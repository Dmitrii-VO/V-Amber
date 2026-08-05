import { appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { config } from "./config.js";
import { createStaticServer } from "./http-server.js";
import { attachWsServer } from "./ws-server.js";
import { logger } from "./logger.js";
import { checkForUpdates } from "./version-check.js";
import { createVkPublisher } from "./vk.js";
import { createMoySkladClient } from "./moysklad.js";
import { createProductCodeCache } from "./product-code-cache.js";
import {
  loadActiveState,
  clearActiveState,
  extractOrphans,
  partitionOrphansForRecovery,
} from "./state-store.js";
import { createWishlistStore } from "./wishlist-store.js";
import { createNameCacheStore } from "./name-cache-store.js";
import { createBlockedViewersStore } from "./blocked-viewers-store.js";
import { createWishlistSubmissions } from "./wishlist-submissions.js";
import { createSettingsStore } from "./settings-store.js";
import { wrapWithSafeMode, isSafeMode } from "./safe-mode.js";
import { createWriteJournal, wrapWithWriteJournal, buildReservationWriteKey } from "./write-journal.js";
import { createReservationReconciler } from "./write-reconciler.js";
import { getStreamStatus } from "./stream-status.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionsDir = join(__dirname, "..", "logs", "sessions");

let packageVersion = "";
try {
  const pkgRaw = readFileSync(join(__dirname, "..", "package.json"), "utf8");
  packageVersion = JSON.parse(pkgRaw)?.version || "";
} catch { /* ignore */ }

async function recoverOrphansFromCrash({ wishlistStore } = {}) {
  const state = await loadActiveState();
  if (!state) {
    return;
  }

  const orphans = extractOrphans(state);
  const lot = state.activeLot || {};
  const openLots = Array.isArray(state.openLots) && state.openLots.length > 0 ? state.openLots : [lot].filter(Boolean);
  const { safeOrphans, uncertainOrphans } = partitionOrphansForRecovery(orphans);
  const migrationFailures = [];
  let migratedCount = 0;

  logger.warn("recovery", "active_state_found_on_startup", {
    savedAt: state.savedAt,
    connectionId: state.connectionId,
    lotSessionId: lot.lotSessionId || null,
    code: lot.code || null,
    openLotCount: openLots.length,
    orphanCount: orphans.length,
  });

  if (safeOrphans.length > 0) {
    const byLotSessionId = new Map();
    for (const entry of safeOrphans) {
      const key = entry.lotSessionId || `code:${entry.lotCode || "unknown"}`;
      if (!byLotSessionId.has(key)) byLotSessionId.set(key, []);
      byLotSessionId.get(key).push(entry);
    }

    for (const [lotSessionId, events] of byLotSessionId) {
      const sourceLot = openLots.find((candidate) => candidate.lotSessionId === lotSessionId)
        || openLots.find((candidate) => candidate.code === events[0]?.lotCode)
        || { code: events[0]?.lotCode || "", lotSessionId: events[0]?.lotSessionId || null };
      try {
        const expectedRecords = new Set(events.map((entry) => (
          `${entry.viewerId ?? ""}::${entry.lotCode || sourceLot.code || ""}`
        ))).size;
        const records = await wishlistStore.addFromWaitlistOnClose({
          events,
          lot: sourceLot,
          reason: "crash_recovery",
          productMetaResolver: () => ({
            productId: sourceLot.product?.id || null,
            productName: sourceLot.product?.name || "",
          }),
        });
        if (records.length !== expectedRecords) {
          throw new Error(`Expected ${expectedRecords} wishlist records, wrote ${records.length}`);
        }
        migratedCount += records.length;
      } catch (error) {
        migrationFailures.push(...events);
        logger.error("recovery", "wishlist_orphan_migration_failed", {
          lotSessionId: sourceLot.lotSessionId || null,
          code: sourceLot.code || null,
          orphanCount: events.length,
          error,
        });
      }
    }

    logger.info("recovery", "wishlist_orphans_migrated", {
      candidates: safeOrphans.length,
      migrated: migratedCount,
      failed: migrationFailures.length,
    });
  }

  const manualOrphans = [...uncertainOrphans, ...migrationFailures];
  let manualOrphansRecorded = manualOrphans.length === 0;
  if (manualOrphans.length > 0) {
    const lines = [
      ``,
      `---`,
      ``,
      `> **⚠ Восстановление после краша**  `,
      `> Сервер был перезапущен в ${new Date().toLocaleString("ru-RU")}, предыдущий процесс не успел корректно закрыть сессию.`,
      `> На открытых лотах остались заявки, требующие ручной сверки:`,
      ``,
      ...manualOrphans.map((entry, index) => {
        const label = entry.viewerName || `id${entry.viewerId}`;
        const status = entry.status ? ` — _${entry.status}_` : "";
        const commentId = entry.commentId ? ` (comment ${entry.commentId})` : "";
        const lotLabel = entry.lotCode || lot.code || "—";
        return `${index + 1}. Лот **${lotLabel}**: **${label}**${commentId}${status}`;
      }),
      ``,
      `**Что делать:** для _creating_order_ проверить МойСклад — запись могла завершиться до падения. Остальные строки не удалось сохранить в wishlist, добавьте их вручную.`,
      ``,
      migratedCount > 0 ? `_Безопасные хвосты очереди автоматически перенесены в wishlist: ${migratedCount}._` : "",
      ``,
    ].join("\n");

    try {
      await mkdir(sessionsDir, { recursive: true });

      if (state.sessionFilePath) {
        await appendFile(state.sessionFilePath, lines, "utf8");
        logger.info("recovery", "orphans_appended_to_session", {
          file: state.sessionFilePath,
          orphanCount: manualOrphans.length,
        });
      } else {
        const recoveryFile = join(
          sessionsDir,
          `recovery-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
        );
        await writeFile(recoveryFile, `# Восстановление после краша\n${lines}`, "utf8");
        logger.info("recovery", "orphans_written_to_recovery_file", {
          file: recoveryFile,
          orphanCount: manualOrphans.length,
        });
      }
      manualOrphansRecorded = true;
    } catch (error) {
      logger.error("recovery", "orphan_writeout_failed", { error });
    }

    logger.info("recovery", "manual_orphans_recorded", {
      lotSessionId: lot.lotSessionId || null,
      code: lot.code || null,
      orphanCount: manualOrphans.length,
    });
  }

  if (!manualOrphansRecorded) {
    logger.error("recovery", "active_state_preserved_after_writeout_failure", {
      orphanCount: manualOrphans.length,
    });
    throw new Error("Crash recovery report could not be written; active state was preserved");
  }

  // В любом случае стираем state-файл — это «обработанный» инцидент.
  await clearActiveState();
}

const PRODUCT_CODE_CACHE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// Diagnostic sink для moysklad-клиента. Sink не знает текущую сессию напрямую
// (singleton-клиент, но WS-сессий может быть несколько). MVP: один writer на
// активную сессию. http-flow без открытой WS-сессии падает в server.log как
// kind:"moysklad_call_unrouted". Это ограничение явно зафиксировано в плане.
const diagnosticRouter = {
  writer: null,
  setActiveWriter(writer) { this.writer = writer; },
  emit(event) {
    // source приходит от moysklad-клиента (он знает свой контекст через
    // requestContext, см. вызов postJson/requestJson). Если не задан —
    // считаем "unknown", чтобы post-factum было видно: вызов не из
    // активной WS-сессии и не из HTTP submit, а откуда-то ещё (например,
    // setInterval из server/index.js на refresh product cache).
    // Порядок важен: source выставляем ПОСЛЕ spread, иначе передача source:undefined
    // из moysklad.js перезатрёт fallback "unknown".
    const enriched = { ...event, source: event?.source || "unknown" };
    if (this.writer) {
      this.writer.writeEvent("moysklad_call", enriched);
      return;
    }
    // Нет активного session writer'а. Разделяем «явный фон» (cache_refresh,
    // http без сессии) от настоящего «непонятно откуда»: первый — штатное
    // поведение, второй — реально требует внимания при post-factum-анализе.
    const messageName = enriched.source === "unknown"
      ? "moysklad_call_unrouted"
      : "moysklad_call_background";
    logger.info("moysklad", messageName, enriched);
  },
  // Универсальный emit для произвольных kind'ов: wishlist_*, purchase_order_*,
  // safemode_blocked_purchase_order и т.д. При отсутствии активного writer'а
  // событие падает в server.log как unrouted — оно не теряется.
  emitGeneric(kind, payload) {
    if (this.writer) {
      this.writer.writeEvent(kind, payload || {});
    } else {
      logger.info("diagnostic", `${kind}_unrouted`, payload || {});
    }
  },
};

async function main() {
  await checkForUpdates();

  // Загружаем persisted-хранилища ДО старта HTTP/WS, чтобы счётчик wish list
  // и идемпотентность PO были корректны с первого запроса.
  const wishlistSubmissions = createWishlistSubmissions();
  const wishlistStore = createWishlistStore();
  const nameCacheStore = createNameCacheStore();
  const blockedViewersStore = createBlockedViewersStore();
  const settingsStore = createSettingsStore({ fallbacks: config.wishlist });

  await Promise.all([
    wishlistSubmissions.load(),
    wishlistStore.load(),
    nameCacheStore.load(),
    blockedViewersStore.load(),
    settingsStore.load(),
  ]);

  // Reconcile: если процесс упал между recordGroupResult(ok) и consume(),
  // в submissions.json есть запись об успешном PO, но в wishlist.jsonl
  // нет соответствующего consumed — дописываем тут, не дожидаясь следующего
  // submit, чтобы счётчик и группировка были корректны.
  await wishlistStore.reconcileConsumedFromSubmissions(wishlistSubmissions);

  // Recovery после краша делаем ПОСЛЕ загрузки wish list, чтобы orphans
  // могли мигрировать в него.
  await recoverOrphansFromCrash({ wishlistStore });

  // Создаём клиенты МойСклад / VK и оборачиваем write-методы wrapWithSafeMode
  // ОДИН РАЗ на shared service — чтобы и HTTP-flow (POST wishlist/purchase-order),
  // и WS-flow (бронь → customerorder) уходили через один и тот же safe-mode guard.
  const rawMoysklad = createMoySkladClient(config.moysklad, {
    onCall: (event) => diagnosticRouter.emit(event),
  });
  // Журнал внешних записей: ведётся ВНУТРИ safe-mode, чтобы заблокированная
  // safe-mode'ом запись не оставляла в журнале следа о несуществующей брони.
  const writeJournal = createWriteJournal();
  await writeJournal.load();
  logger.info("write-journal", "ready", writeJournal.stats());

  // Сверка использует ТОЛЬКО read-методы клиента, поэтому берёт rawMoysklad
  // напрямую — оборачивать её safe-mode'ом нечем и незачем.
  const writeReconciler = createReservationReconciler({
    moysklad: rawMoysklad,
    journal: writeJournal,
  });

  const buildReservationMeta = (args) => ({
    productId: args?.activeLot?.product?.id || null,
    orderId: args?.orderId || null,
    counterpartyId: args?.counterparty?.id || null,
    commentId: args?.reservation?.commentId || null,
    lotSessionId: args?.activeLot?.lotSessionId || null,
  });

  const journaledMoysklad = wrapWithWriteJournal(
    rawMoysklad,
    writeJournal,
    {
      createCustomerOrderReservation: (args) => buildReservationWriteKey(args || {}),
      appendPositionToCustomerOrder: (args) => buildReservationWriteKey(args || {}),
    },
    {
      metaBuilders: {
        createCustomerOrderReservation: (args) => buildReservationMeta(args || {}),
        appendPositionToCustomerOrder: (args) => buildReservationMeta(args || {}),
      },
      reconciler: writeReconciler,
      retryAttempts: config.moysklad?.writeRetryAttempts,
      retryBaseDelayMs: config.moysklad?.writeRetryBaseDelayMs,
    },
  );

  const moysklad = wrapWithSafeMode(
    journaledMoysklad,
    [
      "createCustomerOrderReservation",
      "appendPositionToCustomerOrder",
      "removePositionFromOrder",
      "updateCustomerOrderPositionPricing",
      "createPurchaseOrder",
    ],
    "moysklad",
  );

  const rawVk = createVkPublisher(config.vk);
  const vk = wrapWithSafeMode(
    rawVk,
    ["publishLotCard", "publishLotClosed", "publishDiscountUpdate", "publishPriceUpdate", "publishReservationReply", "publishViewerInstruction", "publishCrossPromo", "sendDirectMessage"],
    "vk",
  );

  const productCodeCache = createProductCodeCache();

  // wishlist-store события → diagnostic router → активный session JSONL.
  // Mapping kind: kind записи (added/seen_again/edited/removed/consumed)
  // → wishlist_<kind> в JSONL.
  if (typeof wishlistStore.subscribeEvents === "function") {
    wishlistStore.subscribeEvents((record) => {
      if (!record?.kind) return;
      diagnosticRouter.emitGeneric(`wishlist_${record.kind}`, record);
    });
  }

  const httpServer = createStaticServer({
    vk,
    moysklad,
    productCodeCache,
    config,
    wishlistStore,
    wishlistSubmissions,
    settingsStore,
    blockedViewersStore,
    diagnosticRouter,
    packageVersion,
  });

  attachWsServer(httpServer, config, {
    vk,
    moysklad,
    productCodeCache,
    wishlistStore,
    nameCacheStore,
    blockedViewersStore,
    diagnosticRouter,
    packageVersion,
    // Проба «своя площадка в эфире» для перекрёстных подсказок. Инжектится
    // отсюда, а не импортируется в ws-server: тот не должен тянуть
    // server/config.js (и вместе с ним dotenv) — см. комментарий там.
    getStreamStatus,
  });

  httpServer.on("error", (error) => {
    // Порт занят = почти всегда вторая копия V-Amber (лог 2026-07-24: двойной
    // запуск на маке оператора). Раньше процесс молча жил дальше без HTTP —
    // «зомби», который продолжал дёргать МойСклад и греть кеши. Завершаемся
    // с понятным сообщением: рабочая копия уже открыта на том же порту.
    if (error?.code === "EADDRINUSE") {
      logger.error("http", "port_busy_exiting", {
        port: config.port,
        hint: "V-Amber уже запущен — вторая копия завершается",
      });
      console.error(
        `\nV-Amber уже запущен: порт ${config.port} занят.\n`
        + `Откройте http://localhost:${config.port} в браузере или закройте вторую копию приложения.\n`,
      );
      // flush с таймаутом: зависший write-chain (диск/антивирус) не должен
      // воскресить того самого зомби, ради которого этот выход и написан.
      const flushTimeout = new Promise((resolve) => {
        setTimeout(resolve, 2000).unref?.();
      });
      void Promise.race([logger.flush(), flushTimeout]).finally(() => process.exit(1));
      return;
    }
    logger.error("http", "server_listen_failed", {
      port: config.port,
      error,
    });
  });

  httpServer.listen(config.port, config.host, () => {
    logger.info("http", "server_started", {
      host: config.host,
      port: config.port,
      url: `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`,
      logFile: logger.filePath,
      version: packageVersion,
      safeMode: isSafeMode(),
      wishlistActive: wishlistStore.getActiveCount(),
    });

    // Без API_TOKEN весь API и WS открыты любому устройству в локальной сети,
    // когда сервер слушает не только loopback (дефолт 0.0.0.0 — для Docker).
    // Origin-allowlist защищает только браузерные запросы.
    const apiTokenSet = Boolean(process.env.API_TOKEN?.trim());
    const loopbackOnly = ["127.0.0.1", "localhost", "::1"].includes(config.host);
    if (!apiTokenSet && !loopbackOnly) {
      logger.warn("http", "auth_disabled_on_lan", {
        host: config.host,
        hint: "Задайте API_TOKEN в .env или HOST=127.0.0.1 для локального доступа",
      });
    }

    // Счётчик подряд-фейлов refresh. Поднимаем уровень логирования с info до
     // warn после 3 неудач подряд, чтобы оператор увидел проблему с МойСкладом
     // в общем потоке логов, а не только в JSONL.
    let consecutiveRefreshFailures = 0;
    const REFRESH_WARN_THRESHOLD = 3;
    function refreshProductCache() {
      productCodeCache.refresh(moysklad).then(() => {
        if (consecutiveRefreshFailures > 0) {
          logger.info("moysklad", "product_code_cache_recovered", {
            failuresBefore: consecutiveRefreshFailures,
          });
        }
        consecutiveRefreshFailures = 0;
      }).catch((error) => {
        consecutiveRefreshFailures += 1;
        const meta = {
          error: error?.message || String(error),
          consecutiveFailures: consecutiveRefreshFailures,
        };
        if (consecutiveRefreshFailures >= REFRESH_WARN_THRESHOLD) {
          logger.warn("moysklad", "product_code_cache_refresh_failing", meta);
        } else {
          logger.info("moysklad", "product_code_cache_refresh_failed", meta);
        }
      });
    }

    refreshProductCache();
    setInterval(refreshProductCache, PRODUCT_CODE_CACHE_REFRESH_INTERVAL_MS).unref();
  });
}

process.on("unhandledRejection", (reason) => {
  logger.error("process", "unhandled_rejection", {
    reason,
    continued: true,
  });
});

process.on("uncaughtException", (error) => {
  logger.error("process", "uncaught_exception", {
    error,
    networkTermination: /\bterminated\b|fetch failed/i.test(error?.message || ""),
    continued: true,
  });
});

main().catch((error) => {
  logger.error("startup", "fatal", { error });
  process.exit(1);
});
