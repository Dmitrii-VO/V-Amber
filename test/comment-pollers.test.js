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

function createVkFake(cycles, { selfUserId = 0, pressure = null } = {}) {
  let index = 0;
  return {
    calls: 0,
    async getSelfUserId() { return selfUserId; },
    async getComments() {
      this.calls += 1;
      const cycle = cycles[Math.min(index, cycles.length - 1)];
      index += 1;
      if (cycle instanceof Error) throw cycle;
      return cycle;
    },
    getQueuePressure: pressure ? () => pressure : undefined,
  };
}

function comment(id, fromId, text) {
  return { id, from_id: fromId, text, date: 1_700_000_000 };
}

// Даём циклу прокрутиться: он асинхронный, но без реальных пауз.
async function settle(ticks = 60) {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function setup({ cycles, vkOptions, openLots = 1, stopAfter = 6, getLastReservationSignalAt = () => null }) {
  const driver = createDriver({ stopAfter });
  const comments = [];
  const notices = [];
  const vk = createVkFake(cycles, vkOptions);
  const pollers = createCommentPollers({
    vk,
    chatClient: { enabled: false },
    config: {},
    connectionId: "ws-test",
    onComment: (c) => comments.push(c),
    getOpenLotCount: () => openLots,
    getLastReservationSignalAt,
    notify: (p) => notices.push(p),
    sleep: driver.sleep,
  });
  driver.onStop(() => pollers.stopVk());
  return { pollers, vk, comments, notices, delays: driver.delays };
}

test("первый цикл только ставит курсор и ничего не отдаёт наружу", async () => {
  const { pollers, comments } = setup({
    cycles: [{ items: [comment(10, 5, "бронь 03204")], profiles: [] }],
    stopAfter: 1,
  });

  pollers.startVk();
  await settle();

  assert.deepEqual(comments, [], "историю до эфира переигрывать нельзя");
  assert.equal(pollers.getState().vkLastCommentId, 10, "курсор встал на последний id");
});

test("новые комментарии уезжают наружу по возрастанию id, старые — нет", async () => {
  const { pollers, comments } = setup({
    cycles: [
      { items: [comment(10, 5, "старый")], profiles: [] },
      {
        items: [comment(12, 7, "бронь 03204"), comment(11, 6, "хочу"), comment(10, 5, "старый")],
        profiles: [{ id: 7, first_name: "Ирина", last_name: "П" }],
      },
    ],
    stopAfter: 2,
  });

  pollers.startVk();
  await settle();

  assert.deepEqual(comments.map((c) => c.id), [11, 12]);
  assert.equal(comments[1].viewerName, "Ирина П");
  assert.equal(comments[1].source, "vk");
});

test("тот же комментарий во второй выдаче не дублируется", async () => {
  const { pollers, comments } = setup({
    cycles: [
      { items: [comment(10, 5, "старый")], profiles: [] },
      { items: [comment(11, 6, "бронь")], profiles: [] },
      { items: [comment(11, 6, "бронь")], profiles: [] },
    ],
    stopAfter: 3,
  });

  pollers.startVk();
  await settle();

  assert.equal(comments.length, 1, "VK отдаёт ленту целиком — дедуп на нашей стороне");
});

test("собственные комментарии бота отбрасываются", async () => {
  const { pollers, comments } = setup({
    cycles: [
      { items: [comment(10, 5, "старый")], profiles: [] },
      { items: [comment(11, 999, "бронь подтверждена (код 03204)"), comment(12, 6, "бронь")], profiles: [] },
    ],
    vkOptions: { selfUserId: 999 },
    stopAfter: 2,
  });

  pollers.startVk();
  await settle();

  assert.deepEqual(comments.map((c) => c.viewerId), [6], "ответ бота нельзя принять за бронь");
});

// Темп опроса задаёт ожидание БРОНЕЙ, а не объём ленты. Розыгрыш «угадай
// число» даёт сотни комментариев в минуту при нуле броней — раньше опрос
// залипал на 1.5 с и выбирал квоту VK ровно тогда, когда уходили подтверждения
// броней (эфиры 24–25.07.2026: 14 из 22 минут с лимитами — минуты потока).
test("интервал: поток комментариев БЕЗ броней опрос не разгоняет", async () => {
  const { pollers, delays } = setup({
    cycles: [
      { items: [comment(10, 5, "старый")], profiles: [] },
      { items: [comment(11, 6, "321")], profiles: [] },
      { items: [comment(12, 7, "555")], profiles: [] },
      { items: [comment(13, 8, "777")], profiles: [] },
      { items: [comment(14, 9, "123")], profiles: [] },
    ],
    stopAfter: 5,
    // сигнала о бронях нет вообще — как во время розыгрыша
  });

  pollers.startVk();
  await settle();

  assert.equal(delays[0], 2000, "после инициализации курсора — фиксированная пауза");
  assert.deepEqual(delays.slice(1, 5), [3000, 4500, 6000, 7500],
    "комментарии сыплются, но броней не ждём — интервал растёт");
});

test("интервал: пока ждём брони — опрашиваем часто, потом растягиваем", async () => {
  let signalAt = Date.now();
  const { pollers, delays } = setup({
    cycles: [
      { items: [comment(10, 5, "старый")], profiles: [] },
      { items: [], profiles: [] },
      { items: [], profiles: [] },
      { items: [], profiles: [] },
      { items: [], profiles: [] },
    ],
    stopAfter: 5,
    getLastReservationSignalAt: () => signalAt,
  });

  pollers.startVk();
  await settle();
  assert.equal(delays[1], 1500, "лот только что открыли — опрашиваем часто");
  assert.equal(delays[2], 1500, "и продолжаем, пока окно не истекло");

  // Окно ожидания броней истекло — тишина в ленте роли не играет, но и
  // держать частый опрос больше незачем.
  signalAt = Date.now() - 5 * 60_000;
  const tail = setup({
    cycles: [
      { items: [comment(20, 5, "старый")], profiles: [] },
      { items: [], profiles: [] },
      { items: [], profiles: [] },
    ],
    stopAfter: 3,
    getLastReservationSignalAt: () => signalAt,
  });
  tail.pollers.startVk();
  await settle();
  assert.deepEqual(tail.delays.slice(1, 3), [3000, 4500], "броней не ждём — интервал растёт");
});

test("ошибки опроса дают экспоненциальный backoff и одно предупреждение", async () => {
  const { pollers, delays, notices } = setup({
    cycles: [new Error("VK 6"), new Error("VK 6"), new Error("VK 6"), new Error("VK 6"), new Error("VK 6")],
    stopAfter: 5,
  });

  pollers.startVk();
  await settle();

  assert.deepEqual(delays.slice(0, 5), [2000, 4000, 8000, 16000, 32000]);
  assert.equal(notices.filter((n) => n.type === "warning").length, 1, "предупреждать оператора один раз за серию");
});

test("очередь публикаций притормаживает опрос", async () => {
  const { pollers, delays } = setup({
    cycles: [
      { items: [comment(10, 5, "старый")], profiles: [] },
      { items: [comment(11, 6, "бронь")], profiles: [] },
    ],
    vkOptions: { pressure: { backoffMultiplier: 1, highPending: 3 } },
    stopAfter: 2,
  });

  pollers.startVk();
  await settle();

  assert.equal(delays[1], 4000, "квота должна уходить ответам покупателям, а не чтению");
});

test("stopVk гасит VK-цикл, но не трогает курсор чата", async () => {
  const driver = createDriver({ stopAfter: 2 });
  const pollers = createCommentPollers({
    vk: createVkFake([{ items: [], profiles: [] }]),
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
  const { pollers } = setup({
    cycles: [{ items: [comment(42, 5, "старый")], profiles: [] }],
    stopAfter: 1,
  });

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
  const vk = createVkFake([{ items: [], profiles: [] }]);
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
  // поэтому опрос обязан продолжаться, а не обрываться сразу.
  assert.ok(vk.calls > 1, `опрос должен продолжаться в grace-окне, вызовов: ${vk.calls}`);
});

test("повторный startVk не поднимает второй цикл", async () => {
  const { pollers, vk } = setup({
    cycles: [{ items: [], profiles: [] }],
    stopAfter: 1,
  });

  pollers.startVk();
  pollers.startVk();
  await settle();

  assert.equal(vk.calls, 1, "два параллельных цикла удвоили бы нагрузку на квоту VK");
});
