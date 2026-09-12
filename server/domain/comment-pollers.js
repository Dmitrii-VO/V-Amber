import { logger } from "../logger.js";
import {
  addBoundedId,
  createBoundedIdSet,
  getVkApiErrorCode,
  isFatalCommentReadError,
} from "../ws-helpers.js";

// Транспорт покупательских комментариев: два опрашивающих цикла — VK и чат
// /efir/. Всё, что модуль знает о мире снаружи, — четыре колбэка:
//
//   onComment(comment)   куда отдать новый комментарий (ingestViewerComment);
//   getOpenLotCount()    есть ли ради чего опрашивать;
//   notify(payload)      сообщение оператору в websocket;
//   connectionId         только для логов.
//
// Разбор комментария, привязка к лоту и брони живут в ws-server и сюда не
// заезжают: этот модуль отвечает исключительно за «когда спросить и что
// считать новым».
//
// Курсоры и generation держим ВНУТРИ. Наружу торчат ровно два управляющих
// вызова, ради которых состояние вообще было общим:
//   stopVk()  — VK отравил лот (ошибка 801): глушим только VK-цикл;
//   reset()   — эфир перезапускается: гасим оба и обнуляем курсоры.

const NO_OPEN_LOT_GRACE_MS = 30000;
// Сколько после сигнала (открылся лот / принята бронь) считаем, что брони ещё
// идут. Медиана брони — 31 с после открытия лота, 64 % приходят в первую
// минуту; две минуты закрывают хвост, не растягивая частый опрос на весь эфир.
const RESERVATION_WINDOW_MS = 120000;

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createCommentPollers({
  vk,
  chatClient,
  config,
  connectionId,
  onComment,
  getOpenLotCount,
  // Когда в последний раз случилось то, ради чего стоит опрашивать чаще:
  // открылся (или был назван заново) лот, либо приняли бронь. Метку ставит
  // ws-server — здесь мы только сравниваем её с окном. null = не ждём ничего.
  getLastReservationSignalAt = () => null,
  // Идёт конкурс — опрашивать нужно даже без открытых лотов: торги на паузе,
  // лоты закрыты, а угаданное число всё равно приходит комментарием. Без
  // этого конкурс без живого лота глохнет целиком (эфир 30.08: два старта
  // подряд, attempts=0, оператор решил, что кнопка не работает).
  isContestActive = () => false,
  notify,
  // Шов для тестов: подменяемая пауза между итерациями. В проде — обычный
  // setTimeout. Без него единственный способ проверить адаптивный интервал и
  // backoff — ждать реальные секунды, поэтому раньше эта логика не была
  // покрыта вовсе.
  sleep = defaultSleep,
} = {}) {
  let vkGeneration = 0;
  let vkActive = false;
  let vkLastCommentId = 0;
  let vkSeenIds = createBoundedIdSet();

  // Отдельный жизненный цикл поллера чата /efir/: VK-poison (ошибка 801 и
  // т.п.) не должен убивать приём броней из собственного чата.
  let chatGeneration = 0;
  let chatActive = false;
  let chatCursor = null;

  // Опрашивать больше нечего — но не рвём сразу: покупатель дописывает бронь
  // ещё несколько секунд после закрытия последнего лота.
  function shouldKeepPolling(noOpenLotsSince) {
    if (getOpenLotCount() > 0 || isContestActive()) {
      return { keep: true, since: null };
    }
    const since = noOpenLotsSince || Date.now();
    return { keep: Date.now() - since <= NO_OPEN_LOT_GRACE_MS, since };
  }

  function expectingReservations() {
    const at = getLastReservationSignalAt();
    return Number.isFinite(at) && Date.now() - at <= RESERVATION_WINDOW_MS;
  }

  // Здоровье приёма комментариев из ВК — для оператора, а не для логов.
  // Эфир 2026-09-12 шёл два часа при ста процентах упавших опросов: ВК
  // заблокировал user-аккаунт по флуду (ошибка 9), зал не доходил вообще,
  // а единственное предупреждение всплыло тостом на первой минуте и
  // исчезло. Поэтому теперь дашборд получает состояние (а не разовое
  // сообщение) и держит баннер, пока комментарии не пойдут снова.
  let vkIntakeHealthy = true;
  function reportVkIntake(ok, { reason = "", hint = "" } = {}) {
    if (ok === vkIntakeHealthy) {
      return;
    }
    vkIntakeHealthy = ok;
    logger.info("vk", ok ? "comment_intake_recovered" : "comment_intake_down", {
      connectionId,
      reason,
    });
    notify({ type: "vkCommentsHealth", ok, reason, hint });
  }

  // Long Poll включают руками в настройках сообщества (см. server/vk.js).
  // Если он не включён — работаем опросом, как раньше, но говорим об этом
  // один раз за жизнь поллера, а не на каждом открытии лота.
  let longPollUnavailableWarned = false;
  // Ответ запоминаем на всё соединение: startVk зовётся на каждом открытии
  // лота (за эфир — под три сотни раз), а настройки сообщества посреди эфира
  // не меняются. Включили событие на живом эфире — увидим после
  // переподключения дашборда.
  let longPollProbe = null;
  async function canUseCommentLongPoll() {
    if (!vk?.commentLongPollConfigured || typeof vk.openCommentLongPoll !== "function") {
      return false;
    }
    if (longPollProbe !== null) {
      return longPollProbe;
    }
    try {
      const settings = await vk.getCommentLongPollSettings();
      longPollProbe = Boolean(settings?.longPollEnabled && settings?.videoCommentEventEnabled);
      if (longPollProbe) {
        return true;
      }
      if (!longPollUnavailableWarned) {
        longPollUnavailableWarned = true;
        logger.warn("vk", "comment_longpoll_disabled", { connectionId, ...settings });
      }
      // Запасного пути больше нет: опрос video.getComments убран вместе с
      // пользовательским токеном (ВК его всё равно не пускает). Выключенное
      // событие = глухой эфир, поэтому это баннер, а не тост.
      reportVkIntake(false, {
        reason: "longpoll_disabled",
        hint: "Не включено событие «Комментарий к видео: добавлен» — брони и конкурс не принимаются",
      });
      return false;
    } catch (error) {
      longPollProbe = false;
      if (!longPollUnavailableWarned) {
        longPollUnavailableWarned = true;
        logger.warn("vk", "comment_longpoll_probe_failed", { connectionId, error });
      }
      reportVkIntake(false, {
        reason: "longpoll_probe_failed",
        hint: "ВК не отдаёт очередь событий — брони и конкурс не принимаются",
      });
      return false;
    }
  }

  // Приём комментариев событиями. Запрос к lp.vk.com висит до 25 секунд и
  // возвращается сам, поэтому пауз между итерациями здесь нет — темпом
  // управляет ВК. Дедуп общий с опросом (vkSeenIds/vkLastCommentId): если
  // Long Poll отвалится и мы уедем на опрос, старое не переиграется.
  async function runVkLongPollLoop(generation) {
    const LONG_POLL_WAIT_SEC = 25;
    const viewerNames = new Map();
    let connection = null;
    let keptTs = null;
    let consecutiveFailures = 0;
    let noOpenLotsSince = null;
    // Собственные комментарии сообщества отфильтрованы в vk.js по from_id:
    // публикуем мы теперь от имени группы, а у неё id отрицательный.
    logger.info("vk", "comment_longpoll_started", { connectionId });

    while (generation === vkGeneration) {
      const grace = shouldKeepPolling(noOpenLotsSince);
      noOpenLotsSince = grace.since;
      if (!grace.keep) {
        break;
      }

      try {
        if (!connection) {
          connection = await vk.openCommentLongPoll();
          if (keptTs) {
            connection = { ...connection, ts: keptTs };
            keptTs = null;
          }
        }
        const startedAt = Date.now();
        const update = await vk.fetchCommentLongPollUpdates({
          ...connection,
          waitSec: LONG_POLL_WAIT_SEC,
        });
        if (generation !== vkGeneration) {
          break;
        }
        if (update?.reconnect) {
          // Ключ протух (failed:2) — позицию в очереди сохраняем, иначе
          // новый сервер отдаст ts «сейчас» и брони, пришедшие в этот
          // момент, до нас не доедут.
          keptTs = update.keepTs ? connection.ts : null;
          connection = null;
          await sleep(1000);
          continue;
        }
        connection = { ...connection, ts: update.ts };
        consecutiveFailures = 0;
        reportVkIntake(true);

        const fresh = (update.comments || []).filter((item) => (
          Number.isFinite(item.id)
          && item.id > vkLastCommentId
          && !vkSeenIds.has(item.id)
        ));

        // Имён в событии нет — дотягиваем их пачкой на новых авторов.
        const unknownIds = fresh
          .map((item) => item.from_id)
          .filter((id) => !viewerNames.has(id));
        if (unknownIds.length > 0 && typeof vk.fetchViewerNames === "function") {
          try {
            for (const [id, name] of await vk.fetchViewerNames(unknownIds)) {
              viewerNames.set(id, name);
            }
          } catch (error) {
            logger.warn("vk", "comment_longpoll_names_failed", { connectionId, error });
          }
        }

        for (const item of fresh.sort((left, right) => left.id - right.id)) {
          vkLastCommentId = Math.max(vkLastCommentId, item.id);
          addBoundedId(vkSeenIds, item.id);
          onComment({
            id: item.id,
            viewerId: item.from_id,
            viewerName: viewerNames.get(item.from_id) || "",
            text: item.text,
            createdAt: new Date(item.date * 1000).toISOString(),
            source: "vk",
          });
        }

        // Страховка от сервера, который отвечает мгновенно и пусто: без неё
        // такой цикл крутится на полной скорости.
        if (fresh.length === 0 && Date.now() - startedAt < 1000) {
          await sleep(1000);
        }
      } catch (error) {
        consecutiveFailures += 1;
        logger.warn("vk", "comment_longpoll_failed", {
          connectionId,
          consecutiveFailures,
          error,
        });
        if (consecutiveFailures >= 3) {
          reportVkIntake(false, {
            reason: "longpoll_failed",
            hint: "ВК не отдаёт комментарии эфира — брони и конкурс сейчас не принимаются",
          });
        }
        connection = null;
        await sleep(Math.min(30000, 2000 * 2 ** Math.min(consecutiveFailures - 1, 4)));
      }
    }
  }

  function startVk() {
    if (vkActive) {
      return;
    }

    const generation = ++vkGeneration;
    vkActive = true;

    void (async () => {
      if (await canUseCommentLongPoll()) {
        await runVkLongPollLoop(generation);
      }
      if (generation === vkGeneration) {
        vkActive = false;
      }
    })();
  }

  // Поллер чата /efir/ — второй источник броней. Жизненный цикл зеркалит
  // VK-поллер (старт при открытии лота, стоп по grace-окну без открытых
  // лотов), но generation у него свой: VK-poison не должен глушить чат.
  // Курсор переживает рестарты поллера внутри соединения; null → первая
  // итерация только инициализирует его последним seq сервиса (историю до
  // эфира не переигрываем — как VK-поллер по последнему id).
  function startChat() {
    if (!chatClient?.enabled || chatActive) {
      return;
    }

    const generation = ++chatGeneration;
    chatActive = true;
    const pollMs = Number(config?.chat?.pollMs) > 0 ? Number(config.chat.pollMs) : 3000;

    void (async function chatPollLoop() {
      let consecutiveFailures = 0;
      let noOpenLotsSince = null;

      while (generation === chatGeneration) {
        const grace = shouldKeepPolling(noOpenLotsSince);
        noOpenLotsSince = grace.since;
        if (!grace.keep) {
          break;
        }

        try {
          const feed = await chatClient.fetchFeed(chatCursor);
          if (generation !== chatGeneration) {
            break;
          }

          if (chatCursor === null) {
            chatCursor = feed.latestSeq;
          } else {
            for (const message of feed.messages) {
              if (!(Number(message.seq) > chatCursor)) {
                continue;
              }
              chatCursor = Number(message.seq);
              onComment({
                id: message.commentId,
                viewerId: message.viewerId,
                viewerName: message.name || "",
                text: message.text,
                createdAt: new Date(message.ts).toISOString(),
                source: "chat",
                phone: message.phone || null,
              });
            }
          }

          if (consecutiveFailures > 0) {
            logger.info("chat", "chat_poll_recovered", {
              connectionId,
              openLotCount: getOpenLotCount(),
              afterFailures: consecutiveFailures,
            });
            notify({ type: "info", message: "Чат эфира снова отвечает" });
          }
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures += 1;
          logger.warn("chat", "chat_poll_failed", {
            connectionId,
            openLotCount: getOpenLotCount(),
            consecutiveFailures,
            error,
          });
          // Однократное предупреждение оператору на серию сбоев; цикл не
          // останавливаем — чат-сервис может вернуться в любой момент.
          if (consecutiveFailures === 5) {
            notify({
              type: "warning",
              message: "Чат эфира не отвечает — брони со страницы зрителей временно не приходят",
            });
          }
        }

        const delayMs = consecutiveFailures > 0
          ? Math.min(30000, 3000 * 2 ** Math.min(consecutiveFailures - 1, 3))
          : pollMs;
        await sleep(delayMs);
      }

      chatActive = false;
    })();
  }

  return {
    startVk,
    startChat,

    // VK отравил лот (ошибка 801 и т.п.). Следующая итерация цикла увидит
    // выросший generation и выйдет. Чат при этом продолжает работать.
    stopVk() {
      vkGeneration += 1;
      vkActive = false;
    },

    // Эфир перезапускается: гасим оба цикла и забываем курсоры, иначе новый
    // эфир унаследовал бы позицию в ленте предыдущего.
    reset() {
      vkGeneration += 1;
      vkActive = false;
      vkLastCommentId = 0;
      vkSeenIds = createBoundedIdSet();
      chatGeneration += 1;
      chatActive = false;
      chatCursor = null;
      vkIntakeHealthy = true;
      longPollProbe = null;
    },

    // Только для тестов и диагностики: снаружи на это состояние никто не
    // опирается, и опираться не должен.
    getState() {
      return {
        vkActive,
        vkLastCommentId,
        chatActive,
        chatCursor,
      };
    },
  };
}
