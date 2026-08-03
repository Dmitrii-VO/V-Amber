// Перекрёстные подсказки между двумя площадками одного эфира.
//
// Эфир идёт одновременно в ВК и на своей площадке (мультистрим делает плагин
// obs-multi-rtmp на стороне OBS — V-Amber про этот дубль ничего не знает).
// У обеих площадок бывают проблемы с качеством, и зритель должен знать про
// запасной экран: зрителям ВК рассказываем про сайт, зрителям /efir/ — про ВК.
//
// Главное правило: НИКОГДА не звать на мёртвую площадку. Поэтому на каждом
// такте обе проверяются по-настоящему:
//   - своя  — getStreamStatus() (MediaMTX `ready`, работает независимо от того,
//             чем пушат поток);
//   - ВК    — vk.validateLiveVideoUrl() (`live_status === "started"`).
// Состояние ffmpeg-релея (server/stream-relay.js) для этого НЕ годится: с
// obs-multi-rtmp релей всегда idle, хотя ВК-эфир идёт (логи 2026-08-01: ни
// одной строки relay за всё время).
//
// Такта два, но таймер один:
//   - каждые probeIntervalMinutes (5) — проба обеих площадок и обновление
//     плашки со ссылкой на странице зрителя (появляется/гаснет вслед за ВК);
//   - раз в intervalMinutes (25) — собственно сообщения в оба канала.
//
// Канал best-effort: любая ошибка — WARN и пропуск такта. Эфир, брони и
// МойСклад от этого модуля не зависят.

function minutesToMs(value, fallbackMinutes) {
  const minutes = Number(value);
  return Math.max(1000, (Number.isFinite(minutes) && minutes > 0 ? minutes : fallbackMinutes) * 60_000);
}

export function renderPromoText(template, url) {
  return String(template || "").replace(/\{url\}/g, url || "").trim();
}

export function createCrossPromoPublisher({
  config,
  vk,
  chatClient,
  getStreamStatus,
  logger,
  connectionId = null,
} = {}) {
  const promoConfig = config?.crossPromo || {};
  const viewerUrl = config?.stream?.viewerUrl || "";
  const messageIntervalMs = minutesToMs(promoConfig.intervalMinutes, 25);
  const probeIntervalMs = minutesToMs(promoConfig.probeIntervalMinutes, 5);
  const firstDelayMs = minutesToMs(promoConfig.firstDelayMinutes, 12);

  let timer = null;
  let running = false;
  let lastMessagesAt = 0;
  let vkVariantIndex = 0;
  let chatVariantIndex = 0;
  // Плашку не переотправляем на каждом такте, если ничего не изменилось.
  let publishedMirrorUrl = null;

  // Проба своей площадки. Ошибка/недоступность MediaMTX = «не живо»: лучше
  // промолчать, чем позвать зрителей ВК на страницу с чёрным экраном.
  async function probeOwn() {
    if (typeof getStreamStatus !== "function" || !viewerUrl) {
      return false;
    }
    try {
      const status = await getStreamStatus();
      return Boolean(status?.live);
    } catch (error) {
      logger?.warn?.("stream", "cross_promo_own_probe_failed", {
        connectionId,
        error: error?.message || String(error),
      });
      return false;
    }
  }

  // Проба ВК. Ссылку берём ту же, у которой читаем комментарии — она заведомо
  // актуальна для этого эфира и не может протухнуть, в отличие от отдельной
  // переменной окружения.
  async function probeVk() {
    const url = vk?.getLiveVideoUrl?.() || "";
    if (!url || !vk?.validateLiveVideoUrl) {
      return { live: false, url: "" };
    }
    try {
      const result = await vk.validateLiveVideoUrl(url);
      return { live: result?.ok === true && result.isLive === true, url };
    } catch (error) {
      logger?.warn?.("vk", "cross_promo_vk_probe_failed", {
        connectionId,
        error: error?.message || String(error),
      });
      return { live: false, url };
    }
  }

  // Плашка «смотреть в ВК» под плеером на /efir/. Ссылка кликабельная (в
  // отличие от текста сообщения в чате, который рисуется textContent'ом).
  async function syncMirrorBanner(mirrorUrl) {
    if (!chatClient?.enabled || !chatClient.publishBroadcastState) {
      return;
    }
    // Пустую строку шлём ПОВТОРНО раз в такт, а не один раз: у состояния на
    // той стороне есть TTL, и регулярный пинг — то, что держит плашку живой.
    if (mirrorUrl === publishedMirrorUrl && mirrorUrl === "") {
      return;
    }
    const result = await chatClient.publishBroadcastState({ vkMirrorUrl: mirrorUrl });
    if (!result?.ok) {
      logger?.warn?.("chat", "mirror_banner_publish_failed", {
        connectionId,
        error: result?.error || "unknown",
      });
      publishedMirrorUrl = null;
      return;
    }
    if (mirrorUrl !== publishedMirrorUrl) {
      logger?.info?.("chat", "mirror_banner_updated", {
        connectionId,
        shown: Boolean(mirrorUrl),
      });
    }
    publishedMirrorUrl = mirrorUrl;
  }

  function nextVariant(variants, index) {
    if (!Array.isArray(variants) || variants.length === 0) {
      return null;
    }
    return variants[index % variants.length];
  }

  async function publishMessages({ ownLive, vkLive, vkUrl }) {
    // Оба сообщения требуют, чтобы жили ОБЕ площадки: своя — потому что иначе
    // на ней некому читать и некуда звать, ВК — симметрично.
    if (!ownLive || !vkLive) {
      logger?.info?.("stream", "cross_promo_skipped", {
        connectionId,
        ownLive,
        vkLive,
        reason: "one_side_offline",
      });
      return;
    }

    const vkText = renderPromoText(nextVariant(promoConfig.vkVariants, vkVariantIndex), viewerUrl);
    const chatText = renderPromoText(nextVariant(promoConfig.chatVariants, chatVariantIndex), vkUrl);
    vkVariantIndex += 1;
    chatVariantIndex += 1;

    const results = await Promise.allSettled([
      vkText && vk?.publishCrossPromo ? vk.publishCrossPromo(vkText) : Promise.resolve(null),
      chatText && chatClient?.enabled ? chatClient.postServiceMessage(chatText) : Promise.resolve(null),
    ]);
    const vkResult = results[0].status === "fulfilled" ? results[0].value : null;
    const chatResult = results[1].status === "fulfilled" ? results[1].value : null;

    logger?.info?.("stream", "cross_promo_published", {
      connectionId,
      vk: vkResult?.ok === true,
      vkSkipped: Boolean(vkResult?.skipped),
      chat: chatResult?.ok === true,
      viewerUrl,
      vkUrl,
    });
  }

  async function tick() {
    const [ownLive, vkProbe] = await Promise.all([probeOwn(), probeVk()]);
    await syncMirrorBanner(vkProbe.live ? vkProbe.url : "");

    if (Date.now() - lastMessagesAt >= messageIntervalMs) {
      lastMessagesAt = Date.now();
      await publishMessages({ ownLive, vkLive: vkProbe.live, vkUrl: vkProbe.url });
    }
  }

  // Планировщик на setTimeout, а не setInterval: такт делает сетевые запросы,
  // и следующая пауза должна отсчитываться от конца предыдущего — тот же
  // приём, что у периодических инструкций зрителям.
  function schedule(delayMs) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (!running) return;
      try {
        await tick();
      } catch (error) {
        logger?.warn?.("stream", "cross_promo_tick_failed", {
          connectionId,
          error: error?.message || String(error),
        });
      }
      if (running) schedule(probeIntervalMs);
    }, delayMs);
    timer.unref?.();
  }

  return {
    enabled: promoConfig.enabled !== false,

    start() {
      if (promoConfig.enabled === false || running) return;
      running = true;
      // Первый такт — не сразу: эфиру нужно время реально подняться на обеих
      // площадках, иначе первая же проба даст «не живо» и плашка мигнёт.
      // Сообщения при этом уходят не раньше firstDelay (lastMessagesAt = now).
      lastMessagesAt = Date.now() - messageIntervalMs + firstDelayMs;
      schedule(Math.min(probeIntervalMs, firstDelayMs));
    },

    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Эфир кончился — плашку у зрителей снимаем сразу, не дожидаясь TTL.
      if (publishedMirrorUrl) {
        publishedMirrorUrl = null;
        void chatClient?.publishBroadcastState?.({ vkMirrorUrl: "" });
      }
    },

    // Для тестов: один такт без таймеров. forceMessages снимает ограничение
    // «не чаще intervalMinutes», чтобы не ждать 25 минут в тесте.
    async tickForTests({ forceMessages = false } = {}) {
      if (forceMessages) lastMessagesAt = 0;
      await tick();
    },
  };
}
