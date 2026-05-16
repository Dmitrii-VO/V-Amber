import { readFile, readdir, stat } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { getInstallId } from "./install-id.js";
import { buildZip } from "./zip-writer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logsDir = join(__dirname, "..", "logs");
const sessionsDir = join(logsDir, "sessions");
const serverLogPath = join(logsDir, "server.log");
const pkgPath = join(__dirname, "..", "package.json");

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PART_SIZE = 40 * 1024 * 1024;

async function readPackageVersion() {
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

async function readMaybe(filePath) {
  try {
    const stats = await stat(filePath);
    if (stats.size > MAX_FILE_BYTES) {
      const { open } = await import("node:fs/promises");
      const handle = await open(filePath, "r");
      try {
        const start = stats.size - MAX_FILE_BYTES;
        const buffer = Buffer.alloc(MAX_FILE_BYTES);
        await handle.read(buffer, 0, MAX_FILE_BYTES, start);
        const newlineAt = buffer.indexOf(0x0a);
        return {
          name: filePath,
          buffer: newlineAt >= 0 ? buffer.slice(newlineAt + 1) : buffer,
          truncated: true,
          originalSize: stats.size,
        };
      } finally {
        await handle.close();
      }
    }
    return {
      name: filePath,
      buffer: await readFile(filePath),
      truncated: false,
      originalSize: stats.size,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    logger.warn("log-bundle", "read_failed", { filePath, error: error?.message || String(error) });
    return null;
  }
}

async function collectLogFiles() {
  const files = [];

  const main = await readMaybe(serverLogPath);
  if (main) files.push({ archiveName: "server.log", ...main });

  for (let i = 1; i <= logger.rotateKeep; i += 1) {
    const rotated = await readMaybe(logger.rotatedPath(i));
    if (rotated) files.push({ archiveName: `server.log.${i}`, ...rotated });
  }

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
    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of withStats) {
      const data = await readMaybe(entry.fullPath);
      if (data) files.push({ archiveName: `sessions/${entry.name}`, ...data });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logger.warn("log-bundle", "sessions_listing_failed", { error: error?.message || String(error) });
    }
  }

  return files;
}

export async function listBundleFiles() {
  const files = await collectLogFiles();
  return files.map((f) => ({
    name: f.archiveName,
    bytes: f.buffer.length,
    originalBytes: f.originalSize,
    truncated: f.truncated,
  }));
}

function activeIntegrationFlags(config) {
  return {
    telegram: Boolean(config?.telegram?.botToken && (config.telegram.primaryChatId || config.telegram.chatIds?.length)),
    vk: Boolean(config?.vk?.token),
    moysklad: Boolean(config?.moysklad?.login && config.moysklad?.password),
    yandexgpt: Boolean(config?.articleExtraction?.yandexgpt?.apiKey),
    speechkit: Boolean(config?.speechkit?.apiKey),
  };
}

export async function buildLogBundle({ userNote = "", config } = {}) {
  const files = await collectLogFiles();
  const [installId, version] = await Promise.all([getInstallId(), readPackageVersion()]);

  const manifest = {
    installId,
    vamberVersion: version,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    osRelease: release(),
    generatedAt: new Date().toISOString(),
    userNote: typeof userNote === "string" ? userNote.slice(0, 4000) : "",
    integrations: activeIntegrationFlags(config),
    files: files.map((f) => ({
      name: f.archiveName,
      bytes: f.buffer.length,
      originalBytes: f.originalSize,
      truncated: f.truncated,
    })),
  };

  const entries = [
    { name: "manifest.json", content: JSON.stringify(manifest, null, 2) },
    ...files.map((f) => ({ name: f.archiveName, content: f.buffer })),
  ];

  const zipBuffer = buildZip(entries);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const parts = [];
  if (zipBuffer.length <= PART_SIZE) {
    parts.push({
      filename: `v-amber-logs-${stamp}.zip`,
      buffer: zipBuffer,
      partNumber: 1,
      partTotal: 1,
    });
  } else {
    const total = Math.ceil(zipBuffer.length / PART_SIZE);
    for (let i = 0; i < total; i += 1) {
      const start = i * PART_SIZE;
      const end = Math.min(start + PART_SIZE, zipBuffer.length);
      parts.push({
        filename: `v-amber-logs-${stamp}.part-${i + 1}-of-${total}.zip`,
        buffer: zipBuffer.subarray(start, end),
        partNumber: i + 1,
        partTotal: total,
      });
    }
  }

  return {
    parts,
    totalBytes: zipBuffer.length,
    fileCount: files.length,
    manifest,
    singleFilename: `v-amber-logs-${stamp}.zip`,
  };
}
