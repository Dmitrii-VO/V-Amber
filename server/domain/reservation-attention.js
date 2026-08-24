import { logger } from "../logger.js";
import { parseReservationComment, hasReservationKeywordToken } from "../reservation-parser.js";
import { resolveKnownCode, codesEquivalent, BUYER_MAX_ZERO_PAD } from "../product-code-resolver.js";
import { createCommentFloodGuard } from "../comment-flood-guard.js";

// Комментарий похож на бронь (ключевое слово + код), но однозначного открытого
// лота под него нет: либо не подошёл ни один, либо подошло несколько
// (ambiguous). Бронировать наугад в денежном пути нельзя, поэтому такие случаи
// уходят ОПЕРАТОРУ на дашборд — не публичным комментарием в VK — и пишутся в
// лог для диагностического бандла. Раньше они пропадали молча: эфир
// 2026-05-24 20:19:54, «…перестала бронировать, Ирина повторите».
//
// Модуль ничего не знает про состояние лотов и не меняет его: он читает список
// открытых лотов, спрашивает каталог и шлёт оператору. Единственный побочный
// эффект наружу — registerPendingReservation, регистрация предложения
// «забронировать прямо из строки внимания».
//
// Ограничитель флуда живёт здесь же: розыгрыши в эфире («угадай число») дают
// сотни комментариев-кодов без открытого лота за считанные минуты, и без него
// каждый порождает WARN и карточку, погребая под собой настоящие проблемы.

export function createReservationAttention({
  connectionId,
  productCodeCache,
  nameCacheStore,
  getOpenLots,
  registerPendingReservation,
  // Строки переживают эфир и разбираются после него: во время эфира оператор
  // держит телефон как камеру и в баннер не смотрит — 6488 строк за 13 эфиров
  // и ноль созданных из них броней. См. server/attention-store.js.
  attentionStore,
  pendingReservationTtlMs = 30 * 60_000,
  notify,
  floodGuard = createCommentFloodGuard(),
} = {}) {
  return {
    // Возвращает true, если случай был вынесен оператору, и false, если
    // комментарий на бронь не похож или подавлен ограничителем. Вызывающему
    // это ни на что не влияет — он в любом случае выходит, — но по значению
    // удобно писать тесты.
    handleNoOpenLot({ comment, target, logSource }) {
      const probe = parseReservationComment(comment.text);
      if (!probe.hasReservationKeyword || !probe.code) {
        return false;
      }

      // «ambiguous» — код подошёл к НЕСКОЛЬКИМ открытым лотам: это живой
      // покупатель у открытого товара, а не шум розыгрыша. Такие идут
      // оператору всегда, мимо ограничителя — иначе во время флуда
      // повторится «перестала бронировать» (инцидент 2026-05-24).
      const isAmbiguous = target?.reason === "ambiguous";
      if (!isAmbiguous) {
        // Слепок события уходит в сводку flood_ended: по server.log
        // восстанавливают пропущенные заказы, счётчика недостаточно.
        const flood = floodGuard.hit({
          commentId: comment.id,
          viewerId: comment.viewerId,
          code: probe.code,
          source: comment.source,
        });
        if (flood.floodEnded) {
          logger.info(logSource, "reservation_no_open_lot_flood_ended", {
            connectionId,
            suppressed: flood.floodEnded.suppressed,
            samples: flood.floodEnded.samples,
          });
        }
        if (flood.suppress) {
          if (flood.floodStarted) {
            logger.warn(logSource, "reservation_no_open_lot_flood", {
              connectionId,
              hint: "всплеск кодов без открытого лота (похоже на розыгрыш) — отдельные события подавлены до конца всплеска",
            });
            notify({
              type: "warning",
              message: "Много комментариев с кодами без открытого лота (розыгрыш?) — показываю не все, бронь по ним не создаётся",
            });
          }
          return false;
        }
      }

      const reason = target?.reason || "no_open_lot";
      const knownCodes = productCodeCache?.getCodes?.() || null;
      const probeCodeResolution = knownCodes && knownCodes.size > 0
        ? resolveKnownCode(probe.code, knownCodes)
        : { status: "no_catalog", code: probe.code, candidates: [] };

      // Голое число, дотянутое до каталожного кода двумя нулями («321» → 00321),
      // на денежном пути больше не бронирует — все 34 таких совпадения за
      // 13 эфиров пришли внутрь потока комментариев розыгрыша. Строку оператору
      // при этом оставляем: вне всплеска (его гасит ограничитель выше) это
      // может быть живой покупатель, и человеку на такое посмотреть полезно.
      // А вот КНОПКУ «забронировать» под ней не даём — иначе одним кликом
      // создаётся ровно та бронь, которую денежный путь только что отклонил.
      const bookableByBuyerRule = probeCodeResolution.status !== "matched"
        || hasReservationKeywordToken(comment.text)
        || codesEquivalent(probe.code, probeCodeResolution.code, {
          maxZeroPad: BUYER_MAX_ZERO_PAD,
          ambiguousCodes: productCodeCache?.getAmbiguousCodes?.() || null,
        });
      const attentionCode = probeCodeResolution.status === "matched"
        ? probeCodeResolution.code
        : probe.code;
      const openLotCodes = getOpenLots().map((lot) => lot.code);
      const viewerNameForAttention = comment.viewerName
        || nameCacheStore?.getName?.(comment.viewerId)
        || "";
      logger.warn(logSource, "reservation_no_open_lot", {
        connectionId,
        commentId: comment.id,
        viewerId: comment.viewerId,
        viewerName: viewerNameForAttention,
        reason,
        text: typeof comment.text === "string" ? comment.text.slice(0, 200) : "",
        reservationCommentCode: probe.code,
        catalogCode: attentionCode,
        catalogMatchReason: probeCodeResolution.reason || null,
        candidateCodes: target?.candidateCodes || [],
        openLotCodes,
      });
      // Бронь прямо из строки внимания предлагаем только когда код
      // однозначно резолвится в каталоге и лота под него просто нет
      // (закрыт / другой день кампании). При reason "ambiguous" код подошёл
      // НЕСКОЛЬКИМ открытым лотам — это разные товары, и выбирать за
      // оператора в денежном пути нельзя.
      const attentionActionId = reason === "no_open_lot"
        && probeCodeResolution.status === "matched"
        && bookableByBuyerRule
        ? registerPendingReservation({
          code: attentionCode,
          viewerId: comment.viewerId,
          viewerName: viewerNameForAttention,
          commentId: comment.id,
          quantity: probe.quantity,
          source: comment.source,
        })
        : null;
      const attentionExpiresAt = attentionActionId ? Date.now() + pendingReservationTtlMs : null;

      // Строка разбора. Пишется всегда — и когда бронь из неё создать можно,
      // и когда нет (ambiguous): оператору после эфира полезно видеть оба
      // случая, кнопка появится только у первого.
      const attentionRowId = attentionStore?.add?.({
        code: attentionCode,
        originalCode: attentionCode !== probe.code ? probe.code : null,
        viewerId: comment.viewerId,
        viewerName: viewerNameForAttention,
        commentId: comment.id,
        text: comment.text,
        quantity: probe.quantity,
        source: comment.source,
        reason,
        bookable: Boolean(attentionActionId),
      }) || null;

      notify({
        type: "reservationAttention",
        reason,
        // Строка живёт в баннере до разбора, а токен под ней протухает через
        // 30 минут. Без этих двух полей оператор видел одинаковые кнопки:
        // рабочую и уже мёртвую (жалоба 15.08 в 01:15 — эфир кончился в 22:51).
        expiresAt: attentionExpiresAt,
        catalogMatchReason: probeCodeResolution.reason || null,
        commentId: comment.id,
        viewerId: comment.viewerId,
        viewerName: viewerNameForAttention,
        code: attentionCode,
        originalCode: attentionCode !== probe.code ? probe.code : undefined,
        text: typeof comment.text === "string" ? comment.text.slice(0, 200) : "",
        candidateCodes: target?.candidateCodes || probeCodeResolution.candidates || [],
        openLotCodes,
        source: comment.source,
        actionId: attentionActionId || undefined,
        rowId: attentionRowId || undefined,
        quantity: probe.quantity || 1,
      });
      return true;
    },
  };
}
