// Клиент чата зрителей на странице /efir/ (deploy/chat-service на cloud).
// Три вызова: операторский фид новых сообщений для сопоставления броней
// (с телефонами — только под X-Chat-Token, использует ws-server.js),
// публичная лента для дашборд-панели «Чат зрителей» (viewer+service вперемешку,
// как видят сами зрители — использует http-server.js) и публикация сервисных
// ответов бота. Ошибки сети никогда не роняют эфир: fetchFeed/fetchMessages
// бросают (вызывающий сам считает попытки и делает backoff),
// postServiceMessage возвращает { ok:false } — ответ зрителю best-effort.

async function fetchWithTimeout(url, { method = "GET", token, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    ...(token ? { "X-Chat-Token": token } : {}),
    ...(body ? { "Content-Type": "application/json" } : {}),
  };
  try {
    return await fetch(url, {
      method,
      signal: controller.signal,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

export function createChatClient(chatConfig = {}) {
  const apiUrl = String(chatConfig.apiUrl || "").replace(/\/+$/, "");
  const token = chatConfig.apiToken || "";
  const timeoutMs = Number(chatConfig.timeoutMs) > 0 ? Number(chatConfig.timeoutMs) : 3000;

  if (!apiUrl) {
    return { enabled: false };
  }

  return {
    enabled: true,

    // afterSeq === null → инициализация курсора: сервис возвращает только
    // latestSeq без сообщений (историю до старта эфира не переигрываем —
    // зеркалит инициализацию VK-поллера по последнему comment id).
    async fetchFeed(afterSeq) {
      const query = afterSeq === null || afterSeq === undefined ? "" : `?after=${afterSeq}`;
      const response = await fetchWithTimeout(`${apiUrl}/feed${query}`, { token, timeoutMs });
      if (!response.ok) {
        throw new Error(`chat feed status ${response.status}`);
      }
      const data = await response.json();
      return {
        latestSeq: Number.isFinite(Number(data.latestSeq)) ? Number(data.latestSeq) : 0,
        messages: Array.isArray(data.messages) ? data.messages : [],
      };
    },

    // Публичная лента (то же, что /efir/ показывает зрителям): viewer- и
    // service-сообщения вперемешку, без телефона/viewerId — этого достаточно
    // для операторской панели «читать и отвечать», в отличие от fetchFeed,
    // который отдаёт только viewer-сообщения (нужные для парсинга броней) и
    // требует токен.
    async fetchMessages(afterSeq) {
      const query = afterSeq === null || afterSeq === undefined ? "" : `?after=${afterSeq}`;
      const response = await fetchWithTimeout(`${apiUrl}/messages${query}`, { token, timeoutMs });
      if (!response.ok) {
        throw new Error(`chat messages status ${response.status}`);
      }
      const data = await response.json();
      return {
        latestSeq: Number.isFinite(Number(data.latestSeq)) ? Number(data.latestSeq) : 0,
        messages: Array.isArray(data.messages) ? data.messages : [],
      };
    },

    async postServiceMessage(text) {
      try {
        const response = await fetchWithTimeout(`${apiUrl}/service`, {
          method: "POST",
          token,
          body: { text },
          timeoutMs,
        });
        if (!response.ok) {
          return { ok: false, error: `chat service status ${response.status}` };
        }
        const data = await response.json().catch(() => ({}));
        return { ok: true, seq: Number.isFinite(Number(data.seq)) ? Number(data.seq) : null };
      } catch (error) {
        const message = error?.name === "AbortError"
          ? `chat service timed out after ${timeoutMs}ms`
          : error?.message || String(error);
        return { ok: false, error: message };
      }
    },

    // Оператор выбрал «Новая сессия» при старте своего эфира — помечает
    // границу в chat-service; /chat/messages перестаёт отдавать что-либо
    // раньше неё (см. knowledge/wiki/stream-integration.md).
    async postNewSession() {
      try {
        const response = await fetchWithTimeout(`${apiUrl}/session/new`, { method: "POST", token, timeoutMs });
        if (!response.ok) {
          return { ok: false, error: `chat session status ${response.status}` };
        }
        const data = await response.json().catch(() => ({}));
        return { ok: true, seq: Number.isFinite(Number(data.seq)) ? Number(data.seq) : null };
      } catch (error) {
        const message = error?.name === "AbortError"
          ? `chat session timed out after ${timeoutMs}ms`
          : error?.message || String(error);
        return { ok: false, error: message };
      }
    },
  };
}
