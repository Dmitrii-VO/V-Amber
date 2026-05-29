import { timingSafeEqual } from "node:crypto";

// Constant-time string compare. Returns false on length mismatch without
// branching on contents.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookie values instead of failing the whole request.
    }
  }
  return out;
}

function parseOriginList(value) {
  if (!value?.trim()) return null;
  return new Set(
    value.split(",").map((s) => s.trim()).filter(Boolean),
  );
}

// Дефолтный allowlist для Origin (loopback на любом порту). Если задан
// ALLOWED_ORIGINS — он целиком заменяет дефолт.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function createAuth(env = process.env) {
  const token = env.API_TOKEN?.trim() || "";
  const allowedOrigins = parseOriginList(env.ALLOWED_ORIGINS || "");

  function isOriginAllowed(origin) {
    if (!origin) return true; // не-браузерные клиенты (Node ws, curl) — Origin нет
    if (allowedOrigins) return allowedOrigins.has(origin);
    return isLoopbackOrigin(origin);
  }

  // Возвращает true, если токен корректен или auth отключён (API_TOKEN не задан).
  function isRequestAuthenticated(request, url) {
    if (!token) return true;
    const headerToken = request.headers["x-api-token"];
    if (headerToken && safeEqual(headerToken, token)) return true;

    const auth = request.headers["authorization"];
    if (auth && auth.startsWith("Bearer ")) {
      if (safeEqual(auth.slice(7), token)) return true;
    }

    const cookies = parseCookies(request.headers["cookie"]);
    if (cookies.api_token && safeEqual(cookies.api_token, token)) return true;

    const queryToken = url?.searchParams?.get("token");
    if (queryToken && safeEqual(queryToken, token)) return true;

    return false;
  }

  function setTokenCookie(response) {
    if (!token) return;
    // HttpOnly: фронту не нужен read-access (cookie уйдёт сам с fetch
    // same-origin). SameSite=Lax: защита от cross-site POST.
    response.setHeader(
      "set-cookie",
      `api_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
    );
  }

  return {
    enabled: Boolean(token),
    isRequestAuthenticated,
    isOriginAllowed,
    setTokenCookie,
  };
}
