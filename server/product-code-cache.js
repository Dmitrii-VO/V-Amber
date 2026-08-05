import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultFilePath = join(__dirname, "..", "logs", "product-code-cache.json");

const SCHEMA_VERSION = 1;

// Границы длины артикула считаем ПО КАТАЛОГУ, а не по константам из .env.
// Верхняя — самый длинный код как есть. Нижняя — самый короткий код ПОСЛЕ
// снятия ведущих нулей: оператор произносит «пятьсот восемьдесят восемь» для
// 00588, и кандидат приезжает в детекцию трёхзначным.
export function deriveCodeLengthBounds(codes) {
  let min = null;
  let max = null;
  for (const raw of codes || []) {
    const code = String(raw || "").trim();
    if (!code) continue;
    const stripped = code.replace(/^0+/, "") || "0";
    min = min === null ? stripped.length : Math.min(min, stripped.length);
    max = max === null ? code.length : Math.max(max, code.length);
  }
  return min === null ? null : { min, max };
}

export function createProductCodeCache({ filePath = defaultFilePath } = {}) {
  // Map<code, {id,name,supplierId,supplierName,buyPrice}>.
  // Раньше тут лежал просто Set кодов — теперь храним обогащённую запись,
  // чтобы wish list и UI могли получить поставщика/закупочную цену без
  // отдельных вызовов МС в горячем пути.
  let products = new Map();
  let loadedAt = null;
  let refreshInFlight = null;
  let lastError = null;
  let fromDisk = false;
  let bounds = null;

  function snapshot() {
    return {
      count: products.size,
      loadedAt,
      refreshing: Boolean(refreshInFlight),
      lastError,
      fromDisk,
      bounds,
    };
  }

  function adopt(nextProducts, { at, disk }) {
    products = nextProducts;
    loadedAt = at;
    fromDisk = disk;
    bounds = deriveCodeLengthBounds(products.keys());
  }

  // Пишем через tmp+rename: оборванная запись не должна оставить полуфайл,
  // который на следующем старте прикинется каталогом.
  async function persist() {
    const payload = {
      v: SCHEMA_VERSION,
      loadedAt,
      products: [...products.entries()].map(([code, value]) => [code, value]),
    };
    const tmpPath = `${filePath}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(payload), "utf8");
    await rename(tmpPath, filePath);
  }

  return {
    getCodes() {
      // Возвращаем НОВЫЙ Set, чтобы внешний код не мог мутировать кэш.
      return new Set(products.keys());
    },
    getProductByCode(code) {
      if (code == null) return null;
      return products.get(String(code)) || null;
    },
    getSnapshot() {
      return snapshot();
    },
    // null, пока каталога нет ни в памяти, ни на диске: вызывающий откатывается
    // на константы из .env.
    getCodeLengthBounds() {
      return bounds;
    },
    // Каталог с прошлого запуска. Нужен ровно для одного сценария: МойСклад
    // недоступен на старте эфира. Без него productCodeCache пуст, каталожный
    // гейт в ws-server пропускает ЛЮБОЙ распознанный код, и эфир открывает
    // лоты-призраки. Так было 27.06.2026: 78 из 78 вызовов МойСклада упали, и
    // из 49 открытых лотов пять получили семизначные коды — к артикулу
    // приклеился размер («артикул 03413 пятьдесят сантиметров» → 0341350).
    // Ни один из них не существует в каталоге, где самый длинный код — 6 знаков.
    async loadFromDisk() {
      if (products.size > 0) return snapshot();
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed?.products) || parsed.products.length === 0) {
          return snapshot();
        }
        adopt(new Map(parsed.products), { at: parsed.loadedAt || null, disk: true });
        logger.warn("moysklad", "product_code_cache_loaded_from_disk", {
          count: products.size,
          loadedAt,
          bounds,
        });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          logger.warn("moysklad", "product_code_cache_disk_read_failed", { error });
        }
      }
      return snapshot();
    },
    async refresh(moysklad, { source = "cache_refresh" } = {}) {
      if (refreshInFlight) {
        return refreshInFlight;
      }

      refreshInFlight = (async () => {
        try {
          // Предпочитаем обогащённый bulk-метод, если он есть; иначе откатываемся
          // на старый getProductCodes, который вернёт только коды. Это сохраняет
          // совместимость для случаев, когда расширения moysklad.js ещё не катились.
          let nextProducts;
          if (typeof moysklad?.getProductsBulk === "function") {
            const result = await moysklad.getProductsBulk({ source });
            nextProducts = result instanceof Map ? result : new Map();
          } else if (typeof moysklad?.getProductCodes === "function") {
            const codes = await moysklad.getProductCodes();
            nextProducts = new Map(codes.map((code) => [String(code), {
              id: null, name: "", supplierId: null, supplierName: "", buyPrice: null,
            }]));
          } else {
            throw new Error("MoySklad product loader is unavailable");
          }

          // Пустой ответ НЕ затирает каталог: это почти всегда сбой на стороне
          // МС, а не опустевший склад, и обмен полного каталога на пустой
          // открыл бы ту самую дыру, ради которой заведён диск.
          if (nextProducts.size === 0 && products.size > 0) {
            logger.warn("moysklad", "product_code_cache_empty_response_ignored", {
              keptCount: products.size,
              keptLoadedAt: loadedAt,
            });
            return snapshot();
          }

          adopt(nextProducts, { at: new Date().toISOString(), disk: false });
          lastError = null;
          logger.info("moysklad", "product_code_cache_loaded", {
            count: products.size,
            withSupplier: [...products.values()].filter((p) => p.supplierId).length,
            bounds,
          });
          try {
            await persist();
          } catch (error) {
            // Диск — подстраховка, а не условие работы: эфир не роняем.
            logger.warn("moysklad", "product_code_cache_persist_failed", { error });
          }
          return snapshot();
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          logger.error("moysklad", "product_code_cache_failed", { error });
          throw error;
        } finally {
          refreshInFlight = null;
        }
      })();

      return refreshInFlight;
    },
  };
}
