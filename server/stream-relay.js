import { spawn as childSpawn } from "node:child_process";
import { config } from "./config.js";
import { logger } from "./logger.js";

// Дубль эфира в ВК: локальный ffmpeg читает свой поток из MediaMTX (RTMP) и
// пушит его в ВК Live (RTMP, `-c copy` — без перекодирования, минимум CPU).
// Это ВТОРИЧНЫЙ канал: свой поток (OBS→MediaMTX) идёт напрямую и не зависит
// от релея — если ffmpeg упадёт, свой эфир продолжается, а релей сам
// перезапускается ограниченное число раз. Управляется из stream-orchestrator
// по «Запустить/Остановить эфир». Полностью изолирован: ничего не бросает.
//
// Компромисс топологии: релей качает поток из облака и заливает его в ВК —
// то есть аплинк оператора нагружается дважды (в MediaMTX и в ВК). Для
// одного торгового эфира на умеренном битрейте это приемлемо; см.
// knowledge/wiki/stream-integration.md.

export function createStreamRelay({ streamConfig, spawnImpl, log } = {}) {
  const cfg = streamConfig || config.stream;
  const spawn = spawnImpl || childSpawn;
  const logImpl = log || logger;
  const restartMax = Number.isFinite(cfg.relayRestartMax) ? cfg.relayRestartMax : 5;
  const restartDelayMs = Number.isFinite(cfg.relayRestartDelayMs) ? cfg.relayRestartDelayMs : 3000;

  let proc = null;
  let state = "idle"; // idle | running | error
  let lastError = null;
  let restarts = 0;
  let stopping = false;
  let restartTimer = null;

  function isConfigured() {
    return Boolean(cfg.relaySourceUrl && cfg.vkTargetUrl);
  }

  function buildArgs() {
    return [
      "-hide_banner",
      "-loglevel", "warning",
      // Если источник ещё не поднялся/оборвался — не висим вечно.
      "-rw_timeout", "15000000",
      "-i", cfg.relaySourceUrl,
      "-c", "copy",
      "-f", "flv",
      cfg.vkTargetUrl,
    ];
  }

  function spawnProc() {
    const ffmpeg = cfg.ffmpegPath || "ffmpeg";
    try {
      proc = spawn(ffmpeg, buildArgs(), { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      proc = null;
      state = "error";
      lastError = error?.message || String(error);
      logImpl.warn("stream-relay", "spawn_failed", { error: lastError });
      return;
    }
    state = "running";
    lastError = null;
    logImpl.info("stream-relay", "relay_started", { restarts });

    proc.stderr?.on?.("data", (chunk) => {
      const line = String(chunk).trim();
      if (line) lastError = line.slice(0, 300); // последняя строка stderr для диагностики
    });
    proc.on("error", (error) => {
      lastError = error?.message || String(error);
      logImpl.warn("stream-relay", "relay_error", { error: lastError });
    });
    proc.on("exit", (code, signal) => {
      proc = null;
      if (stopping) {
        state = "idle";
        return;
      }
      // Неожиданный выход: свой поток НЕ трогаем, только пробуем поднять
      // дубль в ВК заново — ограниченное число раз, чтобы не долбить вечно.
      state = "error";
      logImpl.warn("stream-relay", "relay_exited", { code, signal, restarts, lastError });
      if (restarts < restartMax) {
        restarts += 1;
        restartTimer = setTimeout(spawnProc, restartDelayMs);
      } else {
        logImpl.warn("stream-relay", "relay_gave_up", { restartMax });
      }
    });
  }

  return {
    isConfigured,
    // Возвращает { ok, code?, message? } — best-effort, никогда не бросает.
    start() {
      if (!isConfigured()) {
        return { ok: false, code: "not_configured", message: "Дубль в ВК не настроен (нет STREAM_VK_* / источника)" };
      }
      if (proc) return { ok: true, already: true };
      stopping = false;
      restarts = 0;
      lastError = null;
      spawnProc();
      // spawnProc синхронно выставляет state; при синхронном ENOENT — error.
      if (state === "error") {
        return { ok: false, code: "spawn_failed", message: lastError || "не удалось запустить ffmpeg" };
      }
      return { ok: true };
    },
    stop() {
      stopping = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (proc) {
        try { proc.kill("SIGTERM"); } catch { /* уже мёртв */ }
        proc = null;
      }
      state = "idle";
      restarts = 0;
      return { ok: true };
    },
    status() {
      return {
        configured: isConfigured(),
        state,          // idle | running | error
        restarts,
        lastError: lastError || null,
      };
    },
  };
}

// Singleton поверх реального config/spawn — им пользуется оркестратор.
const defaultRelay = createStreamRelay();

export function startRelay() { return defaultRelay.start(); }
export function stopRelay() { return defaultRelay.stop(); }
export function getRelayStatus() { return defaultRelay.status(); }
export function isRelayConfigured() { return defaultRelay.isConfigured(); }
