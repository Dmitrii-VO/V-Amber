import { logger } from "./logger.js";

// Сверка оборвавшейся записи в МойСклад.
//
// Нужна для исхода "unknown": запрос ушёл, ответ потерялся, и вслепую повторять
// нельзя — получим дубль заказа. Сверка отвечает на один вопрос: применилась
// запись или нет.
//
// Ничего специально в МойСклад для этого не пишется. Create-путь опознаётся по
// маркеру commentId, который createCustomerOrderReservation и так кладёт в
// description. Append-путь — сравнением: сколько позиций товара реально в
// заказе против того, сколько записей журнал подтвердил.
//
// Ответ "inconclusive" — законный и намеренный: лучше оставить бронь оператору
// с громкой записью в логе, чем угадать и создать дубль или потерять бронь.

export function createReservationReconciler({ moysklad, journal } = {}) {
  async function resolveCreate(args) {
    const counterpartyId = args?.counterparty?.id || null;
    const commentId = args?.reservation?.commentId || null;
    const lotSessionId = args?.activeLot?.lotSessionId || null;

    // Контрагента на этом пути разрешает сам createCustomerOrderReservation
    // через ensureCounterparty — а это запись (может создать контрагента).
    // Для сверки звать её нельзя, поэтому без готового контрагента честно
    // отвечаем «не знаю».
    if (!counterpartyId || !commentId) {
      return { status: "inconclusive", reason: "counterparty_or_comment_missing" };
    }

    const found = await moysklad.findCustomerOrderByCommentMarker({
      counterpartyId,
      commentId,
      lotSessionId,
      source: "write_reconcile",
    });

    if (!found?.id) {
      return { status: "not_applied" };
    }

    // positionId нужен отмене брони для адресного DELETE. Тем же фоллбэком,
    // что и на обычном create-пути; его отсутствие бронь не роняет.
    let positionId = null;
    try {
      positionId = await moysklad.resolveFirstOrderPositionId(found.id);
    } catch {
      positionId = null;
    }

    return {
      status: "applied",
      result: {
        id: found.id,
        name: found.name,
        positionId,
        counterpartyId,
      },
    };
  }

  async function resolveAppend(args) {
    const orderId = args?.orderId || null;
    const productId = args?.activeLot?.product?.id || null;
    if (!orderId || !productId) {
      return { status: "inconclusive", reason: "order_or_product_missing" };
    }

    const known = journal.countApplied({ orderId, productId });
    const actual = await moysklad.countPositionsForProduct(orderId, productId, {
      source: "write_reconcile",
    });

    // Ровно на одну больше, чем журнал подтвердил — это наша потерянная
    // запись, она доехала.
    if (actual === known + 1) {
      return { status: "applied", result: { orderId, positionId: null, positionsAdded: 1 } };
    }

    if (actual === known) {
      return { status: "not_applied" };
    }

    // actual < known — позицию удалили (отмена брони оператором).
    // actual > known + 1 — в заказ писал кто-то ещё, например оператор руками.
    // В обоих случаях наш вывод был бы догадкой.
    return { status: "inconclusive", reason: "position_count_mismatch", known, actual };
  }

  return {
    async resolve({ method, args }) {
      try {
        if (method === "createCustomerOrderReservation") {
          return await resolveCreate(args);
        }
        if (method === "appendPositionToCustomerOrder") {
          return await resolveAppend(args);
        }
        return { status: "inconclusive", reason: "unsupported_method" };
      } catch (error) {
        // Сверка сама упала — это не повод угадывать исход записи.
        logger.warn("write-reconciler", "reconcile_failed", { method, error });
        return { status: "inconclusive", reason: "reconcile_error" };
      }
    },
  };
}
