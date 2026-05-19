import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsFilePath = join(__dirname, "..", "logs", "settings.json");
const tmpFilePath = `${settingsFilePath}.tmp`;

const SCHEMA_VERSION = 1;

function buildDefaults(fallbacks = {}) {
  return {
    v: SCHEMA_VERSION,
    wishlist: {
      defaultStoreId: fallbacks.defaultStoreId || "",
      defaultSupplierId: fallbacks.defaultSupplierId || "",
      oldDaysThreshold: Number.isFinite(fallbacks.oldDaysThreshold) ? fallbacks.oldDaysThreshold : 7,
      notifyVkOnAdd: Boolean(fallbacks.notifyVkOnAdd),
      descriptionTemplate: fallbacks.descriptionTemplate || "Предзаказ из эфира {date}. Артикулы: {codes}",
    },
  };
}

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)
        && base?.[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      result[key] = mergeDeep(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function createSettingsStore({ fallbacks = {} } = {}) {
  const defaults = buildDefaults(fallbacks);
  let current = defaults;
  let writeChain = Promise.resolve();
  let loaded = false;

  async function persist() {
    try {
      await mkdir(dirname(settingsFilePath), { recursive: true });
      await writeFile(tmpFilePath, JSON.stringify(current, null, 2), "utf8");
      await rename(tmpFilePath, settingsFilePath);
    } catch (error) {
      logger.warn("settings-store", "save_failed", { error });
    }
  }

  return {
    async load() {
      if (loaded) return current;
      loaded = true;
      try {
        const raw = await readFile(settingsFilePath, "utf8");
        const parsed = JSON.parse(raw);
        // Сливаем с дефолтами: новые поля будущих версий получат значения,
        // отсутствующие в файле, без миграции.
        current = mergeDeep(defaults, parsed);
        current.v = SCHEMA_VERSION;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          logger.warn("settings-store", "load_failed", { error });
        }
        current = defaults;
      }
      return current;
    },
    get() {
      return current;
    },
    getWishlist() {
      return current.wishlist;
    },
    async patch(diff) {
      // Принимаем либо {wishlist:{...}}, либо плоский diff для wishlist для удобства.
      const normalised = (diff && typeof diff === "object" && diff.wishlist)
        ? diff
        : { wishlist: diff || {} };
      current = mergeDeep(current, normalised);
      current.v = SCHEMA_VERSION;
      writeChain = writeChain.then(persist);
      try { await writeChain; } catch { /* logged inside persist */ }
      return current;
    },
  };
}
