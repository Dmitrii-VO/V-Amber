// Чат зрителей для страницы /efir/ — мини-сервис без зависимостей (node:http).
// Живёт на cloud за nginx (location /chat/ → 127.0.0.1:8890), рядом с MediaMTX.
//
// Зритель входит с именем и ТЕЛЕФОНОМ (иначе бронь бесполезна — оператору
// не с кем связаться), получает token. Телефон никогда не отдаётся публичным
// эндпоинтам — только операторскому фиду под X-Chat-Token.
//
// Основной вход — «Войти через VK» (VK ID, OAuth 2.1 + PKCE, без секрета
// приложения): зритель получает свой НАСТОЯЩИЙ VK user id, и существующий
// маппинг контрагентов МойСклад по VK id (findCounterpartyByVkId /
// stampVkIdOnCounterparty в V-Amber) работает без изменений — повторный
// покупатель не задваивается. Имя и телефон берём из профиля VK ID.
//
// Запасной вход — имя+телефон (не у всех есть VK): такие зрители получают
// синтетический viewerId в диапазоне ID_BASE(9e9)+ — числовой, как у VK, но
// гарантированно не пересекающийся с реальными VK id (< 2^31), поэтому
// денежный путь V-Amber (контрагенты, dedup, отмены) работает и для них —
// просто контрагент заводится новый. commentId сообщений всегда 9e9+seq.

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT) || 8890;
const DATA_DIR = process.env.DATA_DIR || "./data";
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "";
// VK ID (id.vk.com): приложение создаётся владельцем аккаунта VK, сюда идёт
// его client_id. Без VK_APP_ID кнопка «Войти через VK» на странице скрыта,
// остаётся только вход по телефону.
const VK_APP_ID = process.env.VK_APP_ID || "";
// Публичный origin страницы/сервиса — из него собирается redirect_uri
// (должен буква-в-букву совпадать с настройкой в кабинете VK ID).
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
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
// Граница текущей "сессии" эфира — seq последней kind:"session" записи.
// Ничего не удаляется из messages.jsonl; это только нижняя граница для
// публичной ленты (/chat/messages), так что и дашборд, и /efir/ начинают
// показывать чат с чистого листа после «Новая сессия», а прошлые эфиры
// остаются в файле для восстановления при необходимости.
let sessionStartSeq = 0;

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
  // Счётчик — только по синтетическим id телефонного входа; реальные VK id
  // (< ID_BASE) в нумерации не участвуют.
  if (record.id > ID_BASE) {
    lastViewerNo = Math.max(lastViewerNo, record.id - ID_BASE);
  }
});

loadJsonl(messagesPath, (record) => {
  if (!Number.isFinite(record?.seq)) return;
  messages.push(record);
  lastSeq = Math.max(lastSeq, record.seq);
  if (record.kind === "session") sessionStartSeq = Math.max(sessionStartSeq, record.seq);
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

// ── VK ID (OAuth 2.1 + PKCE) ───────────────────────────────────────────────
// Публичный клиент: обмен кода идёт с code_verifier, секрет приложения не
// нужен и на сервере не хранится. state→verifier живут в памяти 10 минут.
const pendingVkAuth = new Map(); // state → { verifier, ts }
const VK_AUTH_TTL_MS = 10 * 60_000;

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function vkRedirectUri() {
  return `${PUBLIC_BASE_URL}/chat/auth/vk/callback`;
}

function vkAuthEnabled() {
  return Boolean(VK_APP_ID && PUBLIC_BASE_URL);
}

function pruneVkAuth() {
  const now = Date.now();
  for (const [state, entry] of pendingVkAuth) {
    if (now - entry.ts > VK_AUTH_TTL_MS) pendingVkAuth.delete(state);
  }
}

// Выдаёт (или переиспользует) зрителя и новый token. VK-вход дедупится по
// реальному VK id: повторный вход того же человека обновляет имя/телефон,
// но зритель (и контрагент в МойСкладе) остаётся тем же.
function registerViewer({ id, name, phone, authVia, ip }) {
  const existing = viewersById.get(id);
  const viewer = existing || { id, name, phone };
  viewer.name = name || viewer.name;
  viewer.phone = phone || viewer.phone;
  const token = randomBytes(24).toString("hex");
  viewersByToken.set(token, viewer);
  viewersById.set(viewer.id, viewer);
  appendFileSync(
    viewersPath,
    JSON.stringify({ ...viewer, token, authVia, ts: Date.now(), ip }) + "\n",
    "utf8",
  );
  return { viewer, token };
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
      return sendJson(response, 200, {
        ok: true, messages: messages.length, viewers: viewersById.size, sessionStartSeq,
      });
    }

    if (route === "GET /chat/config") {
      // Странице нужно знать, показывать ли кнопку «Войти через VK».
      return sendJson(response, 200, { vkAuth: vkAuthEnabled() });
    }

    if (route === "GET /chat/auth/vk/start") {
      if (!vkAuthEnabled()) return sendJson(response, 404, { error: "vk auth disabled" });
      pruneVkAuth();
      const state = base64url(randomBytes(24));
      const verifier = base64url(randomBytes(32));
      pendingVkAuth.set(state, { verifier, ts: Date.now() });
      const authUrl = new URL("https://id.vk.com/authorize");
      authUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: VK_APP_ID,
        redirect_uri: vkRedirectUri(),
        state,
        code_challenge: base64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
        // vkid.personal_info — имя; phone — верифицированный телефон (зритель
        // подтверждает передачу на экране VK; без согласия телефон не придёт,
        // тогда бронь остаётся с контактом через VK id).
        scope: "vkid.personal_info phone",
      }).toString();
      response.writeHead(302, { Location: authUrl.toString(), "Cache-Control": "no-store" });
      return response.end();
    }

    if (route === "GET /chat/auth/vk/callback") {
      if (!vkAuthEnabled()) return sendJson(response, 404, { error: "vk auth disabled" });
      const fail = (reason) => {
        console.error("vk_auth_failed", reason);
        response.writeHead(302, { Location: "/efir/#chatAuthError", "Cache-Control": "no-store" });
        return response.end();
      };

      pruneVkAuth();
      const state = url.searchParams.get("state") || "";
      const code = url.searchParams.get("code") || "";
      const deviceId = url.searchParams.get("device_id") || "";
      const pending = pendingVkAuth.get(state);
      if (!pending || !code) return fail("bad_state_or_code");
      pendingVkAuth.delete(state);

      // Обмен кода на токен (PKCE, без секрета) и запрос профиля.
      const tokenResponse = await fetch("https://id.vk.com/oauth2/auth", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: pending.verifier,
          client_id: VK_APP_ID,
          device_id: deviceId,
          redirect_uri: vkRedirectUri(),
          state,
        }).toString(),
      });
      const tokenData = await tokenResponse.json().catch(() => null);
      const vkUserId = Number(tokenData?.user_id);
      if (!tokenResponse.ok || !tokenData?.access_token || !Number.isFinite(vkUserId) || vkUserId <= 0) {
        return fail(`token_exchange: ${tokenData?.error_description || tokenData?.error || tokenResponse.status}`);
      }

      let name = "";
      let phone = "";
      const infoResponse = await fetch("https://id.vk.com/oauth2/user_info", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          access_token: tokenData.access_token,
          client_id: VK_APP_ID,
        }).toString(),
      });
      const infoData = await infoResponse.json().catch(() => null);
      if (infoResponse.ok && infoData?.user) {
        name = [infoData.user.first_name, infoData.user.last_name].filter(Boolean).join(" ").trim();
        phone = normalizePhone(infoData.user.phone) || "";
      }
      // Профиль недоступен — не валим вход: id есть, маппинг в МойСклад
      // работает, а имя зритель увидит плейсхолдерное.
      if (!name) name = `id${vkUserId}`;

      const { viewer, token } = registerViewer({
        id: vkUserId,
        name: name.slice(0, MAX_NAME_LENGTH),
        phone,
        authVia: "vk",
        ip: clientIp(request),
      });

      // Токен передаём через URL-фрагмент (/efir/#chatAuth=<base64url(json)>):
      // страница-мостик с инлайн-скриптом запрещена CSP vhost'а
      // (script-src 'self'), а фрагмент на сервер не уходит — app.js страницы
      // кладёт его в localStorage и сразу вычищает из адресной строки.
      const payload = base64url(Buffer.from(JSON.stringify({ token, name: viewer.name }), "utf8"));
      response.writeHead(302, {
        Location: `/efir/#chatAuth=${payload}`,
        "Cache-Control": "no-store",
      });
      return response.end();
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
      const { viewer, token } = registerViewer({
        id: ID_BASE + lastViewerNo,
        name,
        phone,
        authVia: "phone",
        ip: clientIp(request),
      });
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
      // Никогда не отдаём раньше sessionStartSeq — даже клиенту со старым
      // курсором с прошлой сессии — так «Новая сессия» реально скрывает
      // прошлый чат и у оператора, и у зрителей на /efir/.
      const inSession = messages.filter((m) => m.seq >= sessionStartSeq);
      const slice = Number.isFinite(after)
        ? inSession.filter((m) => m.seq > after).slice(0, PUBLIC_PAGE_SIZE)
        : inSession.slice(-50);
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

    // Оператор нажал «Новая сессия» при старте эфира: помечаем границу — сама
    // история никуда не девается, но /chat/messages (и дашборд, и /efir/)
    // перестаёт отдавать что-либо раньше этого seq.
    if (route === "POST /chat/session/new") {
      if (!isOperator(request)) return sendJson(response, 401, { error: "unauthorized" });
      const record = appendMessage({ viewerId: null, name: SERVICE_NAME, text: "Новая сессия", kind: "session" });
      sessionStartSeq = record.seq;
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
