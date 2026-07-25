// Защита от флуда «код без открытого лота». Во время розыгрышей в эфире
// зрители массово постят трёхзначные числа («456», «306», …) — каждое такое
// сообщение выглядит для парсера как попытка брони и раньше порождало
// отдельный WARN в логе и отдельное событие reservationAttention на дашборд
// (эфир 2026-07-25: 1608 записей за вечер, из них 987 за десять минут).
// Порог выбран с запасом: настоящие «бронь по закрытому лоту» приходят
// поштучно, а не десятками в минуту.
//
// Модель простая: фиксированные окна по windowMs. Первые threshold событий
// каждого окна проходят как обычно; всё сверх — подавляется и считается.
// На первом событии следующего окна отдаётся сводка о подавленном.
export function createCommentFloodGuard({ windowMs = 60_000, threshold = 8, now = Date.now } = {}) {
  let windowStart = 0;
  let count = 0;
  let suppressed = 0;

  return {
    // Регистрирует одно событие. Возвращает:
    //   suppress      — событие подавить (не логировать, не слать на дашборд);
    //   floodStarted  — это ПЕРВОЕ подавленное событие окна: самое время
    //                   один раз предупредить оператора и лог;
    //   floodEnded    — окно сменилось, в прошлом был флуд: { suppressed } —
    //                   сколько событий скрыто (для итоговой строки в логе).
    hit() {
      const ts = now();
      let floodEnded = null;
      if (ts - windowStart >= windowMs) {
        if (suppressed > 0) {
          floodEnded = { suppressed };
        }
        windowStart = ts;
        count = 0;
        suppressed = 0;
      }

      count += 1;
      if (count <= threshold) {
        return { suppress: false, floodStarted: false, floodEnded };
      }

      suppressed += 1;
      return { suppress: true, floodStarted: suppressed === 1, floodEnded };
    },
  };
}
