import { appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { createStaticServer } from "./http-server.js";
import { attachWsServer } from "./ws-server.js";
import { logger } from "./logger.js";
import { checkForUpdates } from "./version-check.js";
import { createVkPublisher } from "./vk.js";
import { createMoySkladClient } from "./moysklad.js";
import { createProductCodeCache } from "./product-code-cache.js";
import { loadActiveState, clearActiveState, extractOrphans } from "./state-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionsDir = join(__dirname, "..", "logs", "sessions");

async function recoverOrphansFromCrash() {
  const state = await loadActiveState();
  if (!state) {
    return;
  }

  const orphans = extractOrphans(state);
  const lot = state.activeLot || {};

  // Сам факт наличия файла означает, что предыдущий процесс не успел
  // выполнить clearActiveState — то есть умер не от Stop/close, а от
  // exception/SIGKILL/перезапуска машины. Фиксируем это в server.log.
  logger.warn("recovery", "active_state_found_on_startup", {
    savedAt: state.savedAt,
    connectionId: state.connectionId,
    lotSessionId: lot.lotSessionId || null,
    code: lot.code || null,
    orphanCount: orphans.length,
  });

  if (orphans.length > 0) {
    // Дозаписываем в .md прошлой сессии, если можем. Это сохраняет
    // хронологию: оператор открывает тот же файл и видит, чем «всё кончилось».
    // Иначе создаём отдельный recovery-файл.
    const lines = [
      ``,
      `---`,
      ``,
      `> **⚠ Восстановление после краша**  `,
      `> Сервер был перезапущен в ${new Date().toLocaleString("ru-RU")}, предыдущий процесс не успел корректно закрыть сессию.`,
      `> На лоте **${lot.code || "—"}** (\`${lot.lotSessionId || "—"}\`) остались необработанные брони:`,
      ``,
      ...orphans.map((entry, index) => {
        const label = entry.viewerName || `id${entry.viewerId}`;
        const status = entry.status ? ` — _${entry.status}_` : "";
        const commentId = entry.commentId ? ` (comment ${entry.commentId})` : "";
        return `${index + 1}. **${label}**${commentId}${status}`;
      }),
      ``,
      `**Что делать:** проверить вручную в МойСкладе, что для этих зрителей созданы заказы. Если нет — создать; если есть, но без позиции на лот ${lot.code || "—"}, добавить позицию. Ответьте им в VK.`,
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
  }

  // В любом случае стираем state-файл — это «обработанный» инцидент.
  await clearActiveState();
}

// Каталог продуктов нужен и для обрезки «грязных» кодов до известных
// префиксов, и для валидации YandexGPT-кандидатов. Без него детектор
// работает в старом «нефильтрованном» режиме. Раз в час обновляем кэш,
// чтобы новые SKU из МойСклад подхватывались без ручного нажатия
// «Обновить каталог» в UI.
const PRODUCT_CODE_CACHE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

async function main() {
  await checkForUpdates();

  // Восстановление после краша делаем ДО того, как принимаем новые
  // WebSocket-соединения. Иначе оператор откроет дашборд раньше, чем мы
  // успеем сообщить про брошенные брони, и может не заметить уведомления.
  await recoverOrphansFromCrash();

  const vk = createVkPublisher(config.vk);
  const moysklad = createMoySkladClient(config.moysklad);
  const productCodeCache = createProductCodeCache();
  const httpServer = createStaticServer({ vk, moysklad, productCodeCache, config });
  attachWsServer(httpServer, config, { vk, moysklad, productCodeCache });

  httpServer.on("error", (error) => {
    logger.error("http", "server_listen_failed", {
      port: config.port,
      error,
    });
  });

  httpServer.listen(config.port, () => {
    logger.info("http", "server_started", {
      port: config.port,
      url: `http://localhost:${config.port}`,
      logFile: logger.filePath,
    });

    // Fire-and-forget — не блокируем готовность HTTP. Ошибка уже логгируется
    // внутри cache.refresh(), здесь только глушим unhandledRejection.
    productCodeCache.refresh(moysklad).catch(() => {});

    setInterval(() => {
      productCodeCache.refresh(moysklad).catch(() => {});
    }, PRODUCT_CODE_CACHE_REFRESH_INTERVAL_MS).unref();
  });
}

main().catch((error) => {
  logger.error("startup", "fatal", { error });
  process.exit(1);
});
