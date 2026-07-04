import { config } from "./config.js";
import { logger } from "./logger.js";

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = config.stream.apiToken
    ? { "X-Stream-Token": config.stream.apiToken }
    : undefined;
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

// Опрашивает MediaMTX API за статусом path'а стрима. Деградирует
// молча (live: false + error) на любой сбой сети/API — это health-poll
// для UI-индикатора, а не критичный путь.
export async function getStreamStatus() {
  if (!config.stream.apiUrl) {
    return { configured: false };
  }

  const url = `${config.stream.apiUrl}/v3/paths/get/${config.stream.pathName}`;

  try {
    const response = await fetchWithTimeout(url, config.stream.statusTimeoutMs);
    if (response.status === 404) {
      return { configured: true, live: false, readers: 0 };
    }
    if (!response.ok) {
      throw new Error(`mediamtx status ${response.status}`);
    }
    const data = await response.json();
    return {
      configured: true,
      live: Boolean(data.ready),
      readers: Array.isArray(data.readers) ? data.readers.length : 0,
    };
  } catch (error) {
    const message = error?.name === "AbortError"
      ? `mediamtx status timed out after ${config.stream.statusTimeoutMs}ms`
      : error?.message || String(error);
    logger.warn("stream", "status_poll_failed", { error: message });
    return { configured: true, live: false, readers: 0, error: message };
  }
}
