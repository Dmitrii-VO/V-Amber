import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logPath = join(__dirname, "..", "logs", "reservation-digest-sends.jsonl");

export function createReservationDigestLog(path = logPath) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    const entries = new Map();
    const sentByDateViewer = new Set();
    try {
      const text = await readFile(path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry?.key) entries.set(entry.key, entry);
          if (entry?.date && entry?.viewerId) {
            sentByDateViewer.add(`${entry.date}:${entry.viewerId}`);
          }
        } catch {
          // Ignore a malformed historical line; append-only log should remain usable.
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    cache = { entries, sentByDateViewer };
    return cache;
  }

  return {
    path,
    async has(key) {
      const { entries } = await load();
      return entries.has(key);
    },
    async get(key) {
      const { entries } = await load();
      return entries.get(key) || null;
    },
    async hasAnyFor(date, viewerId) {
      const { sentByDateViewer } = await load();
      return sentByDateViewer.has(`${date}:${viewerId}`);
    },
    async record(entry) {
      if (!entry?.key) {
        throw new Error("reservation digest log entry requires key");
      }
      await mkdir(dirname(path), { recursive: true });
      const normalized = {
        ...entry,
        sentAt: entry.sentAt || new Date().toISOString(),
      };
      await appendFile(path, `${JSON.stringify(normalized)}\n`, "utf8");
      const { entries, sentByDateViewer } = await load();
      entries.set(normalized.key, normalized);
      if (normalized.date && normalized.viewerId) {
        sentByDateViewer.add(`${normalized.date}:${normalized.viewerId}`);
      }
      return normalized;
    },
  };
}
