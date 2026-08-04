import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultFilePath = join(__dirname, "..", "logs", "moysklad-writes.jsonl");

const SCHEMA_VERSION = 1;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Журнал внешних записей в МойСклад.
//
// Зачем: раньше POST entity/customerorder был «выстрелил и забыл». Если связь
// рвалась после отправки, мы не знали, доехала бронь или нет, поэтому повтор
// был запрещён — и бронь просто терялась, а заказы восстанавливались руками
// из логов эфира (knowledge/wiki/order-recovery-from-logs.md).
//
// Журнал — append-only JSONL рядом с logs/wishlist.jsonl, по тому же принципу
// event-sourcing: пишем «начали», потом «получилось» или «не получилось», и на
// старте проигрываем файл заново. Ключ детерминированный, поэтому повторная
// попытка той же брони узнаётся по ключу, а не по догадкам.
//
// ВАЖНО про классификацию исхода: «не применилось» мы утверждаем только когда
// запрос заведомо не дошёл до МойСклада (обрыв соединения, DNS). Таймаут и 5xx
// трактуем как unknown — сервер мог успеть применить запись до того, как ответ
// потерялся. Ошибиться в эту сторону безопасно: unknown просто не даёт
// автоповтора, а неверное «не применилось» породило бы дубль заказа.

export function classifyWriteOutcome(error) {
  if (!error) return "unknown";

  const code = error.code || error.cause?.code || null;

  // Соединение не установилось — запрос гарантированно не обработан.
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"].includes(code)) {
    return "not_applied";
  }

  // Наш собственный AbortController: байты уже могли уйти на сервер.
  if (code === "MOYSKLAD_TIMEOUT") {
    return "unknown";
  }

  const httpStatus = Number(
    error.httpStatus ?? String(error.message || "").match(/MoySklad HTTP (\d{3})/)?.[1] ?? 0,
  );

  // 4xx кроме 429 — запрос дошёл и был отвергнут, записи не появилось.
  if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
    return "not_applied";
  }

  return "unknown";
}

// Ключ строится из того, что уже есть на горячем пути брони. commentId
// идентифицирует НАМЕРЕНИЕ покупателя: «ещё 2 шт» приходит отдельным
// комментарием, значит получит отдельный ключ и законно не будет
// схлопнуто дедупом. Если commentId нет (ручная бронь из баннера,
// голосовые пути) — ключа нет, и запись идёт как раньше, без дедупа.
export function buildReservationWriteKey({ activeLot, reservation } = {}) {
  const lotSessionId = activeLot?.lotSessionId;
  const viewerId = reservation?.viewerId;
  const commentId = reservation?.commentId;
  if (!lotSessionId || !viewerId || !commentId) {
    return null;
  }
  return `${lotSessionId}::${viewerId}::${commentId}`;
}

export function createWriteJournal({ filePath = defaultFilePath } = {}) {
  // key -> { status, method, result, outcome, attempts, ts }
  const entries = new Map();
  let writeChain = Promise.resolve();
  let loaded = false;

  function applyRecord(record) {
    if (!record || typeof record !== "object" || !record.key || !record.kind) return;
    const previous = entries.get(record.key) || { attempts: 0 };

    switch (record.kind) {
      case "begin":
        entries.set(record.key, {
          ...previous,
          status: "pending",
          method: record.method,
          meta: record.meta ?? previous.meta ?? null,
          attempts: (previous.attempts || 0) + 1,
          ts: record.ts,
        });
        break;
      case "done":
        entries.set(record.key, {
          ...previous,
          status: "done",
          method: record.method,
          result: record.result ?? null,
          meta: record.meta ?? previous.meta ?? null,
          outcome: record.outcome || "applied",
          ts: record.ts,
        });
        break;
      case "failed":
        entries.set(record.key, {
          ...previous,
          status: record.outcome === "not_applied" ? "not_applied" : "unknown",
          method: record.method,
          outcome: record.outcome || "unknown",
          error: record.error || null,
          ts: record.ts,
        });
        break;
      default:
        break;
    }
  }

  async function append(record) {
    const line = JSON.stringify({ v: SCHEMA_VERSION, ts: new Date().toISOString(), ...record });
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, line + "\n", "utf8");
    }).catch((error) => {
      // Журнал не должен ронять бронь: потеря строки хуже, чем потеря заказа,
      // но не настолько, чтобы отменять уже идущую запись в МойСклад.
      logger.error("write-journal", "append_failed", { error, key: record.key });
    });
    return writeChain;
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    if (!existsSync(filePath)) return;

    const stream = createReadStream(filePath, { encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    let broken = 0;
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        applyRecord(JSON.parse(trimmed));
      } catch {
        broken += 1;
      }
    }
    logger.info("write-journal", "loaded", { entries: entries.size, brokenLines: broken });
  }

  return {
    load,
    lookup(key) {
      return key ? entries.get(key) || null : null;
    },
    async begin(key, method, meta = null) {
      await append({ kind: "begin", key, method, meta });
      applyRecord({ kind: "begin", key, method, meta, ts: new Date().toISOString() });
    },
    async complete(key, method, result, meta = null, outcome = "applied") {
      await append({ kind: "done", key, method, result, meta, outcome });
      applyRecord({ kind: "done", key, method, result, meta, outcome, ts: new Date().toISOString() });
    },
    // Сколько записей журнал ПОДТВЕРДИЛ по этой паре заказ+товар. Основа
    // сверки append-пути: расхождение с фактом в МойСкладе разрешает исход
    // оборвавшейся записи. Учитываются оба пути — create тоже кладёт в заказ
    // одну позицию этого товара.
    countApplied({ orderId, productId } = {}) {
      if (!orderId || !productId) return 0;
      let count = 0;
      for (const entry of entries.values()) {
        if (entry.status !== "done") continue;
        if (entry.meta?.orderId === orderId && entry.meta?.productId === productId) {
          count += 1;
        }
      }
      return count;
    },
    async fail(key, method, error) {
      const outcome = classifyWriteOutcome(error);
      const message = error instanceof Error ? error.message : String(error);
      await append({ kind: "failed", key, method, outcome, error: message });
      applyRecord({ kind: "failed", key, method, outcome, error: message, ts: new Date().toISOString() });
      return outcome;
    },
    stats() {
      const counts = { pending: 0, done: 0, unknown: 0, not_applied: 0 };
      for (const entry of entries.values()) {
        if (entry.status in counts) counts[entry.status] += 1;
      }
      return { total: entries.size, ...counts };
    },
  };
}

// Декоратор поверх клиента МойСклад — форма намеренно повторяет
// wrapWithSafeMode из safe-mode.js. Порядок обёрток задаётся в index.js:
// safe-mode должен быть СНАРУЖИ, чтобы заблокированная запись не оставляла
// следа в журнале.
export function wrapWithWriteJournal(client, journal, keyBuilders, options = {}) {
  const {
    domain = "moysklad",
    metaBuilders = {},
    reconciler = null,
    retryAttempts = 2,
    retryBaseDelayMs = 400,
  } = options;

  const maxAttempts = Math.max(1, Number(retryAttempts) || 1);
  const baseDelayMs = Math.max(0, Number(retryBaseDelayMs) || 0);
  const wrapped = { ...client };

  for (const [method, buildKey] of Object.entries(keyBuilders)) {
    const original = client[method];
    if (typeof original !== "function") continue;

    // bind сохраняет this: методы клиента зовут this.ensureCounterparty и
    // this.resolveFirstOrderPositionId.
    const bound = original.bind(client);
    const buildMeta = metaBuilders[method] || null;

    wrapped[method] = async (...args) => {
      const key = buildKey(...args);
      if (!key) {
        return bound(...args);
      }

      const known = journal.lookup(key);

      // Главная защита: та же бронь уже успешно уехала. Повтор (реконнект,
      // дубль комментария, ретрай оператора) возвращает прежний результат
      // вместо второго заказа в МойСкладе.
      if (known?.status === "done") {
        logger.warn(domain, "write_deduplicated", { method, key, result: known.result });
        return known.result;
      }

      const beginMeta = buildMeta ? buildMeta(...args) : null;
      await journal.begin(key, method, beginMeta);

      // orderId create-пути известен только ПОСЛЕ успеха — достаём из ответа,
      // иначе countApplied не увидит позицию, созданную вместе с заказом.
      const completeMeta = (result) => ({
        ...(beginMeta || {}),
        orderId: beginMeta?.orderId || result?.id || result?.orderId || null,
      });

      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const result = await bound(...args);
          await journal.complete(key, method, result ?? null, completeMeta(result));
          return result;
        } catch (error) {
          lastError = error;
          let outcome = classifyWriteOutcome(error);

          // Исход неизвестен: запрос мог быть применён до потери ответа.
          // Повторять вслепую нельзя — сначала спрашиваем МойСклад.
          if (outcome === "unknown" && reconciler) {
            // Методы записи принимают один объект-аргумент — сверке нужен он,
            // а не массив аргументов обёртки.
            const verdict = await reconciler.resolve({ method, args: args[0], key });
            logger.warn(domain, "write_reconciled", {
              method,
              key,
              attempt,
              verdict: verdict.status,
              reason: verdict.reason || null,
            });

            if (verdict.status === "applied") {
              await journal.complete(key, method, verdict.result ?? null, completeMeta(verdict.result), "applied_reconciled");
              return verdict.result;
            }
            if (verdict.status === "not_applied") {
              outcome = "not_applied";
            }
          }

          // Повторяем только когда точно знаем, что записи не появилось.
          if (outcome === "not_applied" && attempt < maxAttempts) {
            logger.warn(domain, "write_retry_scheduled", { method, key, attempt, nextAttempt: attempt + 1 });
            if (baseDelayMs > 0) {
              await delay(baseDelayMs * 2 ** (attempt - 1));
            }
            continue;
          }

          await journal.fail(key, method, error);
          logger.error(domain, "write_failed", { method, key, attempt, outcome, error });
          throw error;
        }
      }

      throw lastError;
    };
  }

  return wrapped;
}
