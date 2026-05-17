import { config } from "./config.js";
import { createStaticServer } from "./http-server.js";
import { attachWsServer } from "./ws-server.js";
import { logger } from "./logger.js";
import { checkForUpdates } from "./version-check.js";
import { createVkPublisher } from "./vk.js";
import { createMoySkladClient } from "./moysklad.js";
import { createProductCodeCache } from "./product-code-cache.js";

// Каталог продуктов нужен и для обрезки «грязных» кодов до известных
// префиксов, и для валидации YandexGPT-кандидатов. Без него детектор
// работает в старом «нефильтрованном» режиме. Раз в час обновляем кэш,
// чтобы новые SKU из МойСклад подхватывались без ручного нажатия
// «Обновить каталог» в UI.
const PRODUCT_CODE_CACHE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

async function main() {
  await checkForUpdates();

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
