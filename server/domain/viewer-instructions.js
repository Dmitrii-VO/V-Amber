// Периодическая инструкция зрителям: как забронировать и как отменить.
//
// Зрители подключаются к эфиру в разное время, и формат брони («номер
// артикула отдельным комментарием») половина зала не видела. Публикуется
// одновременно в VK-комментарии и в чат /efir/ — это две разные аудитории,
// и промах одной площадки не должен отменять вторую (Promise.allSettled).
//
// Про мир снаружи модуль знает три вещи:
//   vk / chatClient  куда публиковать;
//   isLive()         идёт ли ещё эфир — таймер мог дотикать после остановки;
//   connectionId     только для логов.
//
// Перекрёстные подсказки (cross-promo.js) заводятся и гасятся вместе с
// инструкциями, но своим флагом — этим управляет ws-server в точках старта и
// остановки эфира, здесь про них ничего не знают.

import { logger } from "../logger.js";

export function createViewerInstructions({
  config,
  vk,
  chatClient,
  connectionId,
  isLive,
}) {
  let timer = null;
  let variantIndex = 0;

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function publish() {
    const variants = config.viewerInstructions?.variants || [];
    if (variants.length === 0) return;
    // Варианты чередуются: VK режет подряд идущие одинаковые комментарии
    // под одним видео, и одинаковый текст каждые полчаса читается как спам.
    const message = variants[variantIndex % variants.length];
    variantIndex += 1;

    const results = await Promise.allSettled([
      vk.publishViewerInstruction(message),
      chatClient?.postServiceMessage?.(message),
    ]);
    const vkResult = results[0].status === "fulfilled" ? results[0].value : null;
    const chatResult = results[1].status === "fulfilled" ? results[1].value : null;
    logger.info("vk", "viewer_instruction_published", {
      connectionId,
      variantIndex: (variantIndex - 1) % variants.length,
      vk: vkResult?.ok === true,
      vkSkipped: Boolean(vkResult?.skipped),
      chat: chatResult?.ok === true,
    });
  }

  // Нижняя граница — в миллисекундах, а не в минутах: из окружения интервал
  // приходит целым числом минут, а тесты гоняют доли минуты.
  function intervalMs() {
    const minutes = Number(config.viewerInstructions?.intervalMinutes);
    return Math.max(1000, (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000);
  }

  // Планировщик на setTimeout, а не setInterval: публикация может занять
  // секунды (ретраи VK), и следующая пауза должна отсчитываться от конца
  // предыдущей — иначе при затыке VK инструкции пойдут очередью подряд.
  function schedule(delayMs) {
    stop();
    timer = setTimeout(() => {
      timer = null;
      // Эфир мог кончиться, пока таймер тикал.
      if (!isLive()) return;
      void publish()
        .catch((error) => {
          logger.error("vk", "viewer_instruction_failed", { connectionId, error });
        })
        .finally(() => {
          if (isLive()) schedule(intervalMs());
        });
    }, delayMs);
    timer.unref?.();
  }

  return {
    start() {
      if (config.viewerInstructions?.enabled === false) return;
      if (timer) return;
      const firstDelayMin = Number(config.viewerInstructions?.firstDelayMinutes);
      schedule(Math.max(0, Number.isFinite(firstDelayMin) ? firstDelayMin : 2) * 60_000);
    },
    stop,
  };
}
