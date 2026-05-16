import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { isSafeMode, setSafeMode } from "./safe-mode.js";
import { buildLogBundle } from "./log-bundle.js";

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

export function createStaticServer({ telegram } = {}) {
  let logsInFlight = false;

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

    if (pathname === "/api/send-logs") {
      if (request.method !== "POST") {
        response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }

      if (!telegram?.isEnabled) {
        logger.warn("http", "send_logs_not_configured");
        response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "telegram_not_configured" }));
        return;
      }

      if (logsInFlight) {
        response.writeHead(429, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "already_in_progress" }));
        return;
      }

      logsInFlight = true;
      try {
        const bundle = await buildLogBundle();
        const caption =
          `Логи V-Amber\n` +
          `Сессий: ${bundle.sessionFileCount}\n` +
          `Размер: ${bundle.compressedBytes} байт (распакованный ${bundle.uncompressedBytes})`;
        const result = await telegram.sendDocument({
          filename: bundle.filename,
          buffer: bundle.buffer,
          contentType: bundle.contentType,
          caption,
          meta: { kind: "log_bundle" },
        });
        logger.info("http", "logs_sent", {
          filename: bundle.filename,
          size: bundle.compressedBytes,
          messageId: result?.messageId ?? null,
        });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, filename: bundle.filename, size: bundle.compressedBytes }));
      } catch (error) {
        logger.error("http", "logs_send_failed", { error: error?.message || String(error) });
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "send_failed", message: error?.message || String(error) }));
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
