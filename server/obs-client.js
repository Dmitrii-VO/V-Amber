import crypto from "node:crypto";
import WebSocket from "ws";
import { config } from "./config.js";
import { logger } from "./logger.js";

// Минимальный клиент obs-websocket v5 (OBS Studio 28+). Каждая операция —
// отдельное короткоживущее соединение: никакого постоянного состояния,
// чтобы проблемы OBS не могли повлиять на основной поток V-Amber
// (голос/лоты/брони). Все пути обёрнуты таймаутом.

const OP = { HELLO: 0, IDENTIFY: 1, IDENTIFIED: 2, REQUEST: 6, RESPONSE: 7 };

// Ошибки с кодом для UI: оператор видит человеческую подсказку, не stack.
export class ObsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "unreachable" | "auth_failed" | "timeout" | "request_failed"
  }
}

function authToken(password, salt, challenge) {
  const secret = crypto.createHash("sha256").update(password + salt).digest("base64");
  return crypto.createHash("sha256").update(secret + challenge).digest("base64");
}

// Открывает соединение, проходит Hello→Identify→Identified, выполняет fn
// с функцией request(type, data) и закрывает сокет в любом исходе.
async function withObs(fn) {
  const { wsUrl, wsPassword, timeoutMs } = config.obs;
  const ws = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs });
  const pending = new Map(); // requestId -> {resolve, reject}
  let identified;
  const identifiedPromise = new Promise((resolve, reject) => { identified = { resolve, reject }; });

  const deadline = setTimeout(() => {
    identified.reject(new ObsError("timeout", `OBS не ответил за ${timeoutMs}мс`));
    ws.terminate();
  }, timeoutMs);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.op === OP.HELLO) {
      const identify = { op: OP.IDENTIFY, d: { rpcVersion: 1 } };
      if (msg.d?.authentication) {
        identify.d.authentication = authToken(
          wsPassword,
          msg.d.authentication.salt,
          msg.d.authentication.challenge,
        );
      }
      ws.send(JSON.stringify(identify));
    } else if (msg.op === OP.IDENTIFIED) {
      identified.resolve();
    } else if (msg.op === OP.RESPONSE) {
      const waiter = pending.get(msg.d?.requestId);
      if (!waiter) return;
      pending.delete(msg.d.requestId);
      if (msg.d.requestStatus?.result) {
        waiter.resolve(msg.d.responseData || {});
      } else {
        waiter.reject(new ObsError(
          "request_failed",
          `OBS отклонил ${msg.d.requestType}: ${msg.d.requestStatus?.comment || msg.d.requestStatus?.code}`,
        ));
      }
    }
  });

  ws.on("close", (code) => {
    // 4009 = AuthenticationFailed в obs-websocket v5.
    const error = code === 4009
      ? new ObsError("auth_failed", "OBS отклонил пароль WebSocket-сервера (проверьте OBS_WEBSOCKET_PASSWORD)")
      : new ObsError("unreachable", "OBS закрыл соединение");
    identified.reject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  ws.on("error", (error) => {
    const code = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/.test(error?.message || "")
      ? "unreachable"
      : "request_failed";
    identified.reject(new ObsError(code, error?.message || String(error)));
  });

  function request(requestType, requestData) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify({ op: OP.REQUEST, d: { requestType, requestId, requestData } }));
      setTimeout(() => {
        if (pending.delete(requestId)) {
          reject(new ObsError("timeout", `OBS не ответил на ${requestType} за ${timeoutMs}мс`));
        }
      }, timeoutMs).unref?.();
    });
  }

  try {
    await identifiedPromise;
    return await fn(request);
  } finally {
    clearTimeout(deadline);
    try { ws.close(); } catch { /* уже закрыт */ }
  }
}

// Снимок состояния OBS: доступен ли, идёт ли трансляция, куда настроен пуш.
export async function getObsState() {
  return withObs(async (request) => {
    const [stream, service] = await Promise.all([
      request("GetStreamStatus"),
      request("GetStreamServiceSettings"),
    ]);
    return {
      reachable: true,
      streaming: Boolean(stream.outputActive),
      serviceType: service.streamServiceType || "",
      server: service.streamServiceSettings?.server || "",
      key: service.streamServiceSettings?.key || "",
    };
  });
}

// Прописывает в OBS «Пользовательский сервер» с нашими RTMP-адресом и ключом.
export async function configureObsStream({ server, key }) {
  return withObs(async (request) => {
    await request("SetStreamServiceSettings", {
      streamServiceType: "rtmp_custom",
      streamServiceSettings: { server, key, use_auth: false },
    });
    logger.info("stream", "obs_stream_settings_applied", { server });
    return { ok: true };
  });
}

// --- Пресет качества и источников -------------------------------------
// Приводим OBS оператора к known-good состоянию: 1080p30, фиксированный
// битрейт, сцена с камерой и микрофоном подключённого айфона. Всё —
// в одном соединении; каждый шаг изолирован, сбой одного не отменяет
// остальные (возвращаем warnings, а не исключение).

// macOS-источники: v2 — новый AVCapture (OBS 30+), первый — легаси.
// В inputKind'ах OBS отдаёт версионированные имена, поэтому выбираем
// из того, что реально поддерживает эта сборка.
const CAMERA_KINDS = ["av_capture_input_v2", "av_capture_input"];
const MIC_KINDS = ["coreaudio_input_capture"];

// Ищем устройство в списке OBS по подстрокам имени (регистронезависимо).
// Порядок patterns — приоритет: первый совпавший паттерн выигрывает.
export function matchDevice(items, patterns) {
  const available = (items || []).filter((item) => item?.itemEnabled !== false && item?.itemValue);
  for (const pattern of patterns) {
    const needle = String(pattern).trim().toLowerCase();
    if (!needle) continue;
    const hit = available.find((item) => String(item.itemName || "").toLowerCase().includes(needle));
    if (hit) return { value: hit.itemValue, name: hit.itemName };
  }
  return null;
}

async function ensureVideoSettings(request, want, apply, report) {
  const current = await request("GetVideoSettings");
  const fpsOk = current.fpsNumerator === want.fps && current.fpsDenominator === 1;
  const sizeOk = current.baseWidth === want.width && current.baseHeight === want.height
    && current.outputWidth === want.width && current.outputHeight === want.height;
  if (fpsOk && sizeOk) return;

  const label = `${want.width}x${want.height} @ ${want.fps} fps`;
  if (!apply) {
    report.mismatches.push(`видео: ${current.outputWidth}x${current.outputHeight} @ `
      + `${Math.round(current.fpsNumerator / (current.fpsDenominator || 1))} fps вместо ${label}`);
    return;
  }
  await request("SetVideoSettings", {
    baseWidth: want.width,
    baseHeight: want.height,
    outputWidth: want.width,
    outputHeight: want.height,
    fpsNumerator: want.fps,
    fpsDenominator: 1,
  });
  report.changes.push(`видео ${label}`);
}

// Битрейт в OBS живёт в профиле. Надёжно читается/пишется только для
// простого режима вывода (в расширенном настройки энкодера лежат в
// отдельном json, недоступном через obs-websocket), поэтому пресет
// заодно возвращает профиль в «Простой» режим.
async function ensureBitrate(request, wantKbps, apply, report) {
  const mode = await request("GetProfileParameter", { parameterCategory: "Output", parameterName: "Mode" });
  const modeValue = mode.parameterValue ?? mode.defaultParameterValue;
  if (modeValue !== "Simple") {
    if (!apply) {
      report.mismatches.push(`режим вывода OBS «${modeValue}» вместо «Простой»`);
    } else {
      await request("SetProfileParameter", {
        parameterCategory: "Output", parameterName: "Mode", parameterValue: "Simple",
      });
      report.changes.push("режим вывода «Простой»");
    }
  }

  const current = await request("GetProfileParameter", {
    parameterCategory: "SimpleOutput", parameterName: "VBitrate",
  });
  const currentKbps = Number.parseInt(current.parameterValue ?? current.defaultParameterValue ?? "", 10);
  if (currentKbps === wantKbps) return;
  if (!apply) {
    report.mismatches.push(`битрейт ${currentKbps || "?"} вместо ${wantKbps} кбит/с`);
    return;
  }
  await request("SetProfileParameter", {
    parameterCategory: "SimpleOutput", parameterName: "VBitrate", parameterValue: String(wantKbps),
  });
  report.changes.push(`битрейт ${wantKbps} кбит/с`);
}

async function ensureScene(request, sceneName, apply, report) {
  const { scenes } = await request("GetSceneList");
  if ((scenes || []).some((scene) => scene.sceneName === sceneName)) return true;
  if (!apply) {
    report.mismatches.push(`нет сцены «${sceneName}»`);
    return false;
  }
  await request("CreateScene", { sceneName });
  await request("SetCurrentProgramScene", { sceneName });
  report.changes.push(`создана сцена «${sceneName}»`);
  return true;
}

// Источник = вход OBS с нужным устройством внутри. Создаём вход, если его
// нет, затем выбираем устройство из списка, который отдаёт сам OBS.
// deviceKey — ключ настройки входа («device» у камеры, «device_id» у аудио);
// он же имя свойства со списком устройств.
async function ensureDeviceInput(request, spec, apply, report) {
  const { inputName, kinds, deviceKey, patterns, sceneName, label } = spec;

  const { inputKinds } = await request("GetInputKindList");
  const kind = kinds.find((candidate) => (inputKinds || []).includes(candidate));
  if (!kind) {
    report.warnings.push(`${label}: OBS на этой платформе не умеет ${kinds[0]} `
      + "(источник настраивается только на macOS оператора)");
    return;
  }

  const { inputs } = await request("GetInputList");
  const existing = (inputs || []).find((input) => input.inputName === inputName);
  if (!existing) {
    if (!apply) {
      report.mismatches.push(`нет источника «${inputName}»`);
      return;
    }
    await request("CreateInput", {
      sceneName, inputName, inputKind: kind, inputSettings: {}, sceneItemEnabled: true,
    });
    report.changes.push(`создан источник «${inputName}»`);
  }

  const { propertyItems } = await request("GetInputPropertiesListPropertyItems", {
    inputName, propertyName: deviceKey,
  });
  const device = matchDevice(propertyItems, patterns);
  if (!device) {
    report.warnings.push(`${label}: устройство не найдено — подключите айфон `
      + `(искали «${patterns.join("», «")}» среди ${(propertyItems || []).length} устройств)`);
    return;
  }

  const { inputSettings } = await request("GetInputSettings", { inputName });
  if (inputSettings?.[deviceKey] === device.value) return;
  if (!apply) {
    report.mismatches.push(`${label}: выбрано не «${device.name}»`);
    return;
  }
  await request("SetInputSettings", {
    inputName, inputSettings: { [deviceKey]: device.value }, overlay: true,
  });
  report.changes.push(`${label}: «${device.name}»`);
}

// Применяет (apply=true) или только проверяет (apply=false) весь пресет.
// Никогда не бросает по отдельному шагу: собирает changes/mismatches/warnings.
export async function applyObsPreset(preset, options = {}) {
  return withObs((request) => runObsPreset(request, preset, options));
}

// Тело пресета отделено от соединения: принимает request(type, data), поэтому
// тестируется на фейковом OBS без сокета.
export async function runObsPreset(request, preset, { apply = true } = {}) {
  const report = { changes: [], mismatches: [], warnings: [] };

  const steps = [
    () => ensureVideoSettings(request, {
      width: preset.videoWidth, height: preset.videoHeight, fps: preset.videoFps,
    }, apply, report),
    () => ensureBitrate(request, preset.videoBitrateKbps, apply, report),
    async () => {
      const ready = await ensureScene(request, preset.sceneName, apply, report);
      // Источники создаются внутри сцены — без неё шаг бессмыслен.
      if (!ready) return;
      for (const spec of deviceSpecs(preset)) {
        try {
          await ensureDeviceInput(request, spec, apply, report);
        } catch (error) {
          report.warnings.push(`${spec.label}: ${error?.message || String(error)}`);
        }
      }
    },
  ];
  for (const run of steps) {
    try {
      await run();
    } catch (error) {
      report.warnings.push(error?.message || String(error));
    }
  }

  if (report.changes.length) {
    logger.info("stream", "obs_preset_applied", { changes: report.changes });
  }
  return report;
}

function deviceSpecs(preset) {
  return [
    {
      inputName: preset.cameraInputName, kinds: CAMERA_KINDS, deviceKey: "device",
      patterns: preset.cameraDeviceMatch, sceneName: preset.sceneName, label: "камера айфона",
    },
    {
      inputName: preset.micInputName, kinds: MIC_KINDS, deviceKey: "device_id",
      patterns: preset.micDeviceMatch, sceneName: preset.sceneName, label: "микрофон айфона",
    },
  ];
}

export async function startObsStream() {
  return withObs(async (request) => {
    await request("StartStream");
    logger.info("stream", "obs_stream_started", {});
    return { ok: true };
  });
}

export async function stopObsStream() {
  return withObs(async (request) => {
    await request("StopStream");
    logger.info("stream", "obs_stream_stopped", {});
    return { ok: true };
  });
}
