// Replay safe-mode reservations from a server.log file into MoySklad.
//
// Default mode: DRY RUN — prints a table of what would be created.
// With --apply — actually creates customer orders via the existing client.
// With --bundle=PATH — read server.log from inside a v-amber-logs zip bundle.
// With --log=PATH — read a specific log file (defaults to logs/server.log).
//
// Usage:
//   node scripts/replay-safe-mode.js
//   node scripts/replay-safe-mode.js --log=logs/worklogs/server.log
//   node scripts/replay-safe-mode.js --bundle=logs/v-amber-logs-...zip
//   node scripts/replay-safe-mode.js --apply
//
// Idempotency: each created order's description gets the commentId so
// re-running --apply on the same log skips already-applied reservations.

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMoySkladClient } from "../server/moysklad.js";
import { config } from "../server/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const has = (name) => args.includes(`--${name}`);

const APPLY = has("apply");
const BUNDLE = flag("bundle");
const LOG_PATH = flag("log") || (BUNDLE ? null : join(projectRoot, "logs", "server.log"));

function fmt(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return new Intl.NumberFormat("ru-RU").format(value);
  return String(value);
}

async function readLogText() {
  if (BUNDLE) {
    const { default: AdmZip } = await import("adm-zip").catch(() => ({ default: null }));
    if (!AdmZip) {
      console.error("Чтобы читать ZIP-бандл без распаковки нужен adm-zip. Распакуйте вручную и используйте --log=PATH.");
      process.exit(1);
    }
    const zip = new AdmZip(BUNDLE);
    const entry = zip.getEntry("server.log");
    if (!entry) {
      console.error("В бандле нет server.log");
      process.exit(1);
    }
    return zip.readAsText(entry);
  }
  return readFile(LOG_PATH, "utf8");
}

function parseLog(raw) {
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.component !== "safe-mode" || entry?.message !== "reservation_logged_only") continue;
    events.push({ ts: entry.ts, ...(entry.meta || {}) });
  }
  return events;
}

function printTable(events) {
  console.log("");
  console.log("Время              | Артикул | viewerId       | Имя                           | Цена  | Скидка | Итого | commentId");
  console.log("-------------------+---------+----------------+-------------------------------+-------+--------+-------+-----------");
  for (const e of events) {
    const ts = (e.ts || "").slice(0, 19).replace("T", " ");
    const name = String(e.viewerName || "").slice(0, 28).padEnd(28);
    console.log(
      `${ts} | ${String(e.code || "").padStart(7)} | ${String(e.viewerId || "").padStart(14)} | ${name} | ${String(fmt(e.salePrice)).padStart(5)} | ${String(fmt(e.discountAmount)).padStart(6)} | ${String(fmt(e.effectivePrice)).padStart(5)} | ${String(e.commentId || "—")}`,
    );
  }
}

async function applyEvents(events) {
  const moysklad = createMoySkladClient(config.moysklad);
  if (!moysklad.isEnabled) {
    console.error("MOYSKLAD_LOGIN/PASSWORD не настроены — нельзя применить.");
    process.exit(1);
  }

  // Track which orders we created per viewer so subsequent reservations from
  // the same viewer are appended, mirroring runtime behaviour.
  const ordersByViewerId = new Map();
  const results = [];

  for (const e of events) {
    if (!e.code || !e.viewerId) {
      results.push({ event: e, status: "skipped_invalid" });
      continue;
    }

    try {
      // Fetch a fresh product card so we use the current image/availability
      // and verify the article still exists.
      const productCard = await moysklad.getProductCardByCode(e.code);
      if (!productCard?.id) {
        results.push({ event: e, status: "product_not_found" });
        continue;
      }

      const counterparty = await moysklad.ensureCounterparty({
        viewerId: e.viewerId,
        viewerName: e.viewerName || "",
      });
      if (!counterparty?.id) {
        results.push({ event: e, status: "counterparty_failed" });
        continue;
      }

      const reservation = {
        commentId: e.commentId,
        viewerId: e.viewerId,
        viewerName: e.viewerName || "",
        text: e.commentText || "бронь",
        createdAt: e.createdAt || e.ts,
      };

      const salePrice = typeof e.salePrice === "number" ? e.salePrice : productCard.salePrice;
      const effectivePrice = typeof e.effectivePrice === "number" && e.effectivePrice > 0
        ? e.effectivePrice
        : salePrice;
      const activeLot = {
        code: e.code,
        lotSessionId: e.lotSessionId || `replay-${e.commentId}`,
        product: { ...productCard, salePrice: effectivePrice },
        discountAmount: 0,
      };

      const existing = ordersByViewerId.get(e.viewerId);
      let order;
      if (existing?.id) {
        await moysklad.appendPositionToCustomerOrder({
          orderId: existing.id,
          activeLot,
          productCard: { salePrice: effectivePrice },
          reservation,
        });
        order = existing;
        results.push({ event: e, status: "appended", orderId: order.id });
      } else {
        order = await moysklad.createCustomerOrderReservation({
          activeLot,
          productCard: { salePrice: effectivePrice },
          reservation,
        });
        if (order?.id) ordersByViewerId.set(e.viewerId, order);
        results.push({ event: e, status: "created", orderId: order?.id || null });
      }
    } catch (error) {
      results.push({ event: e, status: "error", error: error?.message || String(error) });
    }
  }

  console.log("\nИтоги:");
  const byStatus = new Map();
  for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
  for (const [status, n] of byStatus) console.log(`  ${status}: ${n}`);
  const failed = results.filter((r) => r.status === "error" || r.status === "product_not_found");
  if (failed.length) {
    console.log("\nПроблемы:");
    for (const r of failed) {
      console.log(`  ${r.event.code} / ${r.event.viewerName || r.event.viewerId} -> ${r.status}${r.error ? `: ${r.error}` : ""}`);
    }
  }
}

const raw = await readLogText();
const events = parseLog(raw);
console.log(`Найдено safe-mode броней: ${events.length}`);
if (events.length === 0) {
  console.log("Ничего восстанавливать.");
  process.exit(0);
}

printTable(events);

if (APPLY) {
  console.log("\n--apply — создаю заказы в МойСклад…");
  await applyEvents(events);
} else {
  console.log("\nЭто DRY-RUN. Запустите с --apply, чтобы создать заказы.");
}
