import { logger } from "./logger.js";

export function createProductCodeCache() {
  let codes = new Set();
  let loadedAt = null;
  let refreshInFlight = null;
  let lastError = null;

  function snapshot() {
    return {
      count: codes.size,
      loadedAt,
      refreshing: Boolean(refreshInFlight),
      lastError,
    };
  }

  return {
    getCodes() {
      return codes;
    },
    getSnapshot() {
      return snapshot();
    },
    async refresh(moysklad) {
      if (refreshInFlight) {
        return refreshInFlight;
      }

      refreshInFlight = (async () => {
        try {
          if (!moysklad?.getProductCodes) {
            throw new Error("MoySklad product code loader is unavailable");
          }

          const nextCodes = await moysklad.getProductCodes();
          codes = new Set(nextCodes);
          loadedAt = new Date().toISOString();
          lastError = null;
          logger.info("moysklad", "product_code_cache_loaded", {
            count: codes.size,
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
