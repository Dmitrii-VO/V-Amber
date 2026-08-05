import { logger } from "./logger.js";
import { buildPurchaseOrderSyncId } from "./moysklad-helpers.js";

// Сверка оборвавшейся записи в МойСклад.
//
// Нужна для исхода "unknown": запрос ушёл, ответ потерялся, и вслепую повторять
// нельзя — получим дубль заказа. Сверка отвечает на один вопрос: применилась
// запись или нет.
//
// Ничего специально в МойСклад для этого не пишется. Create-путь опознаётся по
// маркеру commentId, который createCustomerOrderReservation и так кладёт в
// description. Append-путь — сравнением числа позиций до записи и после
// неизвестного исхода. Закупочный заказ — по syncId (внешний код группы,
// который createPurchaseOrder кладёт в сам заказ), с запасным слоем по
// отпечатку группы (поставщик, склад, описание, состав позиций).
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

  // Закупочный заказ. args приходят от того же обработчика отправки, что и в
  // первой попытке (группа детерминирована groupHash), поэтому и syncId, и
  // отпечаток можно собрать прямо из них; meta — фоллбэк для полей, которые в
  // args могут отсутствовать.
  //
  // Два слоя, именно в этом порядке:
  //   1. syncId — точный внешний код группы. Нашли — вопрос закрыт.
  //   2. отпечаток — для заказов, отправленных ДО появления syncId (например,
  //      попытка осталась в журнале с прошлой версии приложения), и на случай,
  //      если фильтр по syncId недоступен.
  // Пустой ответ первого слоя сам по себе ничего не доказывает, поэтому
  // «не применилось» произносит только второй.
  //
  // Второй слой — подстраховка, а не необходимость: МойСклад трактует syncId
  // как ключ upsert (проверено 2026-08-05, см. buildPurchaseOrderSyncId),
  // поэтому даже ошибочный повтор с тем же syncId обновит существующий заказ,
  // а не создаст дубль.
  async function resolvePurchaseOrder(args, entry) {
    const agentId = args?.agentId || entry?.meta?.agentId || null;
    const positions = Array.isArray(args?.positions) ? args.positions : [];
    if (!agentId || positions.length === 0) {
      return { status: "inconclusive", reason: "purchase_order_args_missing" };
    }

    const syncId = buildPurchaseOrderSyncId({
      draftId: args?.draftId || entry?.meta?.draftId || null,
      groupHash: args?.groupHash || entry?.meta?.groupHash || null,
    });
    if (syncId && typeof moysklad.findPurchaseOrdersBySyncId === "function") {
      const bySyncId = await moysklad.findPurchaseOrdersBySyncId({ syncId, source: "write_reconcile" });
      const rows = Array.isArray(bySyncId?.rows) ? bySyncId.rows : [];
      if (rows.length === 1) {
        return { status: "applied", result: { id: rows[0].id, name: rows[0].name, agentId, syncId } };
      }
      // Больше одного заказа с одним внешним кодом быть не должно. Если это
      // случилось, догадываться, какой из них наш, мы не будем.
      if (rows.length > 1) {
        return { status: "inconclusive", reason: "sync_id_ambiguous" };
      }
    }

    const found = await moysklad.findPurchaseOrdersByFingerprint({
      agentId,
      storeId: args?.storeId || entry?.meta?.storeId || null,
      positions,
      description: args?.description || "",
      source: "write_reconcile",
    });

    if (found?.inconclusiveReason) {
      return { status: "inconclusive", reason: found.inconclusiveReason };
    }
    const matches = Array.isArray(found?.matches) ? found.matches : [];
    if (matches.length === 0) {
      return { status: "not_applied" };
    }
    // Два одинаковых заказа — либо дубль уже есть, либо оператор создал такой
    // же руками. Ни то, ни другое не даёт права повторять запись.
    if (matches.length > 1) {
      return { status: "inconclusive", reason: "purchase_order_ambiguous" };
    }
    return { status: "applied", result: { id: matches[0].id, name: matches[0].name, agentId } };
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
        if (method === "createPurchaseOrder") {
          return await resolvePurchaseOrder(args, entry);
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
