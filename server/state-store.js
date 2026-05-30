import { writeFile, readFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stateFilePath = join(__dirname, "..", "logs", "active-state.json");
const tmpFilePath = `${stateFilePath}.tmp`;

// Sets и Map'ы в JSON по умолчанию сериализуются как {}, поэтому конвертируем
// их в массивы вручную перед записью, а на чтении восстанавливаем обратно.
function serializeReservations(reservations) {
  if (!reservations) {
    return null;
  }
  return {
    lastCommentId: reservations.lastCommentId || 0,
    committedReservationCount: reservations.committedReservationCount || 0,
    primaryReservation: reservations.primaryReservation || null,
    seenCommentIds: reservations.seenCommentIds instanceof Set
      ? [...reservations.seenCommentIds]
      : Array.isArray(reservations.seenCommentIds) ? reservations.seenCommentIds : [],
    acceptedUserIds: reservations.acceptedUserIds instanceof Set
      ? [...reservations.acceptedUserIds]
      : Array.isArray(reservations.acceptedUserIds) ? reservations.acceptedUserIds : [],
    events: Array.isArray(reservations.events) ? reservations.events : [],
  };
}

function serializeLot(lot) {
  if (!lot) {
    return null;
  }
  return {
    ...lot,
    reservations: serializeReservations(lot.reservations),
  };
}

let writeChain = Promise.resolve();
let pendingPayload = null;
let writeInFlight = false;
// Защёлкивается во время clearActiveState. Пока true — saveActiveState
// игнорирует входящие snapshot'ы, а уже запущенный flushPending в финале
// удаляет файл, если он только что был успешно записан. Это закрывает гонку:
// rename → unlink → файл остаётся со стейлой записью.
let discardSaves = false;

async function flushPending() {
  if (writeInFlight || !pendingPayload) {
    return;
  }
  writeInFlight = true;
  const payload = pendingPayload;
  pendingPayload = null;
  try {
    await mkdir(dirname(stateFilePath), { recursive: true });
    // Атомарная запись через .tmp + rename: если процесс упадёт прямо во
    // время записи, на диске останется ЛИБО старая консистентная версия,
    // ЛИБО новая. Не «полусломанная» промежуточная.
    await writeFile(tmpFilePath, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmpFilePath, stateFilePath);
    // Race recovery: если clearActiveState проскочил между нашим write и
    // rename, у нас на диске только что появился stale-снимок. Удаляем.
    if (discardSaves) {
      try { await unlink(stateFilePath); } catch { /* ignore */ }
    }
  } catch (error) {
    logger.warn("state-store", "save_failed", { error });
  } finally {
    writeInFlight = false;
    if (pendingPayload && !discardSaves) {
      // Пока писали — пришёл новый snapshot. Сбрасываем его следом.
      void flushPending();
    }
  }
}

export function saveActiveState({ activeLot, openLots = null, sessionFilePath, connectionId } = {}) {
  const serializedOpenLots = Array.isArray(openLots)
    ? openLots.map(serializeLot).filter(Boolean)
    : [];
  if (!activeLot && serializedOpenLots.length === 0) {
    // Нечего сохранять — но и не очищаем здесь. Очистка только через clearActiveState.
    return;
  }
  if (discardSaves) {
    // Сессия завершена / очищена — игнорируем хвостовые save'ы из эмиттера.
    return;
  }
  pendingPayload = {
    savedAt: new Date().toISOString(),
    connectionId: connectionId || null,
    sessionFilePath: sessionFilePath || null,
    activeLot: serializeLot(activeLot),
    openLots: serializedOpenLots,
  };
  writeChain = writeChain.then(flushPending);
}

export async function loadActiveState() {
  try {
    const raw = await readFile(stateFilePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    logger.warn("state-store", "load_failed", { error });
    return null;
  }
}

export async function clearActiveState() {
  // 1) Прервать поток save'ов и сбросить буфер: новые saveActiveState
  //    короткозамкнут на discardSaves, in-flight flushPending в конце сам
  //    удалит файл, если успел его создать после нашего unlink.
  discardSaves = true;
  pendingPayload = null;
  // 2) Дождаться текущего write'а, иначе unlink/rename могут перекрестно
  //    оставить stale-файл. writeChain накапливает все flushPending'и.
  try {
    await writeChain;
  } catch (error) {
    // Сам flushPending логирует "save_failed"; здесь повторно не шумим,
    // но debug-строкой фиксируем, что clear отработал поверх упавшего save.
    logger.debug("state-store", "clear_after_failed_write", {
      error: error?.message || String(error),
    });
  }
  // 3) Удалить state-файл и временный, если есть.
  try {
    await unlink(stateFilePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logger.warn("state-store", "clear_failed", { error });
    }
  }
  try {
    await unlink(tmpFilePath);
  } catch {
    /* ignore */
  }
  // 4) Снимаем защёлку — следующая сессия может писать заново.
  discardSaves = false;
}

// Извлекает «брошенные» брони из загруженного state. Набор статусов ШИРЕ,
// чем у flushOrphanWaitlist в ws-server.js — намеренно.
//
//   flushOrphanWaitlist (in-process) фильтрует только waitlist_pending +
//   pending_reservation. Статус creating_order не включается, потому что в
//   обычном close-flow эти события ещё разрешаются внутри try/finally
//   processReservationEvent (станут reserved или order_failed).
//
//   extractOrphans (crash recovery) дополнительно включает creating_order:
//   процесс умер прямо во время записи в МойСклад — неизвестно, успел ли
//   заказ создаться. Оператор обязан проверить вручную.
export function extractOrphans(state) {
  // order_failed добавлен для согласованности с close-flow: зритель товар
  // не получил, спрос есть, нужно мигрировать в wish list (с trigger:"order_failed").
  // creating_order остаётся — крэш мог произойти прямо во время записи в МС.
  const ORPHAN_STATUSES = new Set([
    "waitlist_pending",
    "pending_reservation",
    "creating_order",
    "order_failed",
  ]);
  const lots = Array.isArray(state?.openLots) && state.openLots.length > 0
    ? state.openLots
    : [state?.activeLot].filter(Boolean);
  return lots.flatMap((lot) => {
    const events = lot?.reservations?.events;
    if (!Array.isArray(events) || events.length === 0) {
      return [];
    }
    return events
      .filter((entry) => ORPHAN_STATUSES.has(entry?.status))
      .map((entry) => ({ ...entry, lotCode: entry.lotCode || lot.code, lotSessionId: lot.lotSessionId }));
  });
}
