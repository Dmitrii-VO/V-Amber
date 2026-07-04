import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomInt, createHash } from "node:crypto";
import { logger } from "./logger.js";
import { isSafeMode, setSafeMode } from "./safe-mode.js";
import { buildLogBundle, listBundleFiles } from "./log-bundle.js";
import { createReservationDigestLog } from "./reservation-digest-log.js";
import { createAuth } from "./auth.js";
import { getStreamStatus } from "./stream-status.js";
import { preflightBroadcast, startBroadcast, stopBroadcast } from "./stream-orchestrator.js";

const SEND_LOGS_MAX_BODY = 16 * 1024;
const SEND_LOGS_TIMEOUT_MS = 60 * 1000;
const WISHLIST_MAX_BODY = 256 * 1024;
const DIGEST_MAX_BODY = 64 * 1024;
const SUPPLIERS_CACHE_TTL_MS = 5 * 60 * 1000;
const CHECK_ORDERS_CACHE_TTL_MS = 10 * 60 * 1000;
const CHECK_ORDERS_CACHE_MAX = 1000;

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const webRoot = normalize(join(__dirname, "..", "web-ui"));
const webRootPrefix = `${webRoot}${sep}`;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function resolveAssetPath(urlPathname) {
  const relativePath = urlPathname === "/" ? "/index.html" : urlPathname;
  const resolvedPath = normalize(join(webRoot, relativePath));

  if (resolvedPath !== webRoot && !resolvedPath.startsWith(webRootPrefix)) {
    return null;
  }

  return resolvedPath;
}

function readJsonBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        request.destroy();
        reject(new Error("body_too_large"));
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function methodNotAllowed(response, allow) {
  response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow });
  response.end(JSON.stringify({ error: "method_not_allowed" }));
}

// Канонический объект группы → детерминированный sha256. Поля стабильные:
// supplierId, storeId, positions (отсортированы по productId, entryIds лекс).
// description НЕ включается — правка комментария оператором не должна ломать
// retry partial-fail.
function computeGroupHash(group) {
  const canonical = {
    supplierId: group.supplierId || null,
    storeId: group.storeId || null,
    positions: (group.positions || [])
      .map((p) => ({
        productId: p.productId || null,
        quantity: Number(p.quantity) || 0,
        price: Number(p.price) || 0,
        entryIds: [...(p.entryIds || [])].sort(),
      }))
      .sort((a, b) => String(a.productId || "").localeCompare(String(b.productId || ""))),
  };
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function computeDigestHash(client) {
  const canonical = {
    orderIds: [...(client.orderIds || [])].sort(),
    positions: (client.positions || [])
      .map((p) => ({
        productId: p.productId || null,
        productCode: p.productCode || "",
        productName: p.productName || "",
        quantity: Number(p.quantity) || 0,
        price: Number(p.price) || 0,
        sum: Number(p.sum) || 0,
      }))
      .sort((a, b) => `${a.productId || ""}:${a.productCode}`.localeCompare(`${b.productId || ""}:${b.productCode}`)),
    total: Number(client.total) || 0,
  };
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function formatDigestDate(date) {
  const [, , month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "") || [];
  return day && month ? `${day}.${month}` : date;
}

function formatRub(value) {
  return `${new Intl.NumberFormat("ru-RU").format(Math.round(Number(value) || 0))} ₽`;
}

function buildReservationDigestMessage(date, client, updated = false) {
  const dateLabel = formatDigestDate(date);
  const lines = [
    updated
      ? `Обновленная сводка броней за эфир ${dateLabel}:`
      : `Ваши брони за эфир ${dateLabel}:`,
    "",
  ];
  (client.positions || []).forEach((position, index) => {
    const code = position.productCode || "без артикула";
    const name = position.productName || "Товар";
    const qty = Number(position.quantity) || 0;
    lines.push(`${index + 1}. ${code} — ${name}, ${qty} шт, ${formatRub(position.sum)}`);
  });
  lines.push("", `Итого: ${formatRub(client.total)}`, "Если нужно что-то изменить, напишите сюда.");
  return lines.join("\n");
}

async function enrichDigestWithSendState(digest, sendLog) {
  const clients = [];
  for (const client of digest.clients || []) {
    const digestHash = computeDigestHash(client);
    const sendKey = client.viewerId ? `${digest.date}:${client.viewerId}:${digestHash}` : null;
    const alreadySent = sendKey ? await sendLog.has(sendKey) : false;
    const hasPriorSend = client.viewerId ? await sendLog.hasAnyFor(digest.date, client.viewerId) : false;
    clients.push({
      ...client,
      digestHash,
      sendKey,
      alreadySent,
      hasPriorSend,
      canSend: Boolean(client.canSend && !alreadySent),
      cannotSendReason: alreadySent ? "already_sent" : client.cannotSendReason,
      message: client.viewerId
        ? buildReservationDigestMessage(digest.date, client, hasPriorSend && !alreadySent)
        : "",
    });
  }
  return { ...digest, clients };
}

function serializeWishlistEntry(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    viewerId: entry.viewerId,
    viewerName: entry.viewerName,
    productCode: entry.productCode,
    productId: entry.productId,
    productName: entry.productName,
    supplierId: entry.supplierId,
    supplierName: entry.supplierName,
    buyPrice: entry.buyPrice,
    salePrice: entry.salePrice,
    discountAmount: entry.discountAmount,
    effectivePrice: entry.effectivePrice,
    quantity: entry.quantity,
    lotCode: entry.lotCode,
    lotSessionId: entry.lotSessionId,
    trigger: entry.trigger,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    seenEvents: entry.seenEvents || [],
    status: entry.status,
    consumed: entry.consumed || null,
    removedReason: entry.removedReason || null,
  };
}

export function createStaticServer({
  vk, moysklad, productCodeCache, config,
  wishlistStore, wishlistSubmissions, settingsStore, diagnosticRouter, packageVersion,
} = {}) {
  function diag(kind, payload) {
    if (diagnosticRouter?.emitGeneric) diagnosticRouter.emitGeneric(kind, payload);
  }
  let logsInFlight = false;
  const reservationDigestLog = createReservationDigestLog();
  const auth = createAuth();

  // Кэш списков из МС, чтобы операторские открытия модалки не били в МС каждый раз.
  let suppliersCache = null;
  let storesCache = null;

  // Кэш «уже-в-заказе»-проверок. Ключ = `${counterpartyId}:${productId}`,
  // значение = { result, expiresAt }. Кэш переживает несколько последовательных
  // нажатий «🔍 Проверить пересечения» в течение 10 минут.
  const checkOrdersCache = new Map();
  function getCachedCheck(key) {
    const entry = checkOrdersCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      checkOrdersCache.delete(key);
      return null;
    }
    return entry.result;
  }
  function setCachedCheck(key, result) {
    // LRU-стиль на Map: повторная установка двигает ключ в конец;
    // при переполнении удаляем самый старый. Это защищает от роста Map
    // при долгой работе с тысячами уникальных (counterparty, product) пар.
    if (checkOrdersCache.has(key)) checkOrdersCache.delete(key);
    checkOrdersCache.set(key, { result, expiresAt: Date.now() + CHECK_ORDERS_CACHE_TTL_MS });
    if (checkOrdersCache.size > CHECK_ORDERS_CACHE_MAX) {
      const oldestKey = checkOrdersCache.keys().next().value;
      if (oldestKey !== undefined) checkOrdersCache.delete(oldestKey);
    }
  }

  async function loadSuppliersCached() {
    if (suppliersCache && Date.now() - suppliersCache.loadedAt < SUPPLIERS_CACHE_TTL_MS) {
      return suppliersCache.rows;
    }
    const rows = await moysklad.listSuppliers({ source: "http" });
    suppliersCache = { rows, loadedAt: Date.now() };
    return rows;
  }
  async function loadStoresCached() {
    if (storesCache && Date.now() - storesCache.loadedAt < SUPPLIERS_CACHE_TTL_MS) {
      return storesCache.rows;
    }
    const rows = await moysklad.listStores({ source: "http" });
    storesCache = { rows, loadedAt: Date.now() };
    return rows;
  }

  function buildGroupedWishlist() {
    const groups = wishlistStore.listByGroupedSupplier();
    const wishlistSettings = settingsStore.getWishlist();
    const oldThresholdMs = (wishlistSettings.oldDaysThreshold || 7) * 24 * 60 * 60 * 1000;
    const now = Date.now();

    return groups.map((g) => ({
      supplierId: g.supplierId,
      supplierName: g.supplierName,
      entries: g.entries.map((e) => ({
        ...serializeWishlistEntry(e),
        isOld: now - new Date(e.createdAt).getTime() > oldThresholdMs,
      })),
    }));
  }

  return createServer(async (request, response) => {
    if (!request.url) {
      response.writeHead(400).end("Bad request");
      return;
    }

    let pathname;
    let urlObject;
    try {
      urlObject = new URL(request.url, "http://localhost");
      ({ pathname } = urlObject);
    } catch {
      logger.warn("http", "bad_request_url", { url: request.url });
      response.writeHead(400).end("Bad request");
      return;
    }

    if (pathname === "/health") {
      // Лёгкий healthcheck: не пингуем внешние API (МойСклад/VK/SpeechKit), а
      // отчитываемся о последнем известном состоянии. Это даёт оркестратору
      // сигнал о деградации без дополнительной нагрузки на чужие квоты.
      const snapshot = productCodeCache?.getSnapshot?.() || {};
      const moyskladStatus = snapshot.lastError
        ? "error"
        : (snapshot.loadedAt ? "ok" : "unknown");
      const vkStatus = config?.vk?.token ? "configured" : "missing_token";
      const speechkitStatus = config?.speechkit?.apiKey ? "configured" : "missing_key";
      const subsystems = {
        moysklad: {
          status: moyskladStatus,
          loadedAt: snapshot.loadedAt || null,
          productCount: snapshot.count || 0,
          lastError: snapshot.lastError || null,
          refreshing: Boolean(snapshot.refreshing),
        },
        vk: { status: vkStatus },
        speechkit: { status: speechkitStatus },
        safeMode: isSafeMode(),
      };
      const ok = moyskladStatus !== "error" && vkStatus !== "missing_token" && speechkitStatus !== "missing_key";
      response.writeHead(ok ? 200 : 503, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok, version: packageVersion || null, subsystems }));
      return;
    }

    // POST /login: small fallback form for operators who arrived without a
    // token-bearing URL. Body is application/x-www-form-urlencoded with a
    // single `token=` field. On match we set the cookie and redirect to /.
    if (auth.enabled && pathname === "/login" && request.method === "POST") {
      try {
        const body = await new Promise((resolve, reject) => {
          let buf = "";
          request.on("data", (chunk) => {
            buf += chunk;
            if (buf.length > 4096) {
              request.destroy();
              reject(new Error("body_too_large"));
            }
          });
          request.on("end", () => resolve(buf));
          request.on("error", reject);
        });
        const params = new URLSearchParams(body);
        const submittedUrl = new URL(`/?token=${encodeURIComponent(params.get("token") || "")}`, "http://localhost");
        if (auth.isRequestAuthenticated(request, submittedUrl)) {
          auth.setTokenCookie(response);
          response.writeHead(302, { location: "/" });
          response.end();
        } else {
          response.writeHead(303, { location: "/login?error=1" });
          response.end();
        }
      } catch {
        response.writeHead(400).end("Bad request");
      }
      return;
    }

    // Auth check: API endpoints require token when API_TOKEN is set.
    // Static assets allow auth via ?token=<value> query — cookie is set
    // and the user is redirected back without the token in the URL.
    if (auth.enabled) {
      const authed = auth.isRequestAuthenticated(request, urlObject);
      const isApi = pathname.startsWith("/api/");
      const isLogin = pathname === "/login";
      if (isApi) {
        if (!authed) {
          logger.warn("http", "unauthorized_api_request", { pathname, method: request.method });
          jsonResponse(response, 401, { error: "unauthorized" });
          return;
        }
      } else if (urlObject.searchParams.has("token")) {
        if (authed) {
          auth.setTokenCookie(response);
          const cleanUrl = new URL(urlObject.toString());
          cleanUrl.searchParams.delete("token");
          response.writeHead(302, { location: cleanUrl.pathname + cleanUrl.search });
          response.end();
        } else {
          response.writeHead(303, { location: "/login?error=1" });
          response.end();
        }
        return;
      } else if (isLogin) {
        // GET /login — render the form. No external assets, no scripts.
        const errored = urlObject.searchParams.get("error") === "1";
        const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Вход — V-Amber</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
form{background:#1a1d24;border:1px solid #2a2f3a;border-radius:8px;padding:24px;min-width:320px;display:flex;flex-direction:column;gap:12px}
h1{margin:0 0 4px;font-size:18px}
input{padding:10px;border-radius:6px;border:1px solid #2a2f3a;background:#0f1115;color:#e5e7eb;font-size:14px}
button{padding:10px;border-radius:6px;border:0;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer;font-size:14px}
.err{color:#f87171;font-size:13px}
.hint{color:#9ca3af;font-size:12px}
</style></head>
<body><form method="post" action="/login">
<h1>Вход в V-Amber</h1>
${errored ? '<div class="err">Неверный токен. Проверьте значение API_TOKEN.</div>' : ""}
<input type="password" name="token" autofocus required placeholder="API_TOKEN" autocomplete="off" />
<button type="submit">Войти</button>
<div class="hint">Токен задаётся в .env (переменная API_TOKEN). Если потеряли — посмотрите файл .env на сервере.</div>
</form></body></html>`;
        response.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      } else if (!authed) {
        response.writeHead(302, { location: "/login" });
        response.end();
        return;
      }
    }

    if (pathname === "/api/vk/validate-url") {
      if (request.method !== "GET") return methodNotAllowed(response, "GET");
      const url = urlObject.searchParams.get("url") || "";
      try {
        const result = vk?.validateLiveVideoUrl
          ? await vk.validateLiveVideoUrl(url)
          : { ok: false, code: "vk_disabled", message: "VK integration unavailable" };
        jsonResponse(response, 200, result);
      } catch (error) {
        logger.error("http", "vk_validate_failed", { error: error?.message || String(error) });
        jsonResponse(response, 500, { ok: false, code: "internal_error", message: error?.message || String(error) });
      }
      return;
    }

    if (pathname === "/api/product-codes/status") {
      if (request.method !== "GET") return methodNotAllowed(response, "GET");
      jsonResponse(response, 200, productCodeCache?.getSnapshot?.() || { count: 0, loadedAt: null, refreshing: false });
      return;
    }

    if (pathname === "/api/product-codes/refresh") {
      if (request.method !== "POST") return methodNotAllowed(response, "POST");
      try {
        const result = productCodeCache?.refresh
          ? await productCodeCache.refresh(moysklad, { source: "http" })
          : { count: 0, loadedAt: null, refreshing: false, lastError: "product_code_cache_unavailable" };
        jsonResponse(response, 200, { ok: true, ...result });
      } catch (error) {
        jsonResponse(response, 500, { ok: false, error: error?.message || String(error) });
      }
      return;
    }

    if (pathname === "/api/stream/config") {
      if (request.method !== "GET") return methodNotAllowed(response, "GET");
      if (!config?.stream?.apiUrl) {
        jsonResponse(response, 200, { configured: false });
        return;
      }
      // Публикационный пароль MediaMTX — реальная инфраструктурная секрета.
      // Без API_TOKEN /api/* не защищён никак (см. auth.enabled в server/auth.js),
      // поэтому отдаём креды только когда сервер сам требует токен на вход —
      // иначе любой, кто достучится до дашборда, получил бы ключ публикации.
      if (!auth.enabled) {
        jsonResponse(response, 200, {
          configured: true,
          credentialsHidden: true,
          rtmpUrl: config.stream.rtmpUrl,
          viewerUrl: config.stream.viewerUrl,
        });
        return;
      }
      jsonResponse(response, 200, {
        configured: true,
        rtmpUrl: config.stream.rtmpUrl,
        publishUser: config.stream.publishUser,
        publishPass: config.stream.publishPass,
        // MediaMTX's authInternalUsers checks user AND pass together, but
        // OBS's "Server"/"Stream Key" split has no separate user field —
        // both must travel in the key as query params on the path name.
        // STREAM_RTMP_URL is expected to be the bare server (no path) so
        // OBS's Server+"/"+Key concatenation lands on the right path.
        obsStreamKey: `${config.stream.pathName}?user=${encodeURIComponent(config.stream.publishUser)}&pass=${encodeURIComponent(config.stream.publishPass)}`,
        viewerUrl: config.stream.viewerUrl,
      });
      return;
    }

    if (pathname === "/api/stream/status") {
      if (request.method !== "GET") return methodNotAllowed(response, "GET");
      try {
        const result = await getStreamStatus();
        jsonResponse(response, 200, result);
      } catch (error) {
        // getStreamStatus() degrades internally on any network/API failure,
        // so this only fires on a bug in getStreamStatus itself. Keep the
        // response shape identical to its normal error payload so callers
        // never need to branch on status code.
        logger.error("http", "stream_status_failed", { error: error?.message || String(error) });
        jsonResponse(response, 200, {
          configured: true,
          live: false,
          readers: 0,
          error: error?.message || String(error),
        });
      }
      return;
    }

    // Оркестрация эфира «одной кнопкой». Все три роута никогда не бросают:
    // stream-orchestrator.js возвращает структурированный {ok, steps[]} в
    // любом исходе — сбой стрима не должен задевать остальной дашборд.
    if (pathname === "/api/stream/preflight") {
      if (request.method !== "GET") return methodNotAllowed(response, "GET");
      jsonResponse(response, 200, await preflightBroadcast({ fix: false }));
      return;
    }

    if (pathname === "/api/stream/start") {
      if (request.method !== "POST") return methodNotAllowed(response, "POST");
      jsonResponse(response, 200, await startBroadcast());
      return;
    }

    if (pathname === "/api/stream/stop") {
      if (request.method !== "POST") return methodNotAllowed(response, "POST");
      jsonResponse(response, 200, await stopBroadcast());
      return;
    }

    // -------------------- Reservation digests --------------------

    if (pathname === "/api/reservation-digests/preview") {
      if (request.method !== "GET") return methodNotAllowed(response, "GET");
      const date = urlObject.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        jsonResponse(response, 400, { error: "invalid_date" });
        return;
      }

      try {
        const digest = moysklad?.getReservationDigestForDate
          ? await moysklad.getReservationDigestForDate(date, { source: "http" })
          : { date, count: 0, clients: [] };
        const enriched = await enrichDigestWithSendState(digest, reservationDigestLog);
        jsonResponse(response, 200, enriched);
      } catch (error) {
        logger.error("http", "reservation_digest_preview_failed", { date, error: error?.message || String(error) });
        jsonResponse(response, 500, { error: "preview_failed", message: error?.message || String(error) });
      }
      return;
    }

    if (pathname === "/api/reservation-digests/send") {
      if (request.method !== "POST") return methodNotAllowed(response, "POST");
      let body;
      try { body = await readJsonBody(request, DIGEST_MAX_BODY); }
      catch (error) { return jsonResponse(response, 400, { error: error.message || "bad_request" }); }

      const date = String(body.date || new Date().toISOString().slice(0, 10));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        jsonResponse(response, 400, { error: "invalid_date" });
        return;
      }

      const selectedViewerIds = Array.isArray(body.viewerIds)
        ? new Set(body.viewerIds.map((id) => String(id)).filter(Boolean))
        : null;

      try {
        const digest = await moysklad.getReservationDigestForDate(date, { source: "http" });
        const enriched = await enrichDigestWithSendState(digest, reservationDigestLog);
        const results = [];

        for (const client of enriched.clients || []) {
          if (selectedViewerIds && !selectedViewerIds.has(String(client.viewerId || ""))) {
            continue;
          }

          if (!client.viewerId) {
            results.push({
              viewerId: null,
              viewerName: client.viewerName,
              status: "missing_vk_id",
              orderIds: client.orderIds || [],
            });
            continue;
          }

          if (client.alreadySent) {
            results.push({
              viewerId: client.viewerId,
              viewerName: client.viewerName,
              status: "already_sent",
              orderIds: client.orderIds || [],
              digestHash: client.digestHash,
            });
            continue;
          }

          if (!client.canSend) {
            results.push({
              viewerId: client.viewerId,
              viewerName: client.viewerName,
              status: client.cannotSendReason || "failed",
              orderIds: client.orderIds || [],
              digestHash: client.digestHash,
            });
            continue;
          }

          if (isSafeMode()) {
            results.push({
              viewerId: client.viewerId,
              viewerName: client.viewerName,
              status: "safe_mode_blocked",
              orderIds: client.orderIds || [],
              digestHash: client.digestHash,
            });
            continue;
          }

          let dmAllowed;
          try {
            dmAllowed = await vk.checkDmAllowed(client.viewerId);
          } catch (error) {
            logger.warn("http", "reservation_digest_dm_check_failed", {
              viewerId: client.viewerId,
              error: error?.message || String(error),
            });
            results.push({
              viewerId: client.viewerId,
              viewerName: client.viewerName,
              status: "failed",
              error: error?.message || String(error),
              orderIds: client.orderIds || [],
              digestHash: client.digestHash,
            });
            continue;
          }

          if (!dmAllowed?.allowed) {
            results.push({
              viewerId: client.viewerId,
              viewerName: client.viewerName,
              status: "dm_not_allowed",
              orderIds: client.orderIds || [],
              digestHash: client.digestHash,
            });
            continue;
          }

          try {
            const sent = await vk.sendDirectMessage({
              userId: client.viewerId,
              message: client.message,
              randomId: randomInt(2147483647),
            });

            if (sent?.safeMode) {
              results.push({
                viewerId: client.viewerId,
                viewerName: client.viewerName,
                status: "safe_mode_blocked",
                orderIds: client.orderIds || [],
                digestHash: client.digestHash,
              });
              continue;
            }
            if (sent?.skipped) {
              results.push({
                viewerId: client.viewerId,
                viewerName: client.viewerName,
                status: "failed",
                error: "vk_group_token_missing",
                orderIds: client.orderIds || [],
                digestHash: client.digestHash,
              });
              continue;
            }

            await reservationDigestLog.record({
              key: client.sendKey,
              date,
              viewerId: client.viewerId,
              viewerName: client.viewerName,
              digestHash: client.digestHash,
              orderIds: client.orderIds || [],
              orderNames: client.orderNames || [],
              total: client.total,
              messageId: sent ?? null,
            });

            results.push({
              viewerId: client.viewerId,
              viewerName: client.viewerName,
              status: "sent",
              orderIds: client.orderIds || [],
              digestHash: client.digestHash,
            });
          } catch (error) {
            logger.error("http", "reservation_digest_send_failed", {
              viewerId: client.viewerId,
              error: error?.message || String(error),
            });
            results.push({
              viewerId: client.viewerId,
              viewerName: client.viewerName,
              status: "failed",
              error: error?.message || String(error),
              orderIds: client.orderIds || [],
              digestHash: client.digestHash,
            });
          }
        }

        jsonResponse(response, 200, {
          ok: true,
          date,
          results,
          sentCount: results.filter((item) => item.status === "sent").length,
        });
      } catch (error) {
        logger.error("http", "reservation_digest_send_request_failed", { date, error: error?.message || String(error) });
        jsonResponse(response, 500, { error: "send_failed", message: error?.message || String(error) });
      }
      return;
    }

    // -------------------- Wish list --------------------

    if (pathname === "/api/wishlist/count") {
      if (request.method !== "GET") return methodNotAllowed(response, "GET");
      jsonResponse(response, 200, { count: wishlistStore?.getActiveCount?.() || 0 });
      return;
    }

    if (pathname === "/api/wishlist" && request.method === "GET") {
      const groups = buildGroupedWishlist();
      const count = wishlistStore.getActiveCount();
      jsonResponse(response, 200, { count, groups });
      return;
    }

    if (pathname === "/api/wishlist/archive" && request.method === "GET") {
      const archive = wishlistStore.listArchive().map(serializeWishlistEntry);
      jsonResponse(response, 200, { count: archive.length, entries: archive });
      return;
    }

    if (pathname === "/api/wishlist/draft" && request.method === "POST") {
      const draftId = randomUUID();
      const snapshot = {
        draftId,
        groups: buildGroupedWishlist(),
        suppliersCached: Boolean(suppliersCache),
      };
      await wishlistSubmissions.ensureDraft(draftId);
      jsonResponse(response, 200, snapshot);
      return;
    }

    if (pathname === "/api/wishlist/entries" && request.method === "POST") {
      let body;
      try { body = await readJsonBody(request, WISHLIST_MAX_BODY); }
      catch (error) { return jsonResponse(response, 400, { error: error.message || "bad_request" }); }

      const productCode = String(body.productCode || "").trim();
      if (!productCode) return jsonResponse(response, 400, { error: "productCode_required" });

      const cacheEntry = productCodeCache?.getProductByCode?.(productCode) || null;
      const entry = await wishlistStore.addManual({
        viewerName: body.viewerName,
        viewerId: body.viewerId,
        productCode,
        productId: body.productId || cacheEntry?.id || null,
        productName: body.productName || cacheEntry?.name || "",
        supplierId: body.supplierId || cacheEntry?.supplierId || null,
        supplierName: body.supplierName || cacheEntry?.supplierName || "",
        buyPrice: typeof body.buyPrice === "number" ? body.buyPrice : (cacheEntry?.buyPrice ?? null),
        quantity: body.quantity,
        lotCode: body.lotCode,
      });
      jsonResponse(response, 200, { ok: true, entry: serializeWishlistEntry(entry) });
      return;
    }

    // /api/wishlist/:entryId  (PATCH / DELETE)
    const entryMatch = /^\/api\/wishlist\/([0-9a-fA-F-]{8,})$/.exec(pathname);
    if (entryMatch) {
      const entryId = entryMatch[1];
      if (request.method === "PATCH") {
        let body;
        try { body = await readJsonBody(request, WISHLIST_MAX_BODY); }
        catch (error) { return jsonResponse(response, 400, { error: error.message || "bad_request" }); }
        const entry = await wishlistStore.edit(entryId, body, "operator");
        if (!entry) return jsonResponse(response, 404, { error: "entry_not_found" });
        return jsonResponse(response, 200, { ok: true, entry: serializeWishlistEntry(entry) });
      }
      if (request.method === "DELETE") {
        const removed = await wishlistStore.remove(entryId, "manual_delete");
        if (!removed) return jsonResponse(response, 404, { error: "entry_not_found_or_not_active" });
        return jsonResponse(response, 200, { ok: true });
      }
      return methodNotAllowed(response, "PATCH, DELETE");
    }

    if (pathname === "/api/wishlist/check-customerorders" && request.method === "POST") {
      let body;
      try { body = await readJsonBody(request, WISHLIST_MAX_BODY); }
      catch (error) { return jsonResponse(response, 400, { error: error.message || "bad_request" }); }
      const entryIds = Array.isArray(body.entryIds) ? body.entryIds : [];

      // Резолвим entries в (viewerId, productId), пропускаем без productId
      // (для них в МС всё равно нечего искать) и без viewerId (manual entries
      // с productId:null).
      const entriesWithKeys = [];
      for (const id of entryIds) {
        const entry = wishlistStore.getById(id);
        if (!entry || !entry.productId || entry.viewerId == null) continue;
        // Ручные entries имеют viewerId вида "manual-<uuid8>" — не настоящий VK ID,
        // ensureCounterparty создал бы под этот ID фейкового контрагента в МС. Скип.
        if (typeof entry.viewerId === "string" && entry.viewerId.startsWith("manual-")) continue;
        entriesWithKeys.push({ id, viewerId: entry.viewerId, viewerName: entry.viewerName, productId: entry.productId });
      }

      const result = {};
      for (const id of entryIds) result[id] = { inOpenOrder: false };
      try {
        const probes = await moysklad.checkOpenOrderPositionsForEntries(
          entriesWithKeys.map((entry) => ({
            entryId: entry.id,
            viewerId: entry.viewerId,
            viewerName: entry.viewerName,
            productId: entry.productId,
          })),
          { source: "http" },
        );
        Object.assign(result, probes);
      } catch (error) {
        logger.warn("wishlist", "bulk_check_positions_failed", {
          error: error?.message || String(error),
        });
        for (const entry of entriesWithKeys) {
          result[entry.id] = { inOpenOrder: false, error: "lookup_failed" };
        }
      }

      jsonResponse(response, 200, result);
      return;
    }

    if (pathname === "/api/wishlist/purchase-order" && request.method === "POST") {
      let body;
      try { body = await readJsonBody(request, WISHLIST_MAX_BODY); }
      catch (error) { return jsonResponse(response, 400, { error: error.message || "bad_request" }); }

      const draftId = String(body.draftId || "").trim();
      const groups = Array.isArray(body.groups) ? body.groups : [];
      if (!draftId) return jsonResponse(response, 400, { error: "draftId_required" });
      if (groups.length === 0) return jsonResponse(response, 400, { error: "groups_empty" });

      // Валидация: каждая группа должна иметь supplierId и storeId.
      const missingIndices = [];
      groups.forEach((g, idx) => {
        if (!g.supplierId || !g.storeId) missingIndices.push(idx);
      });
      if (missingIndices.length > 0) {
        return jsonResponse(response, 400, {
          error: "missing_supplier_or_store",
          groupIndices: missingIndices,
        });
      }

      const wishlistSettings = settingsStore.getWishlist();
      const today = new Date().toISOString().slice(0, 10);

      // Существующая submission для идемпотентности.
      await wishlistSubmissions.ensureDraft(draftId);
      const existing = wishlistSubmissions.getSubmission(draftId);
      if (existing?.status === "complete") {
        // Полный закэшированный ответ.
        const purchaseOrders = Object.values(existing.groups || {})
          .filter((g) => g.status === "ok")
          .map((g) => ({
            id: g.purchaseOrderId, name: g.purchaseOrderName, supplierId: g.supplierId,
          }));
        return jsonResponse(response, 200, {
          ok: true, status: "complete", purchaseOrders, failedGroups: [], blockedGroupHashes: [], replayed: true,
        });
      }

      // Резолвим organizationId один раз для всех групп. config может быть
      // не заполнен — тогда тянем через moysklad.getDefaults() (он подберёт
      // preferredOrganizationName или первую организацию).
      let organizationId = config.moysklad?.organizationId || null;
      if (!organizationId && typeof moysklad.getDefaults === "function") {
        try {
          const defaults = await moysklad.getDefaults();
          organizationId = defaults?.organizationId || null;
        } catch (error) {
          logger.error("http", "wishlist_org_resolve_failed", { error: error?.message || String(error) });
        }
      }
      if (!organizationId) {
        return jsonResponse(response, 500, { error: "organization_unresolved" });
      }

      const purchaseOrders = [];
      const failedGroups = [];
      const blockedGroupHashes = [];

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const groupHash = computeGroupHash(group);
        const existingResult = wishlistSubmissions.getGroupResult(draftId, groupHash);
        if (existingResult?.status === "ok") {
          // Уже создан — добавляем в ответ как успешный, не дублируем.
          purchaseOrders.push({
            id: existingResult.purchaseOrderId,
            name: existingResult.purchaseOrderName,
            supplierId: existingResult.supplierId,
          });
          continue;
        }

        const description = (group.description || wishlistSettings.descriptionTemplate || "")
          .replaceAll("{date}", today)
          .replaceAll("{codes}", group.positions.map((p) => p.productCode).filter(Boolean).join(", "));

        const positionsPayload = (group.positions || []).map((p) => ({
          productId: p.productId,
          quantity: Number(p.quantity) || 1,
          price: Number.isFinite(Number(p.price)) ? Number(p.price) : 0,
        }));
        const allEntryIds = (group.positions || []).flatMap((p) => Array.isArray(p.entryIds) ? p.entryIds : []);

        // Sanitized — без полного description (только preview) и без auth/refs.
        // requestHash идентифицирует уникальный submit-attempt; groupHash —
        // детерминированный отпечаток группы (для retry-логики). Имя поставщика
        // и productCode/Name берём из draft-snapshot wishlistStore для удобства
        // чтения INDEX.md без перекрёстных lookup'ов.
        const supplierName = suppliersCache?.rows?.find((s) => s.id === group.supplierId)?.name || null;
        const sanitizedPositions = (group.positions || []).map((p) => {
          const sample = wishlistStore.getById?.((p.entryIds || [])[0]);
          return {
            productId: p.productId,
            productCode: p.productCode || sample?.productCode || null,
            productName: sample?.productName || null,
            quantity: p.quantity,
            price: p.price,
          };
        });
        const requestHash = "sha256:" + createHash("sha256")
          .update(JSON.stringify({ draftId, groupHash, attemptedAt: new Date().toISOString() }))
          .digest("hex");
        const sanitizedSubmit = {
          draftId,
          groupHash,
          requestHash,
          supplierId: group.supplierId,
          supplierName,
          storeId: group.storeId,
          positions: sanitizedPositions,
          descriptionPreview: description ? String(description).slice(0, 80) : "",
        };
        diag("purchase_order_submitted", sanitizedSubmit);

        try {
          const result = await moysklad.createPurchaseOrder({
            organizationId,
            storeId: group.storeId,
            agentId: group.supplierId,
            positions: positionsPayload,
            description,
          });

          if (result && result.skipped === true && result.safeMode === true) {
            // Safe mode wrapper заблокировал. НЕ consume, отмечаем как блокированную.
            await wishlistSubmissions.recordGroupResult(draftId, groupHash, {
              status: "safe_mode_blocked",
              supplierId: group.supplierId,
            });
            blockedGroupHashes.push(groupHash);
            diag("safemode_blocked_purchase_order", { draftId, groupHash, supplierId: group.supplierId });
            continue;
          }

          if (!result?.id) {
            // Контракт: при любом другом skipped/disabled createPurchaseOrder
            // должен бросать. Защита на случай нового непредвиденного skipped:
            // отмечаем failed, не consume, не дублируем PO в МС позже.
            throw new Error("createPurchaseOrder returned no id (unexpected skip)");
          }
          diag("purchase_order_response", {
            draftId, groupHash, ok: true,
            httpStatus: 200,
            purchaseOrderId: result.id, purchaseOrderName: result.name,
          });

          // Успех — СНАЧАЛА recordGroupResult, ПОТОМ consume.
          // При падении между ними reconcile на старте подберёт missing consume.
          await wishlistSubmissions.recordGroupResult(draftId, groupHash, {
            status: "ok",
            purchaseOrderId: result.id,
            purchaseOrderName: result.name,
            supplierId: group.supplierId,
            consumedEntryIds: allEntryIds,
            createdAt: new Date().toISOString(),
          });
          await wishlistStore.consume({
            entryIds: allEntryIds,
            purchaseOrderId: result.id,
            purchaseOrderName: result.name,
            draftId,
            groupHash,
          });
          purchaseOrders.push({ id: result.id, name: result.name, supplierId: group.supplierId });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("wishlist", "purchase_order_failed", { draftId, groupHash, error: message });
          await wishlistSubmissions.recordGroupResult(draftId, groupHash, {
            status: "failed",
            supplierId: group.supplierId,
            error: message,
            attemptCount: (existingResult?.attemptCount || 0) + 1,
            lastAttemptAt: new Date().toISOString(),
          });
          failedGroups.push({ groupHash, supplierId: group.supplierId, error: message });
          // Парсим HTTP-статус из текста ошибки если МС вернул "MoySklad HTTP NNN".
          const httpMatch = /MoySklad HTTP (\d+)/.exec(message);
          diag("purchase_order_response", {
            draftId, groupHash, ok: false,
            httpStatus: httpMatch ? Number(httpMatch[1]) : null,
            errorMessage: message,
          });
        }
      }

      if (failedGroups.length > 0 || blockedGroupHashes.length > 0) {
        diag("purchase_order_partial", {
          draftId,
          successCount: purchaseOrders.length,
          failedCount: failedGroups.length,
          blockedCount: blockedGroupHashes.length,
          failedGroupHashes: failedGroups.map((g) => g.groupHash),
          blockedGroupHashes,
        });
      }

      // Корпус ответа.
      const allBlocked = groups.length > 0 && blockedGroupHashes.length === groups.length;
      if (allBlocked) {
        return jsonResponse(response, 409, {
          error: "safe_mode_enabled",
          blockedGroupHashes,
        });
      }

      const status = failedGroups.length === 0 && blockedGroupHashes.length === 0
        ? "complete"
        : (purchaseOrders.length === 0 ? "failed" : "partial");

      jsonResponse(response, 200, {
        ok: true,
        status,
        purchaseOrders,
        failedGroups,
        blockedGroupHashes,
      });
      return;
    }

    // -------------------- MoySklad lookups --------------------

    if (pathname === "/api/moysklad/suppliers" && request.method === "GET") {
      try {
        const rows = await loadSuppliersCached();
        jsonResponse(response, 200, { rows });
      } catch (error) {
        jsonResponse(response, 500, { error: error?.message || String(error) });
      }
      return;
    }

    if (pathname === "/api/moysklad/stores" && request.method === "GET") {
      try {
        const rows = await loadStoresCached();
        jsonResponse(response, 200, { rows });
      } catch (error) {
        jsonResponse(response, 500, { error: error?.message || String(error) });
      }
      return;
    }

    // -------------------- Settings --------------------

    if (pathname === "/api/settings") {
      if (request.method === "GET") {
        jsonResponse(response, 200, settingsStore.get());
        return;
      }
      if (request.method === "PATCH") {
        let body;
        try { body = await readJsonBody(request, WISHLIST_MAX_BODY); }
        catch (error) { return jsonResponse(response, 400, { error: error.message || "bad_request" }); }
        const updated = await settingsStore.patch(body);
        return jsonResponse(response, 200, updated);
      }
      return methodNotAllowed(response, "GET, PATCH");
    }

    // -------------------- Existing endpoints --------------------

    if (pathname === "/api/send-logs/preview") {
      if (request.method !== "GET") return methodNotAllowed(response, "GET");
      try {
        const files = await listBundleFiles();
        const totalBytes = files.reduce((acc, f) => acc + f.bytes, 0);
        jsonResponse(response, 200, { files, totalBytes, cooldownMs: 0 });
      } catch (error) {
        logger.error("http", "logs_preview_failed", { error: error?.message || String(error) });
        jsonResponse(response, 500, { error: "preview_failed" });
      }
      return;
    }

    if (pathname === "/api/send-logs") {
      if (request.method !== "POST") return methodNotAllowed(response, "POST");

      let body;
      try {
        body = await readJsonBody(request, SEND_LOGS_MAX_BODY);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message || "bad_request" });
        return;
      }

      const downloadOnly = Boolean(body?.download);
      const userNote = typeof body?.userNote === "string" ? body.userNote : "";

      if (logsInFlight) {
        jsonResponse(response, 429, { error: "already_in_progress" });
        return;
      }

      if (!downloadOnly) {
        jsonResponse(response, 410, { error: "remote_delivery_disabled", message: "Remote delivery is disabled. Use download mode." });
        return;
      }

      logsInFlight = true;
      try {
        const bundle = await Promise.race([
          buildLogBundle({
            userNote, config,
            wishlistStore, wishlistSubmissions, settingsStore,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("log_bundle_timeout")), SEND_LOGS_TIMEOUT_MS).unref(),
          ),
        ]);

        const buffer = bundle.parts.length === 1
          ? bundle.parts[0].buffer
          : Buffer.concat(bundle.parts.map((p) => p.buffer));
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${bundle.singleFilename}"`,
          "content-length": buffer.length,
        });
        response.end(buffer);
        logger.info("http", "logs_downloaded", { filename: bundle.singleFilename, size: buffer.length });
      } catch (error) {
        logger.error("http", "logs_send_failed", { error: error?.message || String(error) });
        jsonResponse(response, 500, { error: "send_failed", message: error?.message || String(error) });
      } finally {
        logsInFlight = false;
      }
      return;
    }

    if (pathname === "/api/safe-mode") {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ safeMode: isSafeMode() }));
        return;
      }

      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1024) {
            request.destroy();
          }
        });
        request.on("end", () => {
          let enabled;
          try {
            ({ enabled } = JSON.parse(body || "{}"));
          } catch {
            response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ error: "invalid_json" }));
            return;
          }

          const changed = setSafeMode(enabled, { source: "http" });
          logger.info("http", "safe_mode_request", { enabled: Boolean(enabled), changed });
          response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ safeMode: isSafeMode(), changed }));
        });
        return;
      }

      return methodNotAllowed(response, "GET, POST");
    }

    const assetPath = resolveAssetPath(pathname);

    if (!assetPath) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    try {
      const assetStats = await stat(assetPath);

      if (!assetStats.isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }

      response.writeHead(200, {
        "content-type": MIME_TYPES[extname(assetPath)] || "application/octet-stream",
        "cache-control": "no-store",
      });

      const stream = createReadStream(assetPath);
      stream.on("error", (error) => {
        logger.error("http", "asset_stream_failed", { assetPath, error });
        if (!response.headersSent) {
          response.writeHead(500).end("Read error");
          return;
        }

        response.destroy();
      });
      stream.pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
}
