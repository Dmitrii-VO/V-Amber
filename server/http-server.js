import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { isSafeMode, setSafeMode } from "./safe-mode.js";
import { buildLogBundle, listBundleFiles } from "./log-bundle.js";

const SEND_LOGS_COOLDOWN_MS = 60000;
const SEND_LOGS_MAX_BODY = 16 * 1024;

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const webRoot = normalize(join(__dirname, "..", "web-ui"));
const webRootPrefix = `${webRoot}${sep}`;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function resolveAssetPath(urlPathname) {
  const relativePath = urlPathname === "/" ? "/index.html" : urlPathname;
  const resolvedPath = normalize(join(webRoot, relativePath));

  if (resolvedPath !== webRoot && !resolvedPath.startsWith(webRootPrefix)) {
    return null;
  }

  return resolvedPath;
}

function readJsonBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        request.destroy();
        reject(new Error("body_too_large"));
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

export function createStaticServer({ telegram, vk, config } = {}) {
  let logsInFlight = false;
  let lastSendAt = 0;

  return createServer(async (request, response) => {
    if (!request.url) {
      response.writeHead(400).end("Bad request");
      return;
    }

    let pathname;

    try {
      ({ pathname } = new URL(request.url, "http://localhost"));
    } catch {
      logger.warn("http", "bad_request_url", { url: request.url });
      response.writeHead(400).end("Bad request");
      return;
    }

    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/api/vk/validate-url") {
      if (request.method !== "GET") {
        response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET" });
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      const { searchParams } = new URL(request.url, "http://localhost");
      const url = searchParams.get("url") || "";
      try {
        const result = vk?.validateLiveVideoUrl
          ? await vk.validateLiveVideoUrl(url)
          : { ok: false, code: "vk_disabled", message: "VK integration unavailable" };
        jsonResponse(response, 200, result);
      } catch (error) {
        logger.error("http", "vk_validate_failed", { error: error?.message || String(error) });
        jsonResponse(response, 500, { ok: false, code: "internal_error", message: error?.message || String(error) });
      }
      return;
    }

    if (pathname === "/api/send-logs/preview") {
      if (request.method !== "GET") {
        response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET" });
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      try {
        const files = await listBundleFiles();
        const totalBytes = files.reduce((acc, f) => acc + f.bytes, 0);
        const cooldownMs = Math.max(0, SEND_LOGS_COOLDOWN_MS - (Date.now() - lastSendAt));
        jsonResponse(response, 200, {
          files,
          totalBytes,
          telegramConfigured: Boolean(telegram?.isEnabled),
          cooldownMs,
        });
      } catch (error) {
        logger.error("http", "logs_preview_failed", { error: error?.message || String(error) });
        jsonResponse(response, 500, { error: "preview_failed" });
      }
      return;
    }

    if (pathname === "/api/send-logs") {
      if (request.method !== "POST") {
        response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }

      let body;
      try {
        body = await readJsonBody(request, SEND_LOGS_MAX_BODY);
      } catch (error) {
        jsonResponse(response, 400, { error: error.message || "bad_request" });
        return;
      }

      const downloadOnly = Boolean(body?.download);
      const userNote = typeof body?.userNote === "string" ? body.userNote : "";

      if (logsInFlight) {
        jsonResponse(response, 429, { error: "already_in_progress" });
        return;
      }

      if (!downloadOnly) {
        if (!telegram?.isEnabled) {
          logger.warn("http", "send_logs_not_configured");
          jsonResponse(response, 503, { error: "telegram_not_configured" });
          return;
        }
        const elapsed = Date.now() - lastSendAt;
        if (elapsed < SEND_LOGS_COOLDOWN_MS) {
          jsonResponse(response, 429, {
            error: "rate_limited",
            retryAfterMs: SEND_LOGS_COOLDOWN_MS - elapsed,
          });
          return;
        }
      }

      logsInFlight = true;
      try {
        const bundle = await buildLogBundle({ userNote, config });

        if (downloadOnly) {
          const buffer = bundle.parts.length === 1
            ? bundle.parts[0].buffer
            : Buffer.concat(bundle.parts.map((p) => p.buffer));
          response.writeHead(200, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${bundle.singleFilename}"`,
            "content-length": buffer.length,
          });
          response.end(buffer);
          logger.info("http", "logs_downloaded", { filename: bundle.singleFilename, size: buffer.length });
          return;
        }

        const baseCaption =
          `Логи V-Amber\n` +
          `Файлов: ${bundle.fileCount}\n` +
          `Размер: ${bundle.totalBytes} байт\n` +
          `Install: ${bundle.manifest.installId}\n` +
          `Версия: ${bundle.manifest.vamberVersion}` +
          (userNote ? `\n\nЗаметка оператора:\n${userNote}` : "");

        const sentParts = [];
        for (const part of bundle.parts) {
          const caption = bundle.parts.length === 1
            ? baseCaption
            : `${baseCaption}\n\nЧасть ${part.partNumber} из ${part.partTotal}`;
          const result = await telegram.sendDocument({
            filename: part.filename,
            buffer: part.buffer,
            contentType: "application/zip",
            caption,
            meta: { kind: "log_bundle", part: part.partNumber, total: part.partTotal },
          });
          sentParts.push({ filename: part.filename, size: part.buffer.length, messageId: result?.messageId ?? null });
        }
        lastSendAt = Date.now();
        logger.info("http", "logs_sent", {
          totalBytes: bundle.totalBytes,
          fileCount: bundle.fileCount,
          parts: sentParts,
        });
        jsonResponse(response, 200, { ok: true, parts: sentParts, totalBytes: bundle.totalBytes });
      } catch (error) {
        logger.error("http", "logs_send_failed", { error: error?.message || String(error) });
        jsonResponse(response, 500, { error: "send_failed", message: error?.message || String(error) });
      } finally {
        logsInFlight = false;
      }
      return;
    }

    if (pathname === "/api/safe-mode") {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ safeMode: isSafeMode() }));
        return;
      }

      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1024) {
            request.destroy();
          }
        });
        request.on("end", () => {
          let enabled;
          try {
            ({ enabled } = JSON.parse(body || "{}"));
          } catch {
            response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ error: "invalid_json" }));
            return;
          }

          const changed = setSafeMode(enabled, { source: "http" });
          logger.info("http", "safe_mode_request", { enabled: Boolean(enabled), changed });
          response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ safeMode: isSafeMode(), changed }));
        });
        return;
      }

      response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET, POST" });
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    const assetPath = resolveAssetPath(pathname);

    if (!assetPath) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    try {
      const assetStats = await stat(assetPath);

      if (!assetStats.isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }

      response.writeHead(200, {
        "content-type": MIME_TYPES[extname(assetPath)] || "application/octet-stream",
        "cache-control": "no-store",
      });

      const stream = createReadStream(assetPath);
      stream.on("error", (error) => {
        logger.error("http", "asset_stream_failed", { assetPath, error });
        if (!response.headersSent) {
          response.writeHead(500).end("Read error");
          return;
        }

        response.destroy();
      });
      stream.pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
}
