import { spawn } from "node:child_process";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { getStreamStatus } from "./stream-status.js";
import { getObsState, configureObsStream, startObsStream, stopObsStream } from "./obs-client.js";
import { createStreamRelay } from "./stream-relay.js";

// Singleton релея живёт здесь: оркестратор и так импортирует config, а
// stream-relay.js специально от config развязан (см. комментарий там).
const relay = createStreamRelay({ streamConfig: config.stream });
const startRelay = () => relay.start();
const stopRelay = () => relay.stop();
const isRelayConfigured = () => relay.isConfigured();
export const getRelayStatus = () => relay.status();

// Оркестрация запуска эфира «одной кнопкой»: пошаговый preflight с
// автопочинкой (прописать настройки OBS, запустить OBS), затем старт
// публикации и ожидание ready от MediaMTX. Модуль полностью изолирован
// от основного потока V-Amber: ничего не бросает наружу, всегда
// возвращает структурированный результат {ok, steps[]}. Сбой любого
// звена стрима не влияет на голос/лоты/брони — и наоборот.

const OBS_DOWNLOAD_HINT = "Установите OBS Studio с https://obsproject.com/download, "
  + "запустите и включите WebSocket-сервер: Сервис → Настройки сервера WebSocket "
  + "→ «Включить», пароль скопируйте в OBS_WEBSOCKET_PASSWORD в .env.";

function step(id, label, status, detail = "", hint = "") {
  return { id, label, status, detail, hint }; // status: ok | fixed | fail
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ключ в формате OBS Stream Key: путь + креды публикации query-параметрами
// (та же логика, что obsStreamKey в /api/stream/config).
function expectedObsKey() {
  const { pathName, publishUser, publishPass } = config.stream;
  return `${pathName}?user=${encodeURIComponent(publishUser)}&pass=${encodeURIComponent(publishPass)}`;
}

// Лучшее усилие запустить OBS локально (V-Amber работает на той же машине,
// что и OBS оператора). Без shell (spawn + массив аргументов), detached —
// OBS живёт независимо от V-Amber. Ошибки глотаем: ниже всё равно retry-цикл
// подключения, а при неудаче оператор получит подсказку.
function tryLaunchObs() {
  let file;
  let args = [];
  let options = { detached: true, stdio: "ignore" };
  if (process.platform === "darwin") {
    file = "open";
    args = ["-a", "OBS"];
  } else if (process.platform === "win32") {
    // OBS отказывается стартовать, если cwd — не его bin-каталог.
    file = "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe";
    options = { ...options, cwd: "C:\\Program Files\\obs-studio\\bin\\64bit" };
  } else {
    file = "obs";
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, options);
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

// Подключение к OBS с автозапуском: если недоступен — пробуем запустить
// приложение и ждём до launchWaitMs, пока поднимется WebSocket-сервер.
async function connectObsWithAutolaunch() {
  try {
    return { state: await getObsState(), launched: false };
  } catch (error) {
    if (error?.code !== "unreachable") throw error;
  }

  logger.info("stream", "obs_autolaunch_attempt", { platform: process.platform });
  const launched = await tryLaunchObs();
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      return { state: await getObsState(), launched: true };
    } catch (error) {
      lastError = error;
      if (error?.code !== "unreachable") throw error;
    }
  }
  const reason = launched ? "OBS запущен, но WebSocket-сервер не отвечает" : "OBS не удалось запустить";
  throw new ObsUnreachable(`${reason}${lastError ? ` (${lastError.message})` : ""}`);
}

class ObsUnreachable extends Error {
  constructor(message) {
    super(message);
    this.code = "unreachable";
  }
}

// Пошаговая проверка готовности. fix=true — чинить найденные проблемы
// (прописать настройки OBS, запустить OBS), false — только диагностика.
export async function preflightBroadcast({ fix = true } = {}) {
  const steps = [];

  // 1. Конфигурация V-Amber.
  const missing = [];
  if (!config.stream.apiUrl) missing.push("STREAM_MEDIAMTX_API_URL");
  if (!config.stream.rtmpUrl) missing.push("STREAM_RTMP_URL");
  if (!config.stream.publishUser || !config.stream.publishPass) missing.push("STREAM_PUBLISH_USER/PASS");
  if (missing.length) {
    steps.push(step("config", "Настройки стрима", "fail",
      `Не заданы: ${missing.join(", ")}`,
      "Заполните переменные STREAM_* в .env (см. .env.example) и перезапустите V-Amber."));
    return { ok: false, steps };
  }
  steps.push(step("config", "Настройки стрима", "ok"));

  // 2. Сервер трансляции (MediaMTX за reverse-proxy на cloud).
  const mtx = await getStreamStatus();
  if (mtx.error) {
    steps.push(step("mediamtx", "Сервер трансляции", "fail", mtx.error,
      "Сервер вещания на cloud недоступен. Проверьте интернет; если не помогло — "
      + "на cloud: `cd ~/mediamtx && docker compose up -d` и статус nginx."));
    return { ok: false, steps };
  }
  steps.push(step("mediamtx", "Сервер трансляции", "ok",
    mtx.live ? "уже в эфире" : "готов, эфир не идёт"));

  // 3. OBS доступен (с автозапуском приложения при fix=true).
  let obs;
  try {
    if (fix) {
      const { state, launched } = await connectObsWithAutolaunch();
      obs = state;
      steps.push(step("obs", "OBS Studio", launched ? "fixed" : "ok",
        launched ? "OBS запущен автоматически" : "подключились к OBS"));
    } else {
      obs = await getObsState();
      steps.push(step("obs", "OBS Studio", "ok", "подключились к OBS"));
    }
  } catch (error) {
    const hint = error?.code === "auth_failed"
      ? "Пароль WebSocket в OBS не совпадает с OBS_WEBSOCKET_PASSWORD в .env."
      : OBS_DOWNLOAD_HINT;
    steps.push(step("obs", "OBS Studio", "fail", error?.message || String(error), hint));
    return { ok: false, steps };
  }

  // 4. Настройки трансляции в OBS (сервер + ключ). Чиним автоматически.
  const wantServer = config.stream.rtmpUrl;
  const wantKey = expectedObsKey();
  const matches = obs.serviceType === "rtmp_custom" && obs.server === wantServer && obs.key === wantKey;
  if (matches) {
    steps.push(step("obs_settings", "Настройки трансляции в OBS", "ok"));
  } else if (!fix) {
    steps.push(step("obs_settings", "Настройки трансляции в OBS", "fail",
      "адрес/ключ в OBS не совпадают с настройками V-Amber",
      "Нажмите «Запустить эфир» — настройки пропишутся автоматически."));
  } else if (obs.streaming) {
    // Пока OBS вещает, SetStreamServiceSettings менять нельзя — но раз эфир
    // уже идёт, содержимое настроек не важно до следующего запуска.
    steps.push(step("obs_settings", "Настройки трансляции в OBS", "ok",
      "OBS уже вещает — настройки не трогаем"));
  } else {
    try {
      await configureObsStream({ server: wantServer, key: wantKey });
      steps.push(step("obs_settings", "Настройки трансляции в OBS", "fixed",
        "адрес и ключ прописаны автоматически"));
    } catch (error) {
      steps.push(step("obs_settings", "Настройки трансляции в OBS", "fail",
        error?.message || String(error),
        "Пропишите в OBS вручную: Настройки → Трансляция → Пользовательский сервер."));
      return { ok: false, steps };
    }
  }

  return { ok: true, steps, obsStreaming: obs.streaming, mediamtxLive: Boolean(mtx.live) };
}

// Дубль эфира в ВК (best-effort): после того как свой поток пошёл, поднимаем
// ffmpeg-релей MediaMTX→ВК. Никогда не роняет запуск своего эфира — при
// проблеме добавляет шаг «fail», но overall остаётся ok. Когда VK не настроен
// (нет STREAM_VK_*), шаг не добавляется вовсе.
function startVkRelayStep(steps) {
  if (!isRelayConfigured()) return;
  const result = startRelay();
  if (result.ok) {
    steps.push(step("vk_relay", "Дубль в ВК", "ok",
      result.already ? "дубль в ВК уже идёт" : "поток дублируется в ВК Live"));
  } else {
    steps.push(step("vk_relay", "Дубль в ВК", "fail",
      result.message || result.code || "не удалось запустить дубль",
      "Проверьте ffmpeg (STREAM_FFMPEG_PATH) и RTMP-ключ ВК (STREAM_VK_*). "
      + "Свой эфир при этом идёт нормально."));
  }
}

// Полный запуск: preflight с автопочинкой → StartStream в OBS → ждём,
// пока MediaMTX подтвердит приём потока (ready:true).
export async function startBroadcast() {
  try {
    const pre = await preflightBroadcast({ fix: true });
    if (!pre.ok) return { ok: false, steps: pre.steps };

    if (pre.obsStreaming && pre.mediamtxLive) {
      pre.steps.push(step("publish", "Публикация потока", "ok", "эфир уже идёт"));
      startVkRelayStep(pre.steps);
      return { ok: true, steps: pre.steps, live: true };
    }

    if (!pre.obsStreaming) {
      try {
        await startObsStream();
      } catch (error) {
        pre.steps.push(step("publish", "Публикация потока", "fail",
          error?.message || String(error),
          "Не удалось стартовать трансляцию в OBS. Проверьте, что в OBS выбрана сцена с источниками."));
        return { ok: false, steps: pre.steps };
      }
    }

    // OBS подключается к RTMP не мгновенно: ждём подтверждения от MediaMTX.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const status = await getStreamStatus();
      if (status.live) {
        pre.steps.push(step("publish", "Публикация потока", "ok", "MediaMTX принимает поток"));
        startVkRelayStep(pre.steps);
        logger.info("stream", "broadcast_started", {});
        return { ok: true, steps: pre.steps, live: true };
      }
    }
    pre.steps.push(step("publish", "Публикация потока", "fail",
      "OBS стартовал, но сервер не подтвердил приём потока за 30 секунд",
      "Проверьте в OBS индикатор трансляции и лог (Справка → Файлы журнала)."));
    return { ok: false, steps: pre.steps };
  } catch (error) {
    // Страховка: наружу — только структурированный ответ.
    logger.error("stream", "broadcast_start_failed", { error: error?.message || String(error) });
    return { ok: false, steps: [step("internal", "Запуск эфира", "fail", error?.message || String(error))] };
  }
}

// Остановка: гасим публикацию в OBS. MediaMTX сам увидит разрыв потока.
export async function stopBroadcast() {
  // Гасим дубль в ВК всегда и первым делом: релей не должен продолжать
  // качать/лить поток после того, как оператор остановил эфир. Идемпотентно.
  const relayWasConfigured = isRelayConfigured();
  stopRelay();
  const relaySteps = relayWasConfigured
    ? [step("vk_relay", "Дубль в ВК", "ok", "дубль в ВК остановлен")]
    : [];
  try {
    try {
      const obs = await getObsState();
      if (!obs.streaming) {
        return { ok: true, steps: [step("publish", "Публикация потока", "ok", "эфир уже остановлен"), ...relaySteps] };
      }
    } catch {
      // OBS недоступен — значит и вещать он не может; считаем остановленным.
      return { ok: true, steps: [step("publish", "Публикация потока", "ok", "OBS не запущен — эфир не идёт"), ...relaySteps] };
    }
    await stopObsStream();
    logger.info("stream", "broadcast_stopped", {});
    return { ok: true, steps: [step("publish", "Публикация потока", "ok", "трансляция остановлена"), ...relaySteps] };
  } catch (error) {
    logger.error("stream", "broadcast_stop_failed", { error: error?.message || String(error) });
    return {
      ok: false,
      steps: [step("publish", "Публикация потока", "fail",
        error?.message || String(error),
        "Остановите трансляцию в OBS вручную (Stop Streaming).")],
    };
  }
}
