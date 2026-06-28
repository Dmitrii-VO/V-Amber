// Merge per-buyer customer orders across two эфир dates into one order.
//
// WHY: order merging is date-scoped (server/ws-server.js looks up an existing
// order ONLY for the current #Эфир <date> marker, moysklad.js
// findLatestBroadcastCustomerOrder), so a buyer who reserved on two different
// эфир dates ends up with two separate orders. The day-agnostic lookup
// (findLatestOpenCustomerOrder) exists but the live flow does not use it. This
// script reconciles after the fact: it folds each buyer's --from-date order into
// their --into-date order (survivor), preserving quantity/price/discount/reserve,
// tags the survivor with the --from marker, and deletes the emptied order (goes
// to the MoySklad recycle bin — recoverable).
//
// DEFAULT IS DRY-RUN. Add --execute to apply.
//
// USAGE (from repo root):
//   node scripts/merge-broadcast-orders.mjs --into 2026-06-27 --from 2026-06-28
//   node scripts/merge-broadcast-orders.mjs --into 2026-06-27 --from 2026-06-28 --execute
import "dotenv/config";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const EXECUTE = args.includes("--execute");
const INTO = flag("into", "2026-06-27");   // survivor marker (orders kept)
const FROM = flag("from", "2026-06-28");    // absorbed marker (orders emptied+deleted)

const baseUrl = (process.env.MOYSKLAD_BASE_URL?.trim() || "https://api.moysklad.ru/api/remap/1.2/").replace(/\/$/, "");
if (!process.env.MOYSKLAD_LOGIN || !process.env.MOYSKLAD_PASSWORD) { console.error("MoySklad creds missing in .env"); process.exit(1); }
const headers = { Authorization: "Basic " + Buffer.from(`${process.env.MOYSKLAD_LOGIN}:${process.env.MOYSKLAD_PASSWORD}`).toString("base64"), Accept: "application/json;charset=utf-8" };
async function req(method, path, body) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${baseUrl}/${path}`, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await new Promise(x => setTimeout(x, 1000 * (i + 1))); continue; }
    if (method === "DELETE" && r.status === 200) return {};
    if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${(await r.text()).slice(0, 300)}`);
    return r.status === 204 ? {} : r.json();
  }
  throw new Error("429 " + path);
}
const markerOf = (d) => { const m = String(d || "").match(/#Эфир\s+(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };

// Pull all эфир orders since the earlier of the two dates.
const since = (INTO < FROM ? INTO : FROM) + " 00:00:00";
let offset = 0, all = [];
while (true) {
  const j = await req("GET", `entity/customerorder?filter=${encodeURIComponent("moment>=" + since)}&order=moment,asc&limit=100&offset=${offset}&expand=agent,state`);
  const rows = j.rows || []; all.push(...rows); offset += rows.length;
  if (rows.length < 100 || offset >= (j.meta?.size || 0)) break;
}
const byAgent = new Map();
for (const o of all) {
  const mk = markerOf(o.description); if (mk !== INTO && mk !== FROM) continue;
  const a = byAgent.get(o.agent?.id) || { name: o.agent?.name, into: [], from: [] };
  (mk === INTO ? a.into : a.from).push(o);
  byAgent.set(o.agent?.id, a);
}
const pairs = [...byAgent.values()].filter((a) => a.into.length && a.from.length);
console.log(`MODE: ${EXECUTE ? "EXECUTE" : "DRY-RUN"}   into(survivor)=#Эфир ${INTO}  from(absorb+delete)=#Эфир ${FROM}`);
console.log(`Buyers with orders in both: ${pairs.length}\n`);

const APPENDABLE = (o) => !/Запакован|Отправлен|Доставлен|Отменен|Отменён/i.test(o.state?.name || "");
let movedPos = 0, mergedOrders = 0, deleted = 0, skipped = 0;
for (const a of pairs) {
  const target = a.into[0];
  const sources = a.from;
  if (!APPENDABLE(target) || sources.some((s) => !APPENDABLE(s))) {
    console.log(`  ⚠ ${a.name}: non-appendable state (target=${target.state?.name}, from=${sources.map(s => s.state?.name)}) — SKIP`);
    skipped++; continue;
  }
  let posCount = 0, sumMoved = 0;
  const bodies = [];
  for (const s of sources) {
    const pj = await req("GET", `entity/customerorder/${s.id}/positions?limit=1000`);
    for (const p of (pj.rows || [])) {
      bodies.push({ assortment: { meta: p.assortment.meta }, quantity: p.quantity, price: p.price, discount: p.discount || 0, vat: p.vat || 0, vatEnabled: !!p.vatEnabled, reserve: p.reserve || 0 });
      posCount++; sumMoved += (p.price || 0) * (p.quantity || 0);
    }
  }
  console.log(`  ${a.name}: ${target.name}(#${INTO}) <= ${sources.map(s => s.name).join(",")}(#${FROM})  | move ${posCount} pos, ${(sumMoved / 100).toFixed(0)}₽`);
  if (!EXECUTE) { movedPos += posCount; mergedOrders++; continue; }

  // 1) add positions to survivor
  if (bodies.length) await req("POST", `entity/customerorder/${target.id}/positions`, bodies);
  // 2) tag survivor description with the FROM marker (keep existing text)
  const desc = String(target.description || "");
  if (!desc.includes(`#Эфир ${FROM}`)) {
    await req("PUT", `entity/customerorder/${target.id}`, { description: `#Эфир ${FROM}\n${desc}`.slice(0, 4000) });
  }
  // 3) delete emptied source orders (→ recycle bin)
  for (const s of sources) { await req("DELETE", `entity/customerorder/${s.id}`); deleted++; }
  movedPos += posCount; mergedOrders++;
  await new Promise(x => setTimeout(x, 200));
}
console.log(`\n${EXECUTE ? "DONE" : "PLAN"}: ${mergedOrders} buyers merged, ${movedPos} positions ${EXECUTE ? "moved" : "to move"}, ${deleted} orders ${EXECUTE ? "deleted" : "to delete"}. Skipped ${skipped}.`);
if (!EXECUTE) console.log("Re-run with --execute to apply.");
