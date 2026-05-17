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
  } catch (error) {
    logger.warn("state-store", "save_failed", { error });
  } finally {
    writeInFlight = false;
    if (pendingPayload) {
      // Пока писали — пришёл новый snapshot. Сбрасываем его следом.
      void flushPending();
    }
  }
}

export function saveActiveState({ activeLot, sessionFilePath, connectionId } = {}) {
  if (!activeLot) {
    // Нечего сохранять — но и не очищаем здесь. Очистка только через clearActiveState.
    return;
  }
  pendingPayload = {
    savedAt: new Date().toISOString(),
    connectionId: connectionId || null,
    sessionFilePath: sessionFilePath || null,
    activeLot: serializeLot(activeLot),
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
  pendingPayload = null;
  try {
    await unlink(stateFilePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logger.warn("state-store", "clear_failed", { error });
    }
  }
  // На всякий случай чистим .tmp, если осталась от падения.
  try {
    await unlink(tmpFilePath);
  } catch {
    /* ignore */
  }
}

// Извлекает «брошенные» брони из загруженного state — те же статусы, что
// flushOrphanWaitlist в ws-server.js. Дублирование намеренное: state-store
// не должен знать о ws-server internals, но статусы должны совпадать.
export function extractOrphans(state) {
  const events = state?.activeLot?.reservations?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }
  const ORPHAN_STATUSES = new Set(["waitlist_pending", "pending_reservation", "creating_order"]);
  return events.filter((entry) => ORPHAN_STATUSES.has(entry?.status));
}
