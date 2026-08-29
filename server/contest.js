// Конкурс в эфире: оператор жмёт «Старт конкурса», сервер загадывает
// трёхзначное число, торги встают на паузу, и побеждает первый, кто напишет
// это число в комментариях.
//
// Заменяет стихийный розыгрыш. 29.08.2026 такой розыгрыш вёлся «на глаз»:
// зрители десять минут сыпали произвольными числами (434 кода от 17 человек),
// V-Amber разбирал каждое как возможную бронь, а ВК ушёл в rate limit и
// задержка опроса комментариев выросла с 1,1 до 8,8 секунды при живом лоте.
//
// Модуль намеренно чистый: ни сети, ни таймеров. Пауза торгов и рассылка
// состояния — забота вызывающего.

const MIN_NUMBER = 100;
const MAX_NUMBER = 999;
// Потолок на дедуп попыток. Конкурс без победителя и без «стоп» живёт до конца
// эфира (таймаута нет — решение оператора), и множество id иначе росло бы
// без границы.
const SEEN_COMMENTS_LIMIT = 2000;

// Числа в комментарии. Сравниваем ТОЛЬКО целые группы цифр: «1234» не должно
// выигрывать конкурс на «123», а «+123» и «123!» — должны.
function extractNumbers(text) {
  return String(text ?? "").match(/\d+/g) || [];
}

export function createContest({ random = Math.random, now = () => Date.now() } = {}) {
  let current = null;

  const snapshot = () => (current
    ? {
      active: true,
      number: current.number,
      startedAt: current.startedAt,
      attempts: current.attempts,
    }
    : { active: false, number: null, startedAt: null, attempts: 0 });

  return {
    isActive: () => current !== null,
    getState: snapshot,

    // Повторный старт при живом конкурсе ничего не перезагадывает: иначе
    // двойной клик менял бы число, которое оператор уже назвал вслух.
    start() {
      if (current) return { started: false, ...snapshot() };
      const span = MAX_NUMBER - MIN_NUMBER + 1;
      current = {
        number: MIN_NUMBER + Math.floor(random() * span),
        startedAt: now(),
        attempts: 0,
        seenCommentIds: new Set(),
      };
      return { started: true, ...snapshot() };
    },

    stop(reason = "operator") {
      if (!current) return { stopped: false, reason, winner: null };
      const { number, attempts } = current;
      current = null;
      return { stopped: true, reason, number, attempts, winner: null };
    },

    // Возвращает победителя, когда комментарий угадал число, иначе null.
    // Конкурс на этом заканчивается — торги снимаются с паузы.
    submit(comment) {
      if (!current) return null;
      const commentId = comment?.commentId ?? comment?.id ?? null;
      if (commentId !== null) {
        if (current.seenCommentIds.has(commentId)) return null;
        current.seenCommentIds.add(commentId);
      }
      if (current.seenCommentIds.size > SEEN_COMMENTS_LIMIT) {
        current.seenCommentIds.delete(current.seenCommentIds.values().next().value);
      }
      current.attempts += 1;

      const guessed = extractNumbers(comment?.text)
        .some((group) => Number(group) === current.number);
      if (!guessed) return null;

      const winner = {
        number: current.number,
        viewerId: comment?.viewerId ?? null,
        viewerName: comment?.viewerName || "",
        commentId,
        attempts: current.attempts,
        durationMs: now() - current.startedAt,
      };
      current = null;
      return winner;
    },
  };
}
