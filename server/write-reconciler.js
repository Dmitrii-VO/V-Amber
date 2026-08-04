import { logger } from "./logger.js";

// Сверка оборвавшейся записи в МойСклад.
//
// Нужна для исхода "unknown": запрос ушёл, ответ потерялся, и вслепую повторять
// нельзя — получим дубль заказа. Сверка отвечает на один вопрос: применилась
// запись или нет.
//
// Ничего специально в МойСклад для этого не пишется. Create-путь опознаётся по
// маркеру commentId, который createCustomerOrderReservation и так кладёт в
// description. Append-путь — сравнением числа позиций до записи и после
// неизвестного исхода.
//
// Ответ "inconclusive" — законный и намеренный: лучше оставить бронь оператору
// с громкой записью в логе, чем угадать и создать дубль или потерять бронь.

export function createReservationReconciler({ moysklad, journal } = {}) {
  async function resolveCreate(args, entry) {
    const counterpartyId = entry?.meta?.counterpartyId || args?.counterparty?.id || null;
    const commentId = entry?.meta?.commentId || args?.reservation?.commentId || null;
    const lotSessionId = entry?.meta?.lotSessionId || args?.activeLot?.lotSessionId || null;

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

  async function resolveAppend(args, key, entry) {
    const journalEntry = entry || journal.lookup(key);
    const orderId = journalEntry?.meta?.orderId || args?.orderId || null;
    const productId = journalEntry?.meta?.productId || args?.activeLot?.product?.id || null;
    if (!orderId || !productId) {
      return { status: "inconclusive", reason: "order_or_product_missing" };
    }

    const baseline = journalEntry?.meta?.positionCountBefore;
    if (!Number.isInteger(baseline) || baseline < 0) {
      return { status: "inconclusive", reason: "position_baseline_missing" };
    }
    const actual = await moysklad.countPositionsForProduct(orderId, productId, {
      source: "write_reconcile",
    });

    if (actual === baseline + 1) {
      return { status: "applied", result: { id: orderId, orderId, positionId: null, positionsAdded: 1 } };
    }

    if (actual === baseline) {
      return { status: "not_applied" };
    }

    // actual < baseline — позицию удалили (отмена брони оператором).
    // actual > baseline + 1 — в заказ писал кто-то ещё, например оператор.
    // В обоих случаях наш вывод был бы догадкой.
    return { status: "inconclusive", reason: "position_count_mismatch", baseline, actual };
  }

  return {
    async prepare({ method, args, meta }) {
      if (method !== "appendPositionToCustomerOrder") return meta;
      const orderId = args?.orderId || null;
      const productId = args?.activeLot?.product?.id || null;
      if (!orderId || !productId) return meta;
      try {
        const positionCountBefore = await moysklad.countPositionsForProduct(orderId, productId, {
          source: "write_reconcile_baseline",
        });
        return { ...(meta || {}), positionCountBefore };
      } catch (error) {
        logger.warn("write-reconciler", "baseline_failed", { method, orderId, productId, error });
        const baselineError = new Error("Cannot persist a safe append baseline before MoySklad write", { cause: error });
        baselineError.code = "MOYSKLAD_WRITE_BASELINE_FAILED";
        throw baselineError;
      }
    },
    async resolve({ method, args, key, entry = null }) {
      try {
        if (method === "createCustomerOrderReservation") {
          return await resolveCreate(args, entry);
        }
        if (method === "appendPositionToCustomerOrder") {
          return await resolveAppend(args, key, entry);
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
