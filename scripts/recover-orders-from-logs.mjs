// Recover customer orders (брони) into MoySklad from эфир session logs.
//
// WHY THIS EXISTS: if MoySklad auth fails during a live эфир (e.g. expired
// token → HTTP 401), every бронь is logged but no customer order is created
// (reservation_finalized status=product_not_found). The session jsonl still
// holds code + viewerId + quantity, so we can replay the reservations into
// MoySklad afterwards with working credentials. See
// knowledge/wiki/order-recovery-from-logs.md for the full procedure.
//
// USAGE (from repo root, .env must have working MOYSKLAD_LOGIN/PASSWORD):
//   node scripts/recover-orders-from-logs.mjs --sessions a.jsonl,b.jsonl [--date 2026-06-27]
//   node scripts/recover-orders-from-logs.mjs --sessions ... --date 2026-06-27 --execute
//
// Without --execute it only resolves and prints the allocation plan (read-only:
// GET products + READ-ONLY counterparty match). With --execute it creates the
// orders. It is IDEMPOTENT: orders are grouped per buyer under the
// "#Эфир <date>" marker; a product already present in a buyer's broadcast order
// is skipped, so a re-run after a partial/rate-limited run safely fills gaps.
//
// Stock policy: first-come (by comment time) up to the product's availableStock;
// reservations beyond stock are written to logs/order-recovery-overflow.json for
// manual handling (the local wishlist store does NOT sync to the operator Mac).
import "dotenv/config";
import fs from "node:fs";
import { config } from "../server/config.js";
import { createMoySkladClient } from "../server/moysklad.js";

const args = process.argv.slice(2);
const flag = (name, def = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def; };
const has = (name) => args.includes(`--${name}`);
const EXECUTE = has("execute");
const sessions = (flag("sessions") || "").split(",").map((s) => s.trim()).filter(Boolean);
if (sessions.length === 0) { console.error("Need --sessions a.jsonl,b.jsonl"); process.exit(1); }
const dateStr = flag("date") || new Date().toISOString().slice(0, 10);
const [Y, M, D] = dateStr.split("-").map(Number);
const BROADCAST_DATE = new Date(Y, M - 1, D, 12, 0, 0); // local noon → stable formatBroadcastDate
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) Collect reservation_finalized events, sorted by comment time (first-come).
const reservations = [];
for (const f of sessions) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.kind !== "reservation_finalized") continue;
    reservations.push({
      code: String(d.code || "").trim(), viewerId: d.viewerId, viewerName: d.viewerName,
      quantity: Math.max(1, Number(d.quantity) || 1), commentId: d.commentId,
      commentCreatedAt: d.commentCreatedAt || d.ts, lotSessionId: d.lotSessionId,
    });
  }
}
reservations.sort((a, b) => new Date(a.commentCreatedAt) - new Date(b.commentCreatedAt));

const ms = createMoySkladClient(config.moysklad);
if (!ms.isEnabled) { console.error("MoySklad not configured (check .env)"); process.exit(1); }

// 2) Resolve product per code, with leading-zero padding fallback.
const cardCache = new Map();
async function resolveCard(code) {
  if (cardCache.has(code)) return cardCache.get(code);
  const variants = [...new Set([code, code.startsWith("0") ? code : "0" + code, code.padStart(5, "0")])];
  let card = null;
  for (const v of variants) { card = await ms.getProductCardByCode(v); if (card) break; }
  cardCache.set(code, card);
  return card;
}
for (const r of reservations) r.card = await resolveCard(r.code);

// 3) Allocate first-come up to availableStock per product (reserve floor 1:
//    operator naming an article on air implies ≥1 in hand).
const byProduct = new Map(); const unresolved = [];
for (const r of reservations) {
  if (!r.card) { unresolved.push(r); continue; }
  if (!byProduct.has(r.card.id)) byProduct.set(r.card.id, []);
  byProduct.get(r.card.id).push(r);
}
const allocated = []; const overflow = [];
for (const [, group] of byProduct) {
  const avail = group[0].card.availableStock;
  const cap = (typeof avail === "number" && Number.isFinite(avail)) ? Math.max(0, Math.floor(avail)) : 1;
  let used = 0;
  for (const r of group) {
    if (used + r.quantity <= cap || (cap === 0 && used === 0)) { r.alloc = "order"; used += r.quantity; allocated.push(r); }
    else { r.alloc = "overflow"; overflow.push(r); }
  }
}
console.log(`Reservations: ${reservations.length} | orders: ${allocated.length} | overflow: ${overflow.length} | unresolved: ${unresolved.length} | EXECUTE=${EXECUTE}`);
if (unresolved.length) console.log("UNRESOLVED:", unresolved.map((r) => `${r.code}/${r.viewerName}`).join(", "));

// 4) Create orders (idempotent). One broadcast order per buyer.
const results = { created: [], appended: [], skipped: [], errors: [] };
const slim = (r) => ({ code: r.code, product: r.card?.name || null, price: r.card?.salePrice ?? null, viewerId: r.viewerId, viewerName: r.viewerName });
if (EXECUTE) {
  const orderByViewer = new Map();
  for (const r of allocated) {
    try {
      const cp = await ms.ensureCounterparty({ viewerId: r.viewerId, viewerName: r.viewerName });
      if (!cp?.id) { results.errors.push({ ...slim(r), error: "counterparty_unresolved" }); continue; }
      let order = orderByViewer.get(r.viewerId) || null;
      if (!order) { order = await ms.findBroadcastCustomerOrderForCounterparty(cp.id, { broadcastDate: BROADCAST_DATE }); if (order?.id) orderByViewer.set(r.viewerId, order); }
      if (order?.id) { const hp = await ms.hasPositionForProduct(cp.id, r.card.id); if (hp?.inOpenOrder) { results.skipped.push({ ...slim(r), orderId: order.id, reason: "already_in_order" }); continue; } }
      const activeLot = { code: r.code, lotSessionId: r.lotSessionId, product: { id: r.card.id, salePrice: r.card.salePrice, availableStock: r.card.availableStock, voicePrice: null }, discountAmount: 0 };
      const productCard = { salePrice: r.card.salePrice, voicePrice: null };
      if (order?.id) {
        const ap = await ms.appendPositionToCustomerOrder({ orderId: order.id, activeLot, reservation: r, productCard, broadcastDate: BROADCAST_DATE });
        results.appended.push({ ...slim(r), orderId: order.id, positionId: ap?.positionId || null });
      } else {
        const created = await ms.createCustomerOrderReservation({ activeLot, reservation: r, productCard, broadcastDate: BROADCAST_DATE });
        if (created?.id) { orderByViewer.set(r.viewerId, created); results.created.push({ ...slim(r), orderId: created.id }); }
        else results.errors.push({ ...slim(r), error: "create_returned_null" });
      }
      await sleep(200);
    } catch (e) { results.errors.push({ ...slim(r), error: e.message }); }
  }
}

const report = {
  generatedAt: new Date().toISOString(), executed: EXECUTE, broadcastDate: dateStr,
  totals: { reservations: reservations.length, orders: allocated.length, overflow: overflow.length, unresolved: unresolved.length },
  results,
  overflow: overflow.map((r) => ({ code: r.code, productId: r.card?.id, product: r.card?.name, salePrice: r.card?.salePrice, stock: r.card?.availableStock, viewerId: r.viewerId, viewerName: r.viewerName, at: r.commentCreatedAt })),
  unresolved: unresolved.map((r) => ({ code: r.code, viewerId: r.viewerId, viewerName: r.viewerName })),
};
fs.writeFileSync("logs/order-recovery-result.json", JSON.stringify(report, null, 2));
fs.writeFileSync("logs/order-recovery-overflow.json", JSON.stringify({ overflow: report.overflow }, null, 2));
console.log("Report -> logs/order-recovery-result.json ; overflow -> logs/order-recovery-overflow.json");
if (EXECUTE) console.log(`CREATED ${results.created.length} | APPENDED ${results.appended.length} | SKIPPED ${results.skipped.length} | ERRORS ${results.errors.length}`);
