// Чат зрителей для страницы /efir/ — мини-сервис без зависимостей (node:http).
// Живёт на cloud за nginx (location /chat/ → 127.0.0.1:8890), рядом с MediaMTX.
//
// Зритель входит с именем и ТЕЛЕФОНОМ (иначе бронь бесполезна — оператору
// не с кем связаться), получает token. Телефон никогда не отдаётся публичным
// эндпоинтам — только операторскому фиду под X-Chat-Token.
//
// Идентификаторы для V-Amber: viewerId и commentId живут в диапазоне
// ID_BASE(9e9)+ — числовые, как у VK, но гарантированно не пересекаются с
// реальными VK id (< 2^31). Благодаря этому весь денежный путь V-Amber
// (контрагенты, dedup, отмены) работает с чатом без изменений.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT) || 8890;
const DATA_DIR = process.env.DATA_DIR || "./data";
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "";
const ID_BASE = 9_000_000_000;
const MAX_TEXT_LENGTH = 300;
const MAX_NAME_LENGTH = 40;
const MESSAGE_RATE_MS = 1500; // мин. интервал между сообщениями одного зрителя
const JOIN_RATE_PER_MIN = 5;  // максимум join'ов с одного IP в минуту
const PUBLIC_PAGE_SIZE = 100;
const SERVICE_NAME = "Янтарь";

if (!OPERATOR_TOKEN) {
  console.error("OPERATOR_TOKEN is required (X-Chat-Token secret for the operator feed)");
  process.exit(1);
}

mkdirSync(DATA_DIR, { recursive: true });
const viewersPath = join(DATA_DIR, "viewers.jsonl");
const messagesPath = join(DATA_DIR, "messages.jsonl");

// ── Состояние (грузится из JSONL при старте; каждый чат-эфир — сотни строк,
// целиком в памяти это копейки) ─────────────────────────────────────────────
const viewersByToken = new Map(); // token → {id, name, phone}
const viewersById = new Map();    // id → {id, name, phone}
const messages = [];              // {seq, ts, viewerId|null, name, text, kind}
let lastSeq = 0;
let lastViewerNo = 0;

function loadJsonl(path, onRecord) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { onRecord(JSON.parse(line)); } catch { /* повреждённая строка — пропуск */ }
  }
}

loadJsonl(viewersPath, (record) => {
  if (!record?.token || !record?.id) return;
  const viewer = { id: record.id, name: record.name || "", phone: record.phone || "" };
  viewersByToken.set(record.token, viewer);
  viewersById.set(viewer.id, viewer);
  lastViewerNo = Math.max(lastViewerNo, record.id - ID_BASE);
});

loadJsonl(messagesPath, (record) => {
  if (!Number.isFinite(record?.seq)) return;
  messages.push(record);
  lastSeq = Math.max(lastSeq, record.seq);
});

// ── Рейт-лимиты (в памяти; сброс при рестарте допустим) ────────────────────
const lastMessageAtByToken = new Map();
const joinTimestampsByIp = new Map();

function joinAllowed(ip) {
  const now = Date.now();
  const stamps = (joinTimestampsByIp.get(ip) || []).filter((ts) => now - ts < 60_000);
  if (stamps.length >= JOIN_RATE_PER_MIN) return false;
  stamps.push(now);
  joinTimestampsByIp.set(ip, stamps);
  return true;
}

// ── Валидация ──────────────────────────────────────────────────────────────
function normalizeName(raw) {
  const name = String(raw || "").replace(/\s+/g, " ").trim();
  return name.length >= 2 && name.length <= MAX_NAME_LENGTH ? name : null;
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  // РФ-нормализация: 8XXXXXXXXXX → +7XXXXXXXXXX; остальное — как есть с "+".
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  return `+${digits}`;
}

// ── HTTP-помощники ─────────────────────────────────────────────────────────
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { resolve(null); }
    });
    request.on("error", () => resolve(null));
  });
}

function isOperator(request) {
  return request.headers["x-chat-token"] === OPERATOR_TOKEN;
}

function clientIp(request) {
  // За nginx реальный адрес в X-Real-IP / первый X-Forwarded-For.
  return String(request.headers["x-real-ip"]
    || String(request.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || request.socket.remoteAddress
    || "unknown");
}

function appendMessage({ viewerId, name, text, kind }) {
  lastSeq += 1;
  const record = { seq: lastSeq, ts: Date.now(), viewerId, name, text, kind };
  messages.push(record);
  appendFileSync(messagesPath, JSON.stringify(record) + "\n", "utf8");
  return record;
}

function publicMessage(record) {
  return { seq: record.seq, ts: record.ts, name: record.name, text: record.text, kind: record.kind };
}

// ── Роутинг ────────────────────────────────────────────────────────────────
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const route = `${request.method} ${url.pathname.replace(/\/+$/, "")}`;

  try {
    if (route === "GET /chat/health") {
      return sendJson(response, 200, { ok: true, messages: messages.length, viewers: viewersById.size });
    }

    if (route === "POST /chat/join") {
      if (!joinAllowed(clientIp(request))) {
        return sendJson(response, 429, { error: "Слишком много попыток входа, подождите минуту" });
      }
      const body = await readJsonBody(request);
      const name = normalizeName(body?.name);
      const phone = normalizePhone(body?.phone);
      if (!name) return sendJson(response, 400, { error: "Укажите имя (2–40 символов)" });
      if (!phone) return sendJson(response, 400, { error: "Укажите телефон — по нему мы свяжемся по брони" });

      lastViewerNo += 1;
      const viewer = { id: ID_BASE + lastViewerNo, name, phone };
      const token = randomBytes(24).toString("hex");
      viewersByToken.set(token, viewer);
      viewersById.set(viewer.id, viewer);
      appendFileSync(viewersPath, JSON.stringify({ ...viewer, token, ts: Date.now(), ip: clientIp(request) }) + "\n", "utf8");
      return sendJson(response, 200, { token, name: viewer.name });
    }

    if (route === "POST /chat/messages") {
      const body = await readJsonBody(request);
      const viewer = viewersByToken.get(String(body?.token || request.headers["x-chat-viewer"] || ""));
      if (!viewer) return sendJson(response, 401, { error: "Представьтесь, чтобы писать в чат" });

      const text = String(body?.text || "").replace(/\s+/g, " ").trim();
      if (!text) return sendJson(response, 400, { error: "Пустое сообщение" });
      if (text.length > MAX_TEXT_LENGTH) {
        return sendJson(response, 400, { error: `Сообщение длиннее ${MAX_TEXT_LENGTH} символов` });
      }

      const lastAt = lastMessageAtByToken.get(body.token) || 0;
      if (Date.now() - lastAt < MESSAGE_RATE_MS) {
        return sendJson(response, 429, { error: "Не так быстро :)" });
      }
      lastMessageAtByToken.set(body.token, Date.now());

      const record = appendMessage({ viewerId: viewer.id, name: viewer.name, text, kind: "viewer" });
      return sendJson(response, 200, { seq: record.seq });
    }

    if (route === "GET /chat/messages") {
      const after = Number(url.searchParams.get("after"));
      const slice = Number.isFinite(after)
        ? messages.filter((m) => m.seq > after).slice(0, PUBLIC_PAGE_SIZE)
        : messages.slice(-50);
      return sendJson(response, 200, { latestSeq: lastSeq, messages: slice.map(publicMessage) });
    }

    if (route === "GET /chat/feed") {
      if (!isOperator(request)) return sendJson(response, 401, { error: "unauthorized" });
      const afterParam = url.searchParams.get("after");
      const after = Number(afterParam);
      // Без after — только инициализация курсора V-Amber (историю не отдаём).
      const slice = afterParam === null || !Number.isFinite(after)
        ? []
        : messages.filter((m) => m.kind === "viewer" && m.seq > after).slice(0, PUBLIC_PAGE_SIZE);
      return sendJson(response, 200, {
        latestSeq: lastSeq,
        messages: slice.map((record) => ({
          seq: record.seq,
          commentId: ID_BASE + record.seq,
          viewerId: record.viewerId,
          name: record.name,
          phone: viewersById.get(record.viewerId)?.phone || "",
          text: record.text,
          ts: record.ts,
        })),
      });
    }

    if (route === "POST /chat/service") {
      if (!isOperator(request)) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      const text = String(body?.text || "").trim().slice(0, MAX_TEXT_LENGTH);
      if (!text) return sendJson(response, 400, { error: "empty text" });
      const record = appendMessage({ viewerId: null, name: SERVICE_NAME, text, kind: "service" });
      return sendJson(response, 200, { seq: record.seq });
    }

    return sendJson(response, 404, { error: "not found" });
  } catch (error) {
    console.error("request_failed", request.method, url.pathname, error?.message || error);
    return sendJson(response, 500, { error: "internal" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`chat-service listening on :${PORT}, ${messages.length} messages, ${viewersById.size} viewers loaded`);
});
