// Клиент чата зрителей на странице /efir/ (deploy/chat-service на cloud).
// Два вызова: операторский фид новых сообщений (с телефонами — только под
// X-Chat-Token) и публикация сервисных ответов бота («бронь подтверждена»).
// Ошибки сети никогда не роняют эфир: fetchFeed бросает (поллер в ws-server
// сам считает consecutiveFailures и делает backoff), postServiceMessage
// возвращает { ok:false } — ответ зрителю best-effort.

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
        return { ok: true };
      } catch (error) {
        const message = error?.name === "AbortError"
          ? `chat service timed out after ${timeoutMs}ms`
          : error?.message || String(error);
        return { ok: false, error: message };
      }
    },
  };
}
