import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logsDir = join(__dirname, "..", "logs");
const sessionsDir = join(logsDir, "sessions");
const serverLogPath = join(logsDir, "server.log");

const MAX_BUNDLE_BYTES = 40 * 1024 * 1024;
const MAX_SERVER_LOG_BYTES = 25 * 1024 * 1024;

async function readTail(filePath, maxBytes) {
  const stats = await stat(filePath);
  if (stats.size <= maxBytes) {
    return await readFile(filePath, "utf8");
  }
  const { open } = await import("node:fs/promises");
  const handle = await open(filePath, "r");
  try {
    const start = stats.size - maxBytes;
    const buffer = Buffer.alloc(maxBytes);
    await handle.read(buffer, 0, maxBytes, start);
    const text = buffer.toString("utf8");
    const newlineAt = text.indexOf("\n");
    return newlineAt >= 0 ? text.slice(newlineAt + 1) : text;
  } finally {
    await handle.close();
  }
}

async function listSessionFiles() {
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    const mdFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
    const withStats = await Promise.all(
      mdFiles.map(async (entry) => {
        const fullPath = join(sessionsDir, entry.name);
        const stats = await stat(fullPath);
        return { name: entry.name, fullPath, mtimeMs: stats.mtimeMs };
      }),
    );
    return withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    logger.warn("log-bundle", "sessions_listing_failed", { error: error?.message || String(error) });
    return [];
  }
}

function separator(title) {
  return `\n\n===== ${title} =====\n`;
}

export async function buildLogBundle() {
  const parts = [];
  let totalBytes = 0;

  parts.push(`V-Amber log bundle\nGenerated: ${new Date().toISOString()}\n`);

  try {
    const serverLogText = await readTail(serverLogPath, MAX_SERVER_LOG_BYTES);
    parts.push(separator(`server.log (tail ${serverLogText.length} bytes)`));
    parts.push(serverLogText);
    totalBytes += serverLogText.length;
  } catch (error) {
    parts.push(separator("server.log"));
    parts.push(`<unable to read: ${error?.message || String(error)}>`);
  }

  const sessionFiles = await listSessionFiles();
  for (const file of sessionFiles) {
    if (totalBytes >= MAX_BUNDLE_BYTES) {
      parts.push(separator("truncated"));
      parts.push(`<bundle reached ${MAX_BUNDLE_BYTES} byte cap; remaining session files skipped>`);
      break;
    }
    try {
      const raw = await readFile(file.fullPath, "utf8");
      parts.push(separator(`sessions/${file.name}`));
      parts.push(raw);
      totalBytes += raw.length;
    } catch (error) {
      parts.push(separator(`sessions/${file.name}`));
      parts.push(`<unable to read: ${error?.message || String(error)}>`);
    }
  }

  const text = parts.join("");
  const gz = gzipSync(Buffer.from(text, "utf8"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  return {
    filename: `v-amber-logs-${stamp}.txt.gz`,
    buffer: gz,
    contentType: "application/gzip",
    uncompressedBytes: text.length,
    compressedBytes: gz.length,
    sessionFileCount: sessionFiles.length,
  };
}
