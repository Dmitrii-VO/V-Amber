// READ-ONLY diff between an эфир log bundle and MoySklad ground truth.
//
// This is §8 of knowledge/wiki/log-verification-checklist.md — the part the logs
// alone cannot do. analyze-broadcast-logs.mjs reports what the app BELIEVES it
// wrote; this script asks MoySklad what is actually there and diffs the two:
//
//   · every live бронь → does the order exist, the position exist, the price and
//     quantity match what the log recorded?
//   · every cancelled бронь → is the position really gone?
//   · every `stale_discarded` бронь → the write DID succeed, so the position is
//     expected to be there even though no dashboard ever showed it;
//   · orders carrying the `#Эфир <date>` marker that the logs never mention;
//   · more than one open order per buyer in the campaign window.
//
// It only ever issues GET requests. Nothing here writes to MoySklad.
//
// USAGE (from repo root; needs MOYSKLAD_LOGIN/PASSWORD in .env):
//   node scripts/verify-broadcast-against-moysklad.mjs path/to/bundle --date 2026-08-01
//   … --gap 3        campaign window in days (default 3, = config.campaignMaxGapDays)
//   … --limit 40     stop after N reservations (smoke test)
import "dotenv/config";
import { loadBundle, finalizeReservations, isLive, expectedEffectivePrice } from "./lib/broadcast-log.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const date = opt("date", null);
const gapDays = Number(opt("gap", 3));
const limit = Number(opt("limit", 0)) || Infinity;
const flagIdx = new Set(["--date", "--gap", "--limit"].flatMap((f) => { const i = argv.indexOf(f); return i >= 0 ? [i, i + 1] : []; }));
const inputs = argv.filter((a, i) => !flagIdx.has(i) && !a.startsWith("--"));
if (inputs.length === 0 || !date) {
  console.error("Usage: node scripts/verify-broadcast-against-moysklad.mjs <bundle-dir> --date YYYY-MM-DD [--gap 3] [--limit N]");
  process.exit(1);
}

const baseUrl = (process.env.MOYSKLAD_BASE_URL?.trim() || "https://api.moysklad.ru/api/remap/1.2/").replace(/\/$/, "");
if (!process.env.MOYSKLAD_LOGIN || !process.env.MOYSKLAD_PASSWORD) {
  console.error("MoySklad creds missing in .env (MOYSKLAD_LOGIN / MOYSKLAD_PASSWORD)");
  process.exit(1);
}
const headers = {
  Authorization: "Basic " + Buffer.from(`${process.env.MOYSKLAD_LOGIN}:${process.env.MOYSKLAD_PASSWORD}`).toString("base64"),
  Accept: "application/json;charset=utf-8",
};

let calls = 0;
async function get(path) {
  for (let i = 0; i < 8; i++) {
    calls++;
    const r = await fetch(`${baseUrl}/${path}`, { method: "GET", headers });
    if (r.status === 429) { await new Promise((x) => setTimeout(x, 1000 * (i + 1))); continue; }
    if (r.status === 404) return { __404: true };
    if (!r.ok) throw new Error(`${r.status} GET ${path}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }
  throw new Error("429 exhausted: " + path);
}

// ─── Load the logs ─────────────────────────────────────────────────────────
const { events, meta } = loadBundle(inputs, { date });
const finalized = finalizeReservations(events);
const live = finalized.filter(isLive).slice(0, limit);
const cancelled = finalized.filter((e) => e.status === "cancelled");
const stale = finalized.filter((e) => e.status === "stale_discarded");

console.log("═".repeat(72));
console.log(`MOYSKLAD GROUND-TRUTH DIFF   эфир ${date}   (READ-ONLY)`);
console.log("═".repeat(72));
console.log(`bundle v${meta?.vamberVersion || "?"}   живых броней: ${live.length}   отменённых: ${cancelled.length}   stale_discarded: ${stale.length}`);

const findings = [];
const add = (sev, text) => { findings.push({ sev, text }); console.log(`   ${sev === "err" ? "✗" : "⚠"} ${text}`); };

// MoySklad timestamps are "YYYY-MM-DD HH:mm:ss.SSS" in the account's timezone;
// log timestamps are UTC ISO. Compared only coarsely — "was this order touched
// after the эфир finished" — so the offset does not matter.
const lastLogTs = events.reduce((m, e) => (typeof e.ts === "string" && e.ts > m ? e.ts : m), "");
const toIso = (msTs) => String(msTs).replace(" ", "T") + "Z";

// ─── 1. Live positions ─────────────────────────────────────────────────────
console.log(`\n[1] Живые брони → позиции в МойСкладе`);
const orderCache = new Map();
async function orderWithPositions(orderId) {
  if (orderCache.has(orderId)) return orderCache.get(orderId);
  const order = await get(`entity/customerorder/${orderId}`);
  let positions = [];
  if (!order.__404) {
    const list = await get(`entity/customerorder/${orderId}/positions?limit=1000`);
    positions = list.__404 ? [] : (list.rows || []);
  }
  const rec = { order, positions };
  orderCache.set(orderId, rec);
  return rec;
}

let okCount = 0;
for (const e of live) {
  const tag = `${e.code} ${e.viewerName}`;
  if (!e.orderId) { add("err", `${tag}: в логе нет orderId — заказ не идентифицируется`); continue; }
  const { order, positions } = await orderWithPositions(e.orderId);
  if (order.__404) { add("err", `${tag}: заказ ${e.orderId} НЕ НАЙДЕН в МойСкладе (удалён или не создавался)`); continue; }
  const pos = positions.find((r) => r.id === e.positionId)
    || positions.find((r) => (r.assortment?.meta?.href || "").includes(e.productId));
  if (!pos) { add("err", `${tag}: позиции нет в заказе ${order.name || e.orderId} — бронь в логе есть, в МойСкладе нет`); continue; }
  // MoySklad stores the BASE price plus a discount PERCENT
  // (buildCustomerOrderPosition in server/moysklad.js), so the money the buyer
  // actually pays is price × (1 − discount/100). Comparing `price` alone reports
  // every discounted position as wrong.
  const baseRub = (pos.price || 0) / 100;
  const netRub = Math.round(baseRub * (1 - (Number(pos.discount) || 0) / 100) * 100) / 100;
  const wantRub = Number(e.effectivePrice ?? expectedEffectivePrice(e));
  const editedAfter = order.updated && lastLogTs && toIso(order.updated) > lastLogTs;
  const problems = [];
  let sev = "err";
  if (baseRub === 0) problems.push("цена 0");
  if (Number(pos.quantity) < Number(e.quantity || 1)) problems.push(`количество ${pos.quantity} < ${e.quantity}`);
  if (Math.abs(netRub - wantRub) > 0.51) {
    // The log recorded price 0 and MoySklad has a real price: that is
    // fix-zero-price-positions.mjs (or the operator) having repaired it. A
    // repair, not a defect.
    if (wantRub === 0 && netRub > 0) {
      add("warn", `${tag} (заказ ${order.name}): в логе цена 0, в МойСкладе ${netRub}₽ — позиция уже исправлена`);
      continue;
    }
    problems.push(`к оплате ${netRub}₽ вместо ${wantRub}₽ (база ${baseRub}₽, скидка ${Number(pos.discount) || 0}%)`);
    // Cheaper than announced + the order was touched after the эфир ended = a
    // manual post-broadcast edit, not a lost price. Dearer than announced is
    // always a defect: the buyer is charged more than they were told.
    if (netRub < wantRub && editedAfter) sev = "warn";
  }
  if (problems.length) {
    add(sev, `${tag} (заказ ${order.name}): ${problems.join(", ")}${sev === "warn" ? `  [заказ правился после эфира: ${order.updated}]` : ""}`);
  } else okCount++;
}
console.log(`    сошлось без замечаний: ${okCount} из ${live.length}`);

// ─── 2. Cancellations really removed ───────────────────────────────────────
console.log(`\n[2] Отменённые брони → позиция должна отсутствовать`);
let cancelOk = 0;
for (const e of cancelled) {
  if (!e.orderId) continue;
  const { order, positions } = await orderWithPositions(e.orderId);
  if (order.__404) { cancelOk++; continue; }
  const stillThere = positions.find((r) => r.id === e.positionId)
    || positions.find((r) => (r.assortment?.meta?.href || "").includes(e.productId));
  if (stillThere) add("err", `${e.code} ${e.viewerName}: бронь отменена в логе, но позиция ЖИВА в заказе ${order.name} — остаток занят зря`);
  else cancelOk++;
}
console.log(`    корректно снято: ${cancelOk} из ${cancelled.length}`);

// ─── 3. stale_discarded — invisible but real ───────────────────────────────
if (stale.length) {
  console.log(`\n[3] stale_discarded → запись прошла, приложение о ней забыло`);
  for (const e of stale) {
    if (!e.orderId) { add("warn", `${e.code} ${e.viewerName}: stale_discarded без orderId — проверить вручную`); continue; }
    const { order, positions } = await orderWithPositions(e.orderId);
    if (order.__404) { add("warn", `${e.code} ${e.viewerName}: stale_discarded, заказа нет — значит запись всё же не прошла`); continue; }
    const pos = positions.find((r) => (r.assortment?.meta?.href || "").includes(e.productId));
    add(pos ? "warn" : "err", `${e.code} ${e.viewerName}: позиция ${pos ? "ЕСТЬ" : "отсутствует"} в заказе ${order.name} — на дашборде её не было`);
  }
}

// ─── 4. Orders with the marker that the logs never mention ─────────────────
console.log(`\n[4] Заказы с маркером #Эфир в окне кампании (±${gapDays} дн.) vs логи`);
const day = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const inCampaign = (d) => Math.abs(Math.round((day(d) - day(date)) / 86400000)) <= gapDays;
const from = new Date(day(date) - gapDays * 86400000).toISOString().slice(0, 10);
const to = new Date(day(date) + 86400000).toISOString().slice(0, 10);

const marked = [];
for (let offset = 0; ; offset += 100) {
  const filter = encodeURIComponent(`created>=${from} 00:00:00;created<=${to} 23:59:59`);
  const page = await get(`entity/customerorder?limit=100&offset=${offset}&filter=${filter}`);
  const rows = page.rows || [];
  for (const o of rows) {
    const desc = String(o.description || "");
    const dates = [...desc.matchAll(/#Эфир\s+(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    if (dates.some(inCampaign)) marked.push({ o, dates });
  }
  if (rows.length < 100 || offset > 2000) break;
}
const loggedOrderIds = new Set(finalized.map((e) => e.orderId).filter(Boolean));
const todayMarked = marked.filter((x) => x.dates.includes(date));
const unknown = todayMarked.filter((x) => !loggedOrderIds.has(x.o.id));
console.log(`    заказов кампании: ${marked.length}, с маркером ${date}: ${todayMarked.length}, из них нет в логах: ${unknown.length}`);
for (const x of unknown) add("warn", `заказ ${x.o.name} (${x.o.id}) помечен #Эфир ${date}, но в логах эфира не встречается`);

// buyers with more than one order in the campaign window
const perAgent = new Map();
for (const x of marked) {
  const agent = x.o.agent?.meta?.href?.split("/").pop() || "?";
  perAgent.set(agent, [...(perAgent.get(agent) || []), x.o]);
}
const dupBuyers = [...perAgent.values()].filter((v) => v.length > 1);
console.log(`    покупателей с >1 заказом в окне кампании: ${dupBuyers.length}`);
for (const v of dupBuyers.slice(0, 10)) add("warn", `дубль заказов: ${v.map((o) => o.name).join(" + ")} — их предполагалось объединить`);

// ─── Summary ───────────────────────────────────────────────────────────────
const errs = findings.filter((f) => f.sev === "err").length;
console.log("\n" + "═".repeat(72));
console.log(errs === 0
  ? `✓ Расхождений с МойСкладом не найдено. Предупреждений: ${findings.length - errs}. (GET-запросов: ${calls})`
  : `✗ Расхождений: ${errs}, предупреждений: ${findings.length - errs}. (GET-запросов: ${calls})`);
console.log("═".repeat(72));
process.exitCode = errs ? 1 : 0;
