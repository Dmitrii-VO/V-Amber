import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { isSafeMode, setSafeMode } from "./safe-mode.js";
import { buildLogBundle, listBundleFiles } from "./log-bundle.js";

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

export function createStaticServer({ vk, moysklad, productCodeCache, config } = {}) {
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

    if (pathname === "/api/product-codes/status") {
      if (request.method !== "GET") {
        response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET" });
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      jsonResponse(response, 200, productCodeCache?.getSnapshot?.() || { count: 0, loadedAt: null, refreshing: false });
      return;
    }

    if (pathname === "/api/product-codes/refresh") {
      if (request.method !== "POST") {
        response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
        response.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      try {
        const result = productCodeCache?.refresh
          ? await productCodeCache.refresh(moysklad)
          : { count: 0, loadedAt: null, refreshing: false, lastError: "product_code_cache_unavailable" };
        jsonResponse(response, 200, { ok: true, ...result });
      } catch (error) {
        jsonResponse(response, 500, { ok: false, error: error?.message || String(error) });
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
        jsonResponse(response, 200, {
          files,
          totalBytes,
          cooldownMs: 0,
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
        jsonResponse(response, 410, { error: "remote_delivery_disabled", message: "Remote delivery is disabled. Use download mode." });
        return;
      }

      logsInFlight = true;
      try {
        const bundle = await buildLogBundle({ userNote, config });

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
