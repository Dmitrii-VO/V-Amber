// Общая машинерия append-only JSONL-хранилищ.
//
// Три стора пишут историю строками и на старте сворачивают её к текущему
// состоянию: wishlist-store.js, name-cache-store.js, blocked-viewers-store.js.
// Цикл чтения был скопирован в каждый слово в слово — включая обработку
// битой строки и то, что отсутствующий файл это не ошибка, а пустая история.
// Здесь единственный источник: правка разбора чинит все три сразу.
//
// Свёртку записи в состояние (applyRecord) стор оставляет себе — она у всех
// разная и есть вся суть каждого из них.

import { appendFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

import { logger } from "./logger.js";

// Дописывает одну или несколько строк. Несколько — одним вызовом appendFile:
// wishlist пишет событие и его последствия вместе, и половина пачки на диске
// была бы неконсистентной историей.
export async function appendJsonlLines(filePath, records) {
  const lines = (Array.isArray(records) ? records : [records])
    .filter((record) => record != null)
    .map((record) => (typeof record === "string" ? record : JSON.stringify(record)));
  if (!lines.length) return;
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, lines.join("\n") + "\n", "utf8");
}

// Читает историю построчно и отдаёт каждую запись в applyRecord.
//
// Битая строка — WARN и продолжаем: одна оборванная запись (процесс убили на
// середине append) не должна стоить оператору всей истории броней. Отсутствие
// файла — это первый запуск, а не ошибка.
export async function readJsonlRecords(filePath, component, applyRecord) {
  if (!existsSync(filePath)) return;
  try {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        applyRecord(JSON.parse(trimmed));
      } catch (err) {
        logger.warn(component, "skip_bad_line", { error: err?.message || String(err) });
      }
    }
  } catch (error) {
    logger.warn(component, "load_failed", { error });
  }
}
