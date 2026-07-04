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
