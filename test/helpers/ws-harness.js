import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { attachWsServer, __resetIdCountersForTests } from "../../server/ws-server.js";

// Интеграционная обвязка для ws-server: поднимает реальный http.Server,
// цепляет attachWsServer с мок-сервисами и подключается реальным ws-клиентом.
// Реальная SpeechKit-сессия подменяется фейком (createSpeechKitSession),
// поэтому транскрипты подаются скриптом через session.handlers.onFinal —
// без сети к Yandex. См. knowledge/wiki/deferred-operator-features.md
// (раздел «Prerequisite — WebSocket integration tests»).

function recorder() {
  const calls = [];
  const fn = (impl) => (...args) => {
    calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  return { calls, fn };
}

// Мок VK-издателя: записывает каждый вызов и его аргументы. publishLotCard
// по умолчанию выдаёт инкрементный commentId, чтобы лот считался
// опубликованным (иначе ws-server не запустит поллер и не сохранит лот).
// getComments отдаёт накопленную очередь комментариев (vk.pushComment) —
// так тест драйвит путь броней без реального VK API.
export function createVkMock(overrides = {}) {
  let nextCommentId = 100;
  const calls = [];
  const commentItems = [];
  const profiles = [];
  const wrap = (name, impl) => (...args) => {
    calls.push({ name, args });
    return impl ? impl(...args) : undefined;
  };
  const vk = {
    isEnabled: true,
    selfUserId: overrides.selfUserId ?? 0,
    getSelfUserId: wrap("getSelfUserId", overrides.getSelfUserId
      || (async () => vk.selfUserId)),
    publishLotCard: wrap("publishLotCard", overrides.publishLotCard
      || (async () => ({ comment_id: nextCommentId++ }))),
    publishLotClosed: wrap("publishLotClosed", overrides.publishLotClosed || (async () => {})),
    publishPriceUpdate: wrap("publishPriceUpdate", overrides.publishPriceUpdate || (async () => {})),
    publishDiscountUpdate: wrap("publishDiscountUpdate", overrides.publishDiscountUpdate || (async () => {})),
    publishReservationReply: wrap("publishReservationReply", overrides.publishReservationReply || (async () => {})),
    getComments: wrap("getComments", overrides.getComments
      || (async () => ({ items: [...commentItems], profiles: [...profiles] }))),
    setLiveVideoUrl: wrap("setLiveVideoUrl", overrides.setLiveVideoUrl || (() => {})),
  };
  // Кладёт комментарий в очередь, которую возвращает getComments. Поллер
  // дедупит по id/lastCommentId, поэтому повторные опросы безопасны.
  vk.pushComment = ({ id, fromId, text, firstName = "Покупатель", lastName = "" }) => {
    commentItems.push({ id, from_id: fromId, text, date: Math.floor(Date.now() / 1000) });
    if (!profiles.some((p) => p.id === fromId)) {
      profiles.push({ id: fromId, first_name: firstName, last_name: lastName });
    }
  };
  vk.calls = calls;
  vk.callsTo = (name) => calls.filter((c) => c.name === name);
  return vk;
}

// Мок MoySklad: фикстурные карточки по коду через cardsByCode.
export function createMoyskladMock({ cardsByCode = {}, overrides = {} } = {}) {
  const calls = [];
  const wrap = (name, impl) => (...args) => {
    calls.push({ name, args });
    return impl(...args);
  };
  const moysklad = {
    isEnabled: true,
    getProductCardByCode: wrap("getProductCardByCode", overrides.getProductCardByCode
      || (async (code) => cardsByCode[code] || null)),
    ensureCounterparty: wrap("ensureCounterparty", overrides.ensureCounterparty || (async () => null)),
    findOpenCustomerOrderForCounterparty: wrap("findOpenCustomerOrderForCounterparty",
      overrides.findOpenCustomerOrderForCounterparty || (async () => null)),
    isCustomerOrderAppendable: wrap("isCustomerOrderAppendable",
      overrides.isCustomerOrderAppendable || (async () => true)),
    findBroadcastCustomerOrderForCounterparty: wrap("findBroadcastCustomerOrderForCounterparty",
      overrides.findBroadcastCustomerOrderForCounterparty || (async () => null)),
    appendPositionToCustomerOrder: wrap("appendPositionToCustomerOrder",
      overrides.appendPositionToCustomerOrder
      || (async () => ({ orderId: "co-test-1", positionId: "pos-appended-1" }))),
    createCustomerOrderReservation: wrap("createCustomerOrderReservation",
      overrides.createCustomerOrderReservation
      || (async () => ({ id: "co-test-1", positionId: "pos-created-1" }))),
    removePositionFromOrder: wrap("removePositionFromOrder",
      overrides.removePositionFromOrder || (async () => ({ ok: true }))),
  };
  moysklad.calls = calls;
  moysklad.callsTo = (name) => calls.filter((c) => c.name === name);
  return moysklad;
}

// Мок кэша кодов каталога. codes — массив известных артикулов.
export function createProductCodeCacheMock(codes = []) {
  const set = new Set(codes.map(String));
  return {
    getCodes: () => new Set(set),
    getProductByCode: (code) => (set.has(String(code))
      ? { id: `prod-${code}`, name: `Товар ${code}` }
      : null),
    getSnapshot: () => ({ count: set.size, loadedAt: new Date().toISOString(), refreshing: false, lastError: null }),
  };
}

// Мок чат-клиента /efir/ (server/chat-client.js). pushMessage кладёт
// сообщение зрителя в фид; сервисные ответы бота копятся в serviceMessages.
// Семантика курсора как у реального сервиса: fetchFeed(null) отдаёт только
// latestSeq (инициализация, историю не переигрываем), fetchFeed(n) — всё
// новее n.
export function createChatClientMock() {
  const ID_BASE = 9_000_000_000;
  const queue = [];
  const serviceMessages = [];
  const feedCalls = [];
  let latestSeq = 0;
  return {
    enabled: true,
    async fetchFeed(afterSeq) {
      feedCalls.push(afterSeq);
      if (afterSeq === null || afterSeq === undefined) {
        return { latestSeq, messages: [] };
      }
      return { latestSeq, messages: queue.filter((m) => m.seq > afterSeq) };
    },
    async postServiceMessage(text) {
      serviceMessages.push(text);
      return { ok: true };
    },
    pushMessage({ viewerId, name, phone = "", text }) {
      latestSeq += 1;
      queue.push({
        seq: latestSeq,
        commentId: ID_BASE + latestSeq,
        viewerId,
        name,
        phone,
        text,
        ts: Date.now(),
      });
    },
    // Ждём инициализацию курсора поллера (первый fetchFeed) — сообщения,
    // запушенные до неё, по контракту не переигрываются.
    async waitForFeedInit({ timeoutMs = 2000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (feedCalls.length === 0) {
        if (Date.now() > deadline) throw new Error("waitForFeedInit timed out");
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    serviceMessages,
    feedCalls,
  };
}

export function createWishlistStoreMock() {
  const calls = [];
  return {
    addFromOutOfStock: async (entry) => {
      calls.push(entry);
      return { id: `wishlist-${calls.length}` };
    },
    flush: async () => {},
    getActiveCount: () => calls.length,
    subscribe: () => {},
    calls,
  };
}

function buildConfig(overrides = {}) {
  return {
    // Скалярные ключи верхнего уровня (wsHeartbeatIntervalMs и т.п.)
    // проходят как есть; структурные группы ниже мержатся поверх.
    ...overrides,
    articleExtraction: {
      triggers: ["код товара", "артикул", "код"],
      minLength: 1,
      maxLength: 10,
      finalBufferSize: 3,
      triggerWindowMs: 8000,
      yandexgpt: { apiKey: "", folderId: "" },
      ...(overrides.articleExtraction || {}),
    },
    discount: { triggers: ["скидка", "скидку", "скидки"], ...(overrides.discount || {}) },
    speechkit: { ...(overrides.speechkit || {}) },
    moysklad: {},
    vk: {},
  };
}

function createSessionLogMock() {
  const noop = () => {};
  return {
    getFilePath: () => null,
    getJsonl: () => null,
    logSafemodeToggled: noop,
    logStateSnapshot: noop,
    logReservationWaitlist: noop,
    logReservationOutOfStock: noop,
    logOrderCreated: noop,
    logOrderCancelled: noop,
    logWaitlistPromoted: noop,
    logVkComment: noop,
    logReservation: noop,
    logReservationDetected: noop,
    logReservationFinalized: noop,
    logOrphanWaitlist: noop,
    logWaitlistMigratedToWishlist: noop,
    logDiscount: noop,
    logLotOpened: noop,
    logSessionStart: noop,
    logTranscriptFinal: noop,
    logDiscountSkipped: noop,
    logPriceChanged: noop,
    logManualCodeSubmitted: noop,
    logLotClosed: noop,
    logReservationQuantityAppended: noop,
    logSessionEnd: noop,
    flush: async () => {},
  };
}

// Поднимает сервер. Возвращает { url, vk, moysklad, productCodeCache,
// getLastSpeechKitSession, connect, close }.
export async function startHarness({
  cardsByCode = {},
  knownCodes = [],
  moysklad: moyskladOverride,
  vk: vkOverride,
  chatClient,
  wishlistStore: wishlistStoreOverride,
  blockedViewersStore,
  config: configOverride = {},
  createSessionLog: createSessionLogOverride,
} = {}) {
  __resetIdCountersForTests();

  const vk = vkOverride || createVkMock();
  const moysklad = moyskladOverride || createMoyskladMock({ cardsByCode });
  const productCodeCache = createProductCodeCacheMock(knownCodes);
  const wishlistStore = wishlistStoreOverride || createWishlistStoreMock();

  // Фейковая SpeechKit-сессия: захватывает handlers, отдаёт их тесту.
  const sessions = [];
  const createSpeechKitSession = (_cfg, handlers) => {
    const session = {
      handlers,
      pushedAudio: [],
      closed: false,
      pushAudio(buf) { this.pushedAudio.push(buf); },
      close() { this.closed = true; },
    };
    sessions.push(session);
    return session;
  };

  const httpServer = createServer();
  attachWsServer(httpServer, buildConfig(configOverride), {
    vk,
    moysklad,
    ...(chatClient ? { chatClient } : {}),
    productCodeCache,
    wishlistStore,
    ...(blockedViewersStore ? { blockedViewersStore } : {}),
    createSpeechKitSession,
    createSessionLog: createSessionLogOverride || createSessionLogMock,
    saveActiveState: () => {},
    clearActiveState: async () => {},
    packageVersion: "test",
  });

  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const { port } = httpServer.address();
  const url = `ws://127.0.0.1:${port}/ws/stt`;

  return {
    url,
    vk,
    moysklad,
    productCodeCache,
    wishlistStore,
    getLastSpeechKitSession: () => sessions[sessions.length - 1] || null,
    // start обрабатывается асинхронно — ждём, пока фейковая сессия появится.
    async waitForSession({ timeoutMs = 2000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (sessions.length === 0) {
        if (Date.now() > deadline) throw new Error("waitForSession timed out");
        await new Promise((r) => setTimeout(r, 5));
      }
      return sessions[sessions.length - 1];
    },
    async close() {
      await new Promise((resolve) => httpServer.close(resolve));
    },
    async connect() {
      return connectClient(url);
    },
  };
}

// Клиент: собирает входящие JSON-сообщения, умеет ждать сообщение по типу.
async function connectClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  // Курсор последовательного чтения: waitFor сканирует только сообщения,
  // ещё не «потреблённые» предыдущим waitFor. Иначе старый state из буфера
  // (например, activeLot=null от start) ошибочно матчится до того, как
  // сервер обработал следующую команду.
  let cursor = 0;
  let pending = null;

  function tryResolvePending() {
    if (!pending) return;
    while (cursor < messages.length) {
      const msg = messages[cursor];
      cursor += 1;
      if (pending.predicate(msg)) {
        const { resolve } = pending;
        pending = null;
        resolve(msg);
        return;
      }
    }
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    messages.push(msg);
    tryResolvePending();
  });

  await once(ws, "open");

  return {
    ws,
    messages,
    send(obj) { ws.send(JSON.stringify(obj)); },
    // Ждёт следующее (с позиции курсора) сообщение по предикату и сдвигает
    // курсор за него — последовательное чтение потока.
    waitFor(predicate, { timeoutMs = 2000 } = {}) {
      if (pending) return Promise.reject(new Error("waitFor already pending"));
      const test = typeof predicate === "string"
        ? (m) => m.type === predicate
        : predicate;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = null;
          reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending = {
          predicate: test,
          resolve: (m) => { clearTimeout(timer); resolve(m); },
        };
        tryResolvePending();
      });
    },
    lastState() {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].type === "state") return messages[i];
      }
      return null;
    },
    async close() {
      ws.close();
      await once(ws, "close").catch(() => {});
    },
  };
}
