import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SENSITIVE_KEY_RE = /authorization|password|token|secret|api[_-]?key/i;

function sanitize(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = sanitize(val, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function createSessionJsonl({ filePath }) {
  if (!filePath) {
    throw new Error("session-jsonl: filePath is required");
  }

  let writeChain = Promise.resolve();
  let initialised = false;

  async function ensureDir() {
    if (initialised) return;
    initialised = true;
    await mkdir(dirname(filePath), { recursive: true });
  }

  return {
    getFilePath() {
      return filePath;
    },
    writeEvent(kind, payload = {}) {
      if (!kind) return;
      const record = {
        ts: new Date().toISOString(),
        v: 1,
        kind: String(kind),
        ...sanitize(payload),
      };
      const line = JSON.stringify(record) + "\n";

      writeChain = writeChain
        .then(ensureDir)
        .then(() => appendFile(filePath, line, "utf8"))
        .catch((err) => {
          console.error(`session_jsonl_write_failed ${err instanceof Error ? err.message : String(err)}`);
        });
    },
    async flush() {
      try { await writeChain; } catch { /* swallowed */ }
    },
  };
}
