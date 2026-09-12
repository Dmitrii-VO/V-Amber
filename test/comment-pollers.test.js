import test from "node:test";
import assert from "node:assert/strict";

import { createCommentPollers } from "../server/domain/comment-pollers.js";

// Транспорт комментариев, вынесенный из ws-server.js. До выноса эта логика
// проверялась только сквозь весь ws-server, а адаптивный интервал и backoff —
// вообще никак: чтобы их увидеть, нужно было ждать реальные секунды.

// Драйвер цикла: sleep не спит, а записывает запрошенную паузу и отдаёт
// управление. Так один тест проходит десяток итераций мгновенно.
function createDriver({ stopAfter = 50 } = {}) {
  const delays = [];
  let stop = null;
  const sleep = async (ms) => {
    delays.push(ms);
    if (delays.length >= stopAfter && stop) stop();
    // Уступаем макрозадаче: без этого цикл спинит микрозадачи и не даёт
    // процессу завершиться.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { delays, sleep, onStop: (fn) => { stop = fn; } };
}

// Даём циклу прокрутиться: он асинхронный, но без реальных пауз.
async function settle(ticks = 60) {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Темп опроса задаёт ожидание БРОНЕЙ, а не объём ленты. Розыгрыш «угадай
// число» даёт сотни комментариев в минуту при нуле броней — раньше опрос
// залипал на 1.5 с и выбирал квоту VK ровно тогда, когда уходили подтверждения
// броней (эфиры 24–25.07.2026: 14 из 22 минут с лимитами — минуты потока).
test("stopVk гасит VK-цикл, но не трогает курсор чата", async () => {
  const driver = createDriver({ stopAfter: 2 });
  const pollers = createCommentPollers({
    vk: createLongPollVkFake([[]]),
    chatClient: { enabled: true, async fetchFeed() { return { latestSeq: 5, messages: [] }; } },
    config: { chat: { pollMs: 10 } },
    connectionId: "ws-test",
    onComment: () => {},
    getOpenLotCount: () => 1,
    notify: () => {},
    sleep: driver.sleep,
  });
  // Пауза глушит ТОЛЬКО VK: чат обязан пережить это и доехать до курсора.
  driver.onStop(() => pollers.stopVk());

  pollers.startVk();
  pollers.startChat();
  await settle();

  assert.equal(pollers.getState().vkActive, false);
  assert.equal(pollers.getState().chatCursor, 5, "VK-poison не должен глушить чат /efir/");

  // Чат останавливается только сбросом эфира — гасим, чтобы тест завершился.
  pollers.reset();
  await settle(5);
});

test("reset обнуляет курсоры обоих источников", async () => {
  const { pollers } = setupLongPoll({ batches: [[lpComment(42, 5001, "бронь")], []], stopAfter: 1 });

  pollers.startVk();
  await settle();
  assert.equal(pollers.getState().vkLastCommentId, 42);

  pollers.reset();

  const state = pollers.getState();
  assert.equal(state.vkLastCommentId, 0, "новый эфир не должен наследовать позицию в ленте");
  assert.equal(state.chatCursor, null);
  assert.equal(state.vkActive, false);
});

test("без открытых лотов цикл продолжает крутиться в пределах grace-окна", async () => {
  const driver = createDriver({ stopAfter: 3 });
  const vk = createLongPollVkFake([[]]);
  const pollers = createCommentPollers({
    vk,
    chatClient: { enabled: false },
    config: {},
    connectionId: "ws-test",
    onComment: () => {},
    getOpenLotCount: () => 0,
    notify: () => {},
    sleep: driver.sleep,
  });
  driver.onStop(() => pollers.stopVk());

  pollers.startVk();
  await settle();

  // Grace-окно 30 с отсчитывается от первой итерации без лотов: покупатель
  // дописывает бронь ещё несколько секунд после закрытия последнего лота,
  // поэтому слушать зал надо и после закрытия.
  assert.ok(vk.tsSeen.length > 1, `цикл должен продолжаться в grace-окне, запросов: ${vk.tsSeen.length}`);
});

test("повторный startVk не поднимает второй цикл", async () => {
  const { pollers, vk } = setupLongPoll({ batches: [[]], stopAfter: 1 });

  pollers.startVk();
  pollers.startVk();
  await settle();

  assert.equal(vk.opens, 1, "два параллельных цикла удвоили бы нагрузку на квоту VK");
});

// ——— Long Poll сообщества (эфир 2026-09-12) ———
//
// ВК заблокировал user-аккаунт по флуду: 249 из 249 опросов video.getComments
// упали с ошибкой 9, комментарии два часа не доходили, брони и конкурс
// молчали. Событийный канал идёт под ГРУППОВЫМ токеном и этого блока не
// касается — здесь проверяется, что поллер им пользуется, когда он доступен.

function createLongPollVkFake(batches, { settings = { longPollEnabled: true, videoCommentEventEnabled: true } } = {}) {
  let index = 0;
  return {
    getCommentsCalls: 0,
    namesCalls: 0,
    commentLongPollConfigured: true,
    async getSelfUserId() { return 777; },
    async getCommentLongPollSettings() { return settings; },
    opens: 0,
    async openCommentLongPoll() { this.opens += 1; return { server: "https://lp.vk.com/whp/1", key: "k", ts: "1" }; },
    tsSeen: [],
    reconnects: 0,
    async fetchCommentLongPollUpdates({ ts } = {}) {
      this.tsSeen.push(String(ts));
      const batch = batches[Math.min(index, batches.length - 1)];
      index += 1;
      if (batch instanceof Error) throw batch;
      // "expired" — ВК ответил failed:2: ключ протух, ts остаётся валидным.
      if (batch === "expired") {
        this.reconnects += 1;
        return { ts: String(ts), comments: [], reconnect: true, keepTs: true };
      }
      return { ts: String(10 + index), comments: batch, reconnect: false };
    },
    async fetchViewerNames(ids) {
      this.namesCalls += 1;
      return new Map(ids.map((id) => [id, `Зритель ${id}`]));
    },
    async getComments() { this.getCommentsCalls += 1; return { items: [], profiles: [] }; },
  };
}

function setupLongPoll({ batches, stopAfter = 2, settings } = {}) {
  const driver = createDriver({ stopAfter });
  const comments = [];
  const notices = [];
  const vk = createLongPollVkFake(batches, settings ? { settings } : {});
  const pollers = createCommentPollers({
    vk,
    chatClient: { enabled: false },
    config: {},
    connectionId: "ws-test",
    onComment: (c) => comments.push(c),
    getOpenLotCount: () => 1,
    notify: (p) => notices.push(p),
    sleep: driver.sleep,
  });
  driver.onStop(() => pollers.stopVk());
  return { pollers, vk, comments, notices, delays: driver.delays };
}

function lpComment(id, fromId, text) {
  return { id, from_id: fromId, text, date: 1_700_000_000 };
}

test("Long Poll: события становятся комментариями", async () => {
  const { pollers, vk, comments } = setupLongPoll({
    batches: [[lpComment(31, 5001, "бронь 03900"), lpComment(30, 5002, "хочу")], []],
  });

  pollers.startVk();
  await settle();

  assert.deepEqual(comments.map((c) => c.id), [30, 31], "по возрастанию id, как в опросе");
  assert.equal(comments[0].viewerName, "Зритель 5002", "имя дотянуто отдельным users.get");
  assert.equal(comments[0].source, "vk");
  assert.equal(vk.getCommentsCalls, 0, "video.getComments не зовём вовсе — он и есть заблокированный метод");
});

test("Long Poll: один и тот же id не уезжает дважды", async () => {
  const { pollers, comments } = setupLongPoll({
    batches: [[lpComment(50, 5001, "бронь")], [lpComment(50, 5001, "бронь")], []],
    stopAfter: 2,
  });

  pollers.startVk();
  await settle();

  assert.deepEqual(comments.map((c) => c.id), [50]);
});

test("Long Poll выключен в сообществе — это авария, а не повод опрашивать", async () => {
  // Запасного пути больше нет: опрос video.getComments убран вместе с
  // пользовательским токеном. Выключенное событие = глухой эфир.
  const { pollers, vk, notices } = setupLongPoll({
    batches: [[]],
    settings: { longPollEnabled: true, videoCommentEventEnabled: false },
    stopAfter: 2,
  });

  pollers.startVk();
  await settle();

  assert.equal(vk.getCommentsCalls, 0, "опрашивать больше нечем");
  const health = notices.filter((n) => n.type === "vkCommentsHealth");
  assert.equal(health.length, 1);
  assert.equal(health[0].ok, false);
  assert.match(health[0].hint, /Комментарий к видео/);
});

// ——— Флуд-блок ВК (ошибка 9) ———

function vkError(code) {
  const error = new Error(`VK API ${code}: Flood control`);
  error.vkErrorCode = code;
  return error;
}

test("Long Poll: протухший ключ (failed:2) не сбрасывает позицию в очереди", async () => {
  const { pollers, vk } = setupLongPoll({
    batches: [[lpComment(60, 5001, "бронь")], "expired", []],
    stopAfter: 2,
  });

  pollers.startVk();
  await settle();

  assert.equal(vk.reconnects, 1);
  // Третий запрос идёт с тем же ts, что и упавший второй: свежий ts от
  // нового сервера означал бы прыжок в «сейчас» и потерю броней в этот миг.
  assert.equal(vk.tsSeen[2], vk.tsSeen[1], `ts сброшен: ${vk.tsSeen.join(",")}`);
});
