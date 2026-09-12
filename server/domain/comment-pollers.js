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
        notify({
          type: "warning",
          message: "Long Poll ВК выключен — комменты читаются опросом. Включите событие «Комментарий к видео: добавлен» в настройках сообщества.",
        });
      }
      return false;
    } catch (error) {
      longPollProbe = false;
      if (!longPollUnavailableWarned) {
        longPollUnavailableWarned = true;
        logger.warn("vk", "comment_longpoll_probe_failed", { connectionId, error });
      }
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
    let consecutiveFailures = 0;
    let noOpenLotsSince = null;
    // Собственные комментарии бота фильтруем так же, как в опросе. 0 =
    // определить не удалось → фильтр выключен; тогда помогает VK_SELF_USER_ID.
    const selfUserId = (await vk.getSelfUserId?.()) || 0;

    logger.info("vk", "comment_longpoll_started", { connectionId, selfUserId });

    while (generation === vkGeneration) {
      const grace = shouldKeepPolling(noOpenLotsSince);
      noOpenLotsSince = grace.since;
      if (!grace.keep) {
        break;
      }

      try {
        if (!connection) {
          connection = await vk.openCommentLongPoll();
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
          && !(selfUserId && item.from_id === selfUserId)
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

    // Адаптивная частота опроса. Раньше её задавал ЛЮБОЙ новый комментарий, и
    // это оказалось ошибкой: розыгрыш «угадай число» даёт 250 комментариев в
    // минуту при нуле броней, опрос залипает на ACTIVE_POLL_MS и выбирает
    // квоту VK ровно тогда, когда подтверждения броней уходят со 2–3 попытки
    // (эфиры 24–25.07.2026: 14 из 22 минут с лимитами — минуты потока, а таких
    // минут всего 16). Публикации при этом не виноваты вовсе: 0 из 166 лимитов
    // совпали с ними.
    //
    // Теперь темп задаёт ожидание БРОНЕЙ, а не шум ленты: свежий лот (медиана
    // брони — 31 с после открытия, 64 % в первую минуту) и только что принятая
    // бронь. Розыгрыш опрос больше не разгоняет.
    const ACTIVE_POLL_MS = 1500;
    const IDLE_POLL_STEP_MS = 1500;
    const IDLE_POLL_MAX_MS = 8000;
    // Пока в high-полосе VK-очереди ждут публикации (закрытия лотов,
    // ответы о брони) — опрос комментариев не чаще этого интервала.
    const PUBLISH_PRESSURE_POLL_MS = 4000;
    // Пауза после ошибки 9 (Flood control): блок висит на аккаунте часами.
    const FLOOD_BLOCK_RETRY_MS = 300000;

    void (async function pollLoop() {
      // Есть событийный канал — идём им. Опрос остаётся запасным путём:
      // Long Poll включается вручную в сообществе и может быть недоступен.
      if (await canUseCommentLongPoll()) {
        await runVkLongPollLoop(generation);
        vkActive = false;
        return;
      }

      let initialized = false;
      let consecutiveFailures = 0;
      let floodBlockedUntil = 0;
      let quietCycles = 0;
      let noOpenLotsSince = null;
      // VK user id самого бота: его комментарии (карточки, обновления цены,
      // подтверждения броней) нельзя переисследовать как чужие брони. 0 =
      // не удалось определить → фильтр выключен (поведение как раньше).
      const selfUserId = (await vk.getSelfUserId?.()) || 0;

      while (generation === vkGeneration) {
        const grace = shouldKeepPolling(noOpenLotsSince);
        noOpenLotsSince = grace.since;
        if (!grace.keep) {
          break;
        }

        try {
          const comments = await vk.getComments(100);
          if (generation !== vkGeneration) {
            break;
          }

          const profileMap = new Map((comments.profiles || []).map((profile) => [profile.id, profile]));
          const sortedItems = (comments.items || []).sort((left, right) => left.id - right.id);

          if (!initialized) {
            initialized = true;
            consecutiveFailures = 0;

            if (vkLastCommentId <= 0) {
              vkLastCommentId = sortedItems.at(-1)?.id || vkLastCommentId;

              await sleep(2000);
              continue;
            }
          }

          const newItems = (comments.items || [])
            .filter((item) => item.id > vkLastCommentId && !vkSeenIds.has(item.id))
            .sort((left, right) => left.id - right.id);

          for (const comment of newItems) {
            vkLastCommentId = Math.max(vkLastCommentId, comment.id);
            addBoundedId(vkSeenIds, comment.id);

            // Игнорируем собственные комментарии бота: иначе ответ «бронь
            // подтверждена (код …)» переисследуется как новая бронь от имени
            // бота → ложный out_of_stock, мусор в wishlist, а при остатке ≥2
            // — фантомный заказ в МойСкладе на аккаунт бота.
            if (selfUserId && comment.from_id === selfUserId) {
              continue;
            }

            const profile = profileMap.get(comment.from_id);
            onComment({
              id: comment.id,
              viewerId: comment.from_id,
              viewerName: profile
                ? [profile.first_name, profile.last_name].filter(Boolean).join(" ")
                : "",
              text: comment.text,
              createdAt: new Date(comment.date * 1000).toISOString(),
              source: "vk",
            });
          }
          reportVkIntake(true);
          if (consecutiveFailures > 0) {
            logger.info("vk", "comment_poll_recovered", {
              connectionId,
              openLotCount: getOpenLotCount(),
              afterFailures: consecutiveFailures,
            });
            notify({ type: "info", message: "VK комменты снова приходят" });
          }
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures += 1;
          const errorCode = getVkApiErrorCode(error);
          if (errorCode === 9) {
            floodBlockedUntil = Date.now() + FLOOD_BLOCK_RETRY_MS;
          }
          logger.warn("vk", "comment_poll_failed", {
            connectionId,
            openLotCount: getOpenLotCount(),
            consecutiveFailures,
            errorCode,
            error,
          });

          if (isFatalCommentReadError(error)) {
            logger.warn("vk", "comment_poll_stopped", {
              connectionId,
              openLotCount: getOpenLotCount(),
              reason: "fatal_api_error",
              errorCode,
            });
            notify({
              type: "error",
              message: `VK comments недоступны для этого видео: ${error?.message || "unknown"}`,
            });
            break;
          }

          // Баннер, а не тост: эфир 2026-09-12 шёл два часа со стопроцентно
          // падающим опросом, и разовое предупреждение с первой минуты
          // оператор уже не видел. Флуд-блок (ошибка 9) поднимает баннер
          // сразу — ждать пяти попыток незачем, он не проходит сам.
          if (errorCode === 9 || consecutiveFailures === 5) {
            reportVkIntake(false, {
              reason: errorCode === 9 ? "flood_control" : `poll_failed_${consecutiveFailures}`,
              hint: errorCode === 9
                ? "ВК заблокировал аккаунт по флуду — брони и конкурс не принимаются, нужен другой VK_USER_TOKEN"
                : errorCode === 5
                  ? "истёк VK-токен — обновите VK_USER_TOKEN в .env и перезапустите"
                  : "ВК не отдаёт комментарии эфира — брони и конкурс сейчас не принимаются",
            });
          }
        }

        let delayMs;
        if (floodBlockedUntil > Date.now()) {
          // Флуд-блок ВК держится часами и от повторов только продлевается:
          // 12.09 мы отстучали в стену 249 запросов за два часа. Ходим раз в
          // пять минут — ровно чтобы заметить, когда блок снимут.
          delayMs = FLOOD_BLOCK_RETRY_MS;
        } else if (consecutiveFailures > 0) {
          // Exponential backoff on failures: 2s → 4s → 8s → 16s → 32s (cap).
          delayMs = Math.min(32000, 2000 * 2 ** Math.min(consecutiveFailures - 1, 4));
        } else if (expectingReservations()) {
          // Ждём броней — опрашиваем часто.
          quietCycles = 0;
          delayMs = ACTIVE_POLL_MS;
        } else {
          // Броней не ждём — плавно растягиваем интервал до потолка.
          quietCycles += 1;
          delayMs = Math.min(IDLE_POLL_MAX_MS, ACTIVE_POLL_MS + quietCycles * IDLE_POLL_STEP_MS);
        }

        // Опрос — low-priority: под rate-limit'ом (адаптивный backoff после
        // VK 6) или при очереди публикаций отступаем, чтобы квота уходила
        // ответам покупателям, а не чтению (эфир 2026-07-25: 52 из 63
        // rate-limit'ов пришлись на video.getComments, и в этот момент
        // подтверждения броней уходили со 2–3 попытки).
        const pressure = vk.getQueuePressure?.();
        if (pressure && consecutiveFailures === 0) {
          if (pressure.backoffMultiplier > 1) {
            delayMs = Math.max(delayMs, ACTIVE_POLL_MS * pressure.backoffMultiplier);
          }
          if (pressure.highPending > 0) {
            delayMs = Math.max(delayMs, PUBLISH_PRESSURE_POLL_MS);
          }
        }
        await sleep(delayMs);
      }

      vkActive = false;
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
