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
    if (getOpenLotCount() > 0) {
      return { keep: true, since: null };
    }
    const since = noOpenLotsSince || Date.now();
    return { keep: Date.now() - since <= NO_OPEN_LOT_GRACE_MS, since };
  }

  function startVk() {
    if (vkActive) {
      return;
    }

    const generation = ++vkGeneration;
    vkActive = true;

    // Адаптивная частота опроса: пока в чате идут новые комментарии — опрос
    // частый (ACTIVE_POLL_MS), в тишине плавно растягивается до IDLE_*. Так
    // в активной фазе брони ловятся быстрее, а в простое мы не жжём квоту VK
    // и не толкаемся с публикациями. Раньше интервал был фиксированный 2с.
    const ACTIVE_POLL_MS = 1500;
    const IDLE_POLL_STEP_MS = 1500;
    const IDLE_POLL_MAX_MS = 8000;
    // Пока в high-полосе VK-очереди ждут публикации (закрытия лотов,
    // ответы о брони) — опрос комментариев не чаще этого интервала.
    const PUBLISH_PRESSURE_POLL_MS = 4000;

    void (async function pollLoop() {
      let initialized = false;
      let consecutiveFailures = 0;
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

        let activityThisCycle = false;
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

          // Был ли в этом цикле новый трафик — задаёт частоту следующего опроса.
          activityThisCycle = newItems.length > 0;

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

          // Notify operator ONCE per outage instead of breaking the loop.
          if (consecutiveFailures === 5) {
            const hint = errorCode === 5
              ? "истёк VK-токен — обновите VK_TOKEN в .env и перезапустите"
              : "проверьте сеть/VK API";
            notify({
              type: "warning",
              message: `VK комменты не приходят (${consecutiveFailures} ошибок подряд): ${hint}`,
            });
          }
        }

        let delayMs;
        if (consecutiveFailures > 0) {
          // Exponential backoff on failures: 2s → 4s → 8s → 16s → 32s (cap).
          delayMs = Math.min(32000, 2000 * 2 ** Math.min(consecutiveFailures - 1, 4));
        } else if (activityThisCycle) {
          // Чат активен — опрашиваем часто.
          quietCycles = 0;
          delayMs = ACTIVE_POLL_MS;
        } else {
          // Тишина — плавно растягиваем интервал до потолка.
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
