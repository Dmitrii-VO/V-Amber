import { logger } from "./logger.js";

export function createProductCodeCache() {
  // Map<code, {id,name,supplierId,supplierName,buyPrice}>.
  // Раньше тут лежал просто Set кодов — теперь храним обогащённую запись,
  // чтобы wish list и UI могли получить поставщика/закупочную цену без
  // отдельных вызовов МС в горячем пути.
  let products = new Map();
  let loadedAt = null;
  let refreshInFlight = null;
  let lastError = null;

  function snapshot() {
    return {
      count: products.size,
      loadedAt,
      refreshing: Boolean(refreshInFlight),
      lastError,
    };
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

          products = nextProducts;
          loadedAt = new Date().toISOString();
          lastError = null;
          logger.info("moysklad", "product_code_cache_loaded", {
            count: products.size,
            withSupplier: [...products.values()].filter((p) => p.supplierId).length,
          });
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
