import { logger } from "./logger.js";

let safeMode = false;
const listeners = new Set();

export function isSafeMode() {
  return safeMode;
}

export function setSafeMode(value, meta = {}) {
  const next = Boolean(value);
  if (next === safeMode) {
    return false;
  }

  safeMode = next;
  logger.warn("safe-mode", "safe_mode_changed", { safeMode, ...meta });

  for (const listener of listeners) {
    try {
      listener(safeMode, meta);
    } catch (error) {
      logger.error("safe-mode", "listener_failed", { error });
    }
  }

  return true;
}

export function onSafeModeChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function wrapWithSafeMode(client, writeMethods, domain) {
  const wrapped = { ...client };

  for (const method of writeMethods) {
    const original = client[method];
    if (typeof original !== "function") {
      continue;
    }

    const bound = original.bind(client);
    wrapped[method] = (...args) => {
      if (safeMode) {
        logger.warn("safe-mode", "write_blocked", { domain, method });
        return Promise.resolve({ ok: false, skipped: true, safeMode: true });
      }
      return bound(...args);
    };
  }

  return wrapped;
}
