import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultFilePath = join(__dirname, "..", "logs", "moysklad-writes.jsonl");

const SCHEMA_VERSION = 1;

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
          outcome: "applied",
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
    async begin(key, method) {
      await append({ kind: "begin", key, method });
      applyRecord({ kind: "begin", key, method, ts: new Date().toISOString() });
    },
    async complete(key, method, result) {
      await append({ kind: "done", key, method, result });
      applyRecord({ kind: "done", key, method, result, ts: new Date().toISOString() });
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
export function wrapWithWriteJournal(client, journal, keyBuilders, domain = "moysklad") {
  const wrapped = { ...client };

  for (const [method, buildKey] of Object.entries(keyBuilders)) {
    const original = client[method];
    if (typeof original !== "function") continue;

    // bind сохраняет this: методы клиента зовут this.ensureCounterparty и
    // this.resolveFirstOrderPositionId.
    const bound = original.bind(client);

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

      // Прошлая попытка оборвалась, и мы не знаем её исход. Сверку с МойСкладом
      // делает следующий шаг работы; пока — громкий след в логе и в диагностике,
      // чтобы этот случай был виден при разборе эфира, а не терялся молча.
      if (known?.status === "pending" || known?.status === "unknown") {
        logger.warn(domain, "write_outcome_unknown", {
          method,
          key,
          previousStatus: known.status,
          attempts: known.attempts || 0,
        });
      }

      await journal.begin(key, method);
      try {
        const result = await bound(...args);
        await journal.complete(key, method, result ?? null);
        return result;
      } catch (error) {
        const outcome = await journal.fail(key, method, error);
        logger.error(domain, "write_failed", { method, key, outcome, error });
        throw error;
      }
    };
  }

  return wrapped;
}
