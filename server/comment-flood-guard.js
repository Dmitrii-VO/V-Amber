// Защита от флуда «код без открытого лота». Во время розыгрышей в эфире
// зрители массово постят трёхзначные числа («456», «306», …) — каждое такое
// сообщение выглядит для парсера как попытка брони и раньше порождало
// отдельный WARN в логе и отдельное событие reservationAttention на дашборд
// (эфир 2026-07-25: 1608 записей за вечер, из них 987 за десять минут).
// Порог выбран с запасом: настоящие «бронь по закрытому лоту» приходят
// поштучно, а не десятками в минуту.
//
// Модель простая: фиксированные окна по windowMs. Первые threshold событий
// каждого окна проходят как обычно; всё сверх — подавляется и считается,
// первые maxSamples подавленных сохраняются целиком для итоговой сводки:
// по server.log восстанавливают пропущенные заказы (см. wiki
// order-recovery-from-logs), поэтому подавленные события обязаны оставлять
// восстановимый след, а не только счётчик. Сводка отдаётся на первом событии
// СЛЕДУЮЩЕГО окна — лениво: если после всплеска событий больше нет (конец
// эфира, реконнект дашборда), сводка теряется. Это осознанный компромисс —
// сами комментарии при этом остаются в VK и в ленте viewerComment.
export function createCommentFloodGuard({ windowMs = 60_000, threshold = 8, maxSamples = 50, now = Date.now } = {}) {
  let windowStart = 0;
  let count = 0;
  let suppressed = 0;
  let samples = [];

  return {
    // Регистрирует одно событие; sample — компактный слепок для сводки
    //   (commentId/viewerId/код). Возвращает:
    //   suppress      — событие подавить (не логировать, не слать на дашборд);
    //   floodStarted  — это ПЕРВОЕ подавленное событие окна: самое время
    //                   один раз предупредить оператора и лог;
    //   floodEnded    — окно сменилось, в прошлом был флуд:
    //                   { suppressed, samples } для итоговой строки в логе.
    hit(sample) {
      const ts = now();
      let floodEnded = null;
      if (ts - windowStart >= windowMs) {
        if (suppressed > 0) {
          floodEnded = { suppressed, samples };
        }
        windowStart = ts;
        count = 0;
        suppressed = 0;
        samples = [];
      }

      count += 1;
      if (count <= threshold) {
        return { suppress: false, floodStarted: false, floodEnded };
      }

      suppressed += 1;
      if (sample !== undefined && samples.length < maxSamples) {
        samples.push(sample);
      }
      return { suppress: true, floodStarted: suppressed === 1, floodEnded };
    },
  };
}
