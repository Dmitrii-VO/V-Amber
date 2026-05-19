import { readFile, readdir, stat } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { getInstallId } from "./install-id.js";
import { buildZip } from "./zip-writer.js";
import { generateIndexMd, generateMetaJson } from "./bundle-index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logsDir = join(__dirname, "..", "logs");
const sessionsDir = join(logsDir, "sessions");
const serverLogPath = join(logsDir, "server.log");
const wishlistJsonlPath = join(logsDir, "wishlist.jsonl");
const wishlistSubmissionsPath = join(logsDir, "wishlist-submissions.json");
const settingsPath = join(logsDir, "settings.json");
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

  // server.log + rotated
  const main = await readMaybe(serverLogPath);
  if (main) files.push({ archiveName: "server.log", ...main });

  for (let i = 1; i <= logger.rotateKeep; i += 1) {
    const rotated = await readMaybe(logger.rotatedPath(i));
    if (rotated) files.push({ archiveName: `server.log.${i}`, ...rotated });
  }

  // sessions/*.md и sessions/*.jsonl (отсортированы по mtime, новые впереди)
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    const sessionFiles = entries.filter((entry) =>
      entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".jsonl"))
    );
    const withStats = await Promise.all(
      sessionFiles.map(async (entry) => {
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

  // wishlist.jsonl → wishlist/events.jsonl (полный event log)
  const wishlistEvents = await readMaybe(wishlistJsonlPath);
  if (wishlistEvents) {
    files.push({ archiveName: "wishlist/events.jsonl", ...wishlistEvents });
  }

  // wishlist-submissions.json → wishlist/submissions.json
  const submissionsFile = await readMaybe(wishlistSubmissionsPath);
  if (submissionsFile) {
    files.push({ archiveName: "wishlist/submissions.json", ...submissionsFile });
  }

  // settings.json (целиком; в нём нет секретов — supplier/store IDs и шаблон).
  const settingsFile = await readMaybe(settingsPath);
  if (settingsFile) {
    files.push({ archiveName: "settings.json", ...settingsFile });
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
    vk: Boolean(config?.vk?.userToken),
    moysklad: Boolean(config?.moysklad?.login && config.moysklad?.password),
    speechkit: Boolean(config?.speechkit?.apiKey),
  };
}

export async function buildLogBundle({
  userNote = "",
  config,
  wishlistStore = null,
  wishlistSubmissions = null,
  settingsStore = null,
} = {}) {
  const files = await collectLogFiles();
  const [installId, version] = await Promise.all([getInstallId(), readPackageVersion()]);

  // Снапшот wishlist-store в виде state.json. Полный jsonl лежит как events,
  // но state.json быстрее парсить и не требует replay.
  let wishlistStateSnapshot = { active: [], archive: [] };
  if (wishlistStore) {
    wishlistStateSnapshot = {
      active: wishlistStore.listActive(),
      archive: wishlistStore.listArchive(),
    };
    files.push({
      archiveName: "wishlist/state.json",
      buffer: Buffer.from(JSON.stringify(wishlistStateSnapshot, null, 2), "utf8"),
      truncated: false,
      originalSize: 0,
    });
  }

  // Собираем session jsonl содержимое для INDEX.md.
  const sessionsForIndex = files
    .filter((f) => f.archiveName.startsWith("sessions/") && f.archiveName.endsWith(".jsonl"))
    .map((f) => ({ name: f.archiveName, content: f.buffer.toString("utf8") }));

  // Submissions для INDEX (raw object).
  let submissionsRaw = null;
  if (wishlistSubmissions?.listAll) {
    submissionsRaw = { drafts: wishlistSubmissions.listAll() };
  } else {
    const submissionsFile = files.find((f) => f.archiveName === "wishlist/submissions.json");
    if (submissionsFile) {
      try { submissionsRaw = JSON.parse(submissionsFile.buffer.toString("utf8")); }
      catch { /* invalid — skip */ }
    }
  }

  // Settings для INDEX.
  let settings = null;
  if (settingsStore?.get) {
    settings = settingsStore.get();
  } else {
    const sf = files.find((f) => f.archiveName === "settings.json");
    if (sf) {
      try { settings = JSON.parse(sf.buffer.toString("utf8")); }
      catch { /* skip */ }
    }
  }

  // Содержимое wishlist/events.jsonl как authoritative источник инцидентов.
  const wishlistEventsFile = files.find((f) => f.archiveName === "wishlist/events.jsonl");
  const wishlistEventsContent = wishlistEventsFile ? wishlistEventsFile.buffer.toString("utf8") : null;

  // Генерируем INDEX.md и meta.json.
  const generatedAt = new Date().toISOString();
  const indexMd = generateIndexMd({
    sessions: sessionsForIndex,
    wishlistEventsContent,
    wishlistSnapshot: wishlistStateSnapshot,
    submissions: submissionsRaw,
    settings,
    packageVersion: version,
    generatedAt,
  });
  const metaJson = generateMetaJson({
    packageVersion: version,
    config,
    files,
    generatedAt,
  });

  const manifest = {
    installId,
    vamberVersion: version,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    osRelease: release(),
    generatedAt,
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
    { name: "INDEX.md", content: indexMd },
    { name: "meta.json", content: JSON.stringify(metaJson, null, 2) },
    { name: "manifest.json", content: JSON.stringify(manifest, null, 2) },
    ...files.map((f) => ({ name: f.archiveName, content: f.buffer })),
  ];

  const zipBuffer = buildZip(entries);
  const stamp = generatedAt.replace(/[:.]/g, "-");

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
    fileCount: entries.length,
    manifest,
    singleFilename: `v-amber-logs-${stamp}.zip`,
  };
}
