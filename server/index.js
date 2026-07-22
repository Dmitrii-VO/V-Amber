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
import { loadActiveState, clearActiveState, extractOrphans } from "./state-store.js";
import { createWishlistStore } from "./wishlist-store.js";
import { createNameCacheStore } from "./name-cache-store.js";
import { createBlockedViewersStore } from "./blocked-viewers-store.js";
import { createWishlistSubmissions } from "./wishlist-submissions.js";
import { createSettingsStore } from "./settings-store.js";
import { wrapWithSafeMode, isSafeMode } from "./safe-mode.js";

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

  logger.warn("recovery", "active_state_found_on_startup", {
    savedAt: state.savedAt,
    connectionId: state.connectionId,
    lotSessionId: lot.lotSessionId || null,
    code: lot.code || null,
    openLotCount: openLots.length,
    orphanCount: orphans.length,
  });

  if (orphans.length > 0) {
    const lines = [
      ``,
      `---`,
      ``,
      `> **⚠ Восстановление после краша**  `,
      `> Сервер был перезапущен в ${new Date().toLocaleString("ru-RU")}, предыдущий процесс не успел корректно закрыть сессию.`,
      `> На открытых лотах остались необработанные брони:`,
      ``,
      ...orphans.map((entry, index) => {
        const label = entry.viewerName || `id${entry.viewerId}`;
        const status = entry.status ? ` — _${entry.status}_` : "";
        const commentId = entry.commentId ? ` (comment ${entry.commentId})` : "";
        const lotLabel = entry.lotCode || lot.code || "—";
        return `${index + 1}. Лот **${lotLabel}**: **${label}**${commentId}${status}`;
      }),
      ``,
      `**Что делать:** проверить вручную в МойСкладе, что для этих зрителей созданы заказы. Если нет — создать; если есть, но без позиции на нужный лот, добавить позицию. Ответьте им в VK.`,
      ``,
      `_Эти зрители не добавлены в Wish list автоматически: теперь нужно подтверждение комментарием «СПИСОК код товара»._`,
      ``,
    ].join("\n");

    try {
      await mkdir(sessionsDir, { recursive: true });

      if (state.sessionFilePath) {
        await appendFile(state.sessionFilePath, lines, "utf8");
        logger.info("recovery", "orphans_appended_to_session", {
          file: state.sessionFilePath,
          orphanCount: orphans.length,
        });
      } else {
        const recoveryFile = join(
          sessionsDir,
          `recovery-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
        );
        await writeFile(recoveryFile, `# Восстановление после краша\n${lines}`, "utf8");
        logger.info("recovery", "orphans_written_to_recovery_file", {
          file: recoveryFile,
          orphanCount: orphans.length,
        });
      }
    } catch (error) {
      logger.error("recovery", "orphan_writeout_failed", { error });
    }

    logger.info("recovery", "wishlist_auto_migrate_skipped_confirmation_required", {
      lotSessionId: lot.lotSessionId || null,
      code: lot.code || null,
      orphanCount: orphans.length,
    });
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
  const moysklad = wrapWithSafeMode(
    rawMoysklad,
    [
      "createCustomerOrderReservation",
      "appendPositionToCustomerOrder",
      "removePositionFromOrder",
      "createPurchaseOrder",
    ],
    "moysklad",
  );

  const rawVk = createVkPublisher(config.vk);
  const vk = wrapWithSafeMode(
    rawVk,
    ["publishLotCard", "publishLotClosed", "publishDiscountUpdate", "publishPriceUpdate", "publishReservationReply", "sendDirectMessage"],
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
  });

  httpServer.on("error", (error) => {
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
    reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason,
  });
});

process.on("uncaughtException", (error) => {
  logger.error("process", "uncaught_exception", {
    error: { message: error?.message, stack: error?.stack },
  });
});

main().catch((error) => {
  logger.error("startup", "fatal", { error });
  process.exit(1);
});
