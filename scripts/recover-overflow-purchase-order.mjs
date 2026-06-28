// Build a MoySklad Purchase Order (Заказ поставщику) from overflow reservations
// — the брони that did not fit current stock during order recovery.
//
// Reads logs/order-recovery-overflow.json (produced by recover-orders-from-logs.mjs
// or the overflow reconciler), aggregates demand per product, resolves each
// product's id + buy price, and creates ONE purchase order to the chosen
// supplier (counterparty). See knowledge/wiki/order-recovery-from-logs.md.
//
// USAGE (from repo root):
//   node scripts/recover-overflow-purchase-order.mjs --supplier "ИП Галямов Дмитрий Сергеевич"
//   node scripts/recover-overflow-purchase-order.mjs --supplier "..." --execute
import "dotenv/config";
import fs from "node:fs";
import { config } from "../server/config.js";
import { createMoySkladClient } from "../server/moysklad.js";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const EXECUTE = args.includes("--execute");
const supplierName = flag("supplier");
const overflowFile = flag("overflow", "logs/order-recovery-overflow.json");
const dateStr = flag("date", "2026-06-27");
const updateId = flag("update"); // patch an existing PO's description instead of creating
if (!supplierName) { console.error('Need --supplier "<counterparty name>"'); process.exit(1); }

const ms = createMoySkladClient(config.moysklad);
if (!ms.isEnabled) { console.error("MoySklad not configured (check .env)"); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(overflowFile, "utf8"));
const overflow = Array.isArray(raw) ? raw : (raw.overflow || []);
if (overflow.length === 0) { console.log("No overflow entries — nothing to order."); process.exit(0); }

// Resolve supplier counterparty by exact name.
const suppliers = await ms.listSuppliers();
const supplier = suppliers.find((s) => s.name === supplierName)
  || suppliers.find((s) => s.name.toLowerCase().includes(supplierName.toLowerCase()));
if (!supplier) { console.error(`Supplier not found: ${supplierName}`); process.exit(1); }
console.log(`Supplier: ${supplier.name} (${supplier.id})`);

// Resolve product id + buy price per code (zero-pad fallback), aggregate qty.
async function getProduct(code) {
  for (const v of [...new Set([code, code.startsWith("0") ? code : "0" + code, code.padStart(5, "0")])]) {
    const res = await rawGet(`entity/product?filter=code=${v}&limit=1`);
    if (res?.rows?.[0]) return res.rows[0];
  }
  return null;
}
// Minimal direct GET (reuses env creds) for the product buy price.
const baseUrl = (process.env.MOYSKLAD_BASE_URL?.trim() || "https://api.moysklad.ru/api/remap/1.2/").replace(/\/$/, "");
const headers = { Authorization: "Basic " + Buffer.from(`${process.env.MOYSKLAD_LOGIN}:${process.env.MOYSKLAD_PASSWORD}`).toString("base64"), Accept: "application/json;charset=utf-8" };
async function rawGet(p) { for (let i = 0; i < 8; i++) { const r = await fetch(`${baseUrl}/${p}`, { headers }); if (r.status === 429) { await new Promise(x => setTimeout(x, 1000 * (i + 1))); continue; } if (!r.ok) throw new Error(`${r.status} ${p}`); return r.json(); } throw new Error("429 " + p); }
async function rawPut(p, body) { for (let i = 0; i < 8; i++) { const r = await fetch(`${baseUrl}/${p}`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (r.status === 429) { await new Promise(x => setTimeout(x, 1000 * (i + 1))); continue; } if (!r.ok) throw new Error(`${r.status} ${p}: ${(await r.text()).slice(0, 200)}`); return r.json(); } throw new Error("429 " + p); }

const byProduct = new Map(); // productId -> { name, code, buyPrice(kopecks), qty, buyers[] }
for (const o of overflow) {
  const p = await getProduct(String(o.code).trim());
  if (!p) { console.warn(`  ! product not found for code ${o.code} (${o.viewerName})`); continue; }
  const buyPrice = Number(p.buyPrice?.value || 0); // already in kopecks
  const cur = byProduct.get(p.id) || { name: p.name, code: p.code, buyPrice, qty: 0, buyers: [] };
  const qty = Math.max(1, Number(o.quantity) || 1);
  cur.qty += qty;
  // Track who each unit is for (qty>1 from one comment → repeat the name).
  for (let i = 0; i < qty; i++) cur.buyers.push(o.viewerName || `VK ${o.viewerId}`);
  byProduct.set(p.id, cur);
  await new Promise(x => setTimeout(x, 150));
}

const positions = [...byProduct.entries()].map(([productId, v]) => ({ productId, quantity: v.qty, price: v.buyPrice }));
console.log(`\nPurchase order positions (${positions.length} products, ${positions.reduce((s, p) => s + p.quantity, 0)} units):`);
for (const [, v] of byProduct) console.log(`  ${v.code}  x${v.qty}  buyPrice=${(v.buyPrice / 100).toFixed(2)}₽  ${v.name}  ← ${v.buyers.join(", ")}`);

const defaults = await ms.getDefaults();
// Per-article buyer breakdown so the operator sees WHO each ordered unit is for.
const lines = [...byProduct.values()].map((v) => `${v.code} ${v.name} ×${v.qty}: ${v.buyers.join(", ")}`);
const description = `Предзаказ из эфира ${dateStr}. Не поместившиеся брони (out of stock). Кому предназначено:\n${lines.join("\n")}`;

if (!EXECUTE) { console.log("\nDescription preview:\n" + description); console.log("\n(dry-run) add --execute to create/update the purchase order."); process.exit(0); }

// --update <poId>: patch the description of an existing PO (no new order).
if (updateId) {
  const res = await rawPut(`entity/purchaseorder/${updateId}`, { description: description.slice(0, 4000) });
  console.log(`\nUPDATED purchase order ${res.name} (${res.id}) description with buyer breakdown.`);
  fs.writeFileSync("logs/order-recovery-purchase-order.json", JSON.stringify({ updatedAt: new Date().toISOString(), purchaseOrder: { id: res.id, name: res.name }, supplier, positions: [...byProduct.values()] }, null, 2));
  process.exit(0);
}

const po = await ms.createPurchaseOrder({
  organizationId: defaults.organizationId,
  storeId: defaults.storeId,
  agentId: supplier.id,
  positions,
  description,
  source: "recovery-script",
});
console.log(`\nCREATED purchase order: ${po.name} (${po.id}) -> supplier ${supplier.name}`);
fs.writeFileSync("logs/order-recovery-purchase-order.json", JSON.stringify({ createdAt: new Date().toISOString(), purchaseOrder: po, supplier, positions: [...byProduct.values()] }, null, 2));
