// Read-only health analyzer for an эфир log bundle. Emits the metrics behind
// knowledge/wiki/log-verification-checklist.md so a broadcast can be verified
// in one pass instead of eyeballing raw jsonl.
//
// USAGE (from repo root), point it at the session jsonl files of ONE эфир:
//   node scripts/analyze-broadcast-logs.mjs path/to/sessions/2026-06-28_*.jsonl
//   node scripts/analyze-broadcast-logs.mjs a.jsonl b.jsonl c.jsonl
//
// It never writes anything (logs or MoySklad). Pair it with the checklist.
import fs from "node:fs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length === 0) { console.error("Pass one or more session .jsonl files (one эфир)."); process.exit(1); }

const ev = [];
for (const f of files) {
  for (const ln of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) { try { ev.push(JSON.parse(ln)); } catch {} }
}
const K = (e) => e.kind || e.type || "?";
const by = (k) => ev.filter((e) => K(e) === k);
const fin = by("reservation_finalized");

// 1. MoySklad call health
const ms = {};
const msErr = [];
for (const e of by("moysklad_call")) {
  const op = e.operation || e.method || e.op || "?";
  const ok = e.ok !== false && !e.error && (e.status === undefined || e.status < 400);
  ms[op] = ms[op] || { ok: 0, err: 0 };
  ok ? ms[op].ok++ : (ms[op].err++, msErr.push({ op, status: e.status, error: e.error || e.message, code: e.code }));
}

// 2. reservation outcomes
const status = {};
for (const e of fin) status[e.status || "?"] = (status[e.status || "?"] || 0) + 1;
const live = fin.filter((e) => e.status === "reserved" || e.status === "reserved_appended");

// 3. order structure
const orders = new Map();
for (const e of live) {
  const o = orders.get(e.orderId) || { viewerIds: new Set(), viewers: new Set(), products: new Set(), dup: 0 };
  if (o.products.has(e.productId)) o.dup++;
  o.products.add(e.productId); o.viewerIds.add(e.viewerId); o.viewers.add(e.viewerName);
  orders.set(e.orderId, o);
}
const multiBuyer = [...orders.values()].filter((o) => o.viewerIds.size > 1).length;
const dupPos = [...orders.values()].reduce((s, o) => s + o.dup, 0);

// 4. pricing
const zeroPrice = live.filter((e) => !e.salePrice || e.salePrice <= 0);
const discSkipped = by("discount_skipped");

// 5. product / counterparty resolution
const productNotFound = fin.filter((e) => e.status === "product_not_found" || /not.?found/i.test(e.error || ""));

// 6. waitlist / wishlist
const wlPending = by("reservation_waitlist_pending").length;
const wlPromoted = by("waitlist_promoted").length;
const oos = fin.filter((e) => e.status === "out_of_stock");
const wishlistAdded = by("added").length; // wishlist additions

const p = (s) => console.log(s);
p("================ BROADCAST LOG HEALTH ================");
p(`sessions: ${files.length}  events: ${ev.length}`);
p("\n[1] MoySklad calls (ok/err):");
for (const [op, v] of Object.entries(ms)) p(`    ${op}: ${v.ok} ok / ${v.err} err`);
p(`    >> TOTAL ERRORS: ${msErr.length}   ${msErr.length === 0 ? "✓ healthy" : "✗ INVESTIGATE"}`);
for (const e of msErr.slice(0, 10)) p(`       ! ${JSON.stringify(e)}`);

p("\n[2] reservation_finalized by status:");
for (const [s, n] of Object.entries(status)) p(`    ${s}: ${n}`);

p("\n[3] Reconciliation:");
p(`    vk_comment=${by("vk_comment").length}  reservation_detected=${by("reservation_detected").length}  (should match)`);
p(`    live positions (reserved+appended)=${live.length}  across ${orders.size} orders`);
p(`    customer_order_created events=${by("customer_order_created").length}  cancelled=${by("customer_order_cancelled").length}`);

p("\n[4] Order structure:");
p(`    orders with >1 buyer: ${multiBuyer}   ${multiBuyer === 0 ? "✓" : "✗ grouping bug"}`);
p(`    duplicate product in same order: ${dupPos}   ${dupPos === 0 ? "✓" : "✗ dup positions"}`);
p(`    product_not_found finalizations: ${productNotFound.length}   ${productNotFound.length === 0 ? "✓" : "✗"}`);

p("\n[5] Pricing:");
p(`    positions with price 0: ${zeroPrice.length}   ${zeroPrice.length === 0 ? "✓" : "⚠ check transcript — voiced price may have been dropped"}`);
for (const e of zeroPrice) p(`       ⚠ ${e.code} ${e.viewerName} (order ${e.orderId})`);
p(`    discount_skipped: ${discSkipped.length}  (reasons below)`);
const reasons = {}; for (const e of discSkipped) reasons[e.reason || "?"] = (reasons[e.reason || "?"] || 0) + 1;
for (const [r, n] of Object.entries(reasons)) p(`       ${r}: ${n}`);

p("\n[6] Waitlist / wishlist:");
p(`    waitlist pending=${wlPending}  promoted=${wlPromoted}   ${wlPending === wlPromoted ? "✓ all promoted" : "⚠ unpromoted remain"}`);
p(`    out_of_stock=${oos.length}  wishlist 'added'=${wishlistAdded}   ${oos.length === wishlistAdded ? "✓ all captured" : "✗ mismatch — some OOS not in wishlist"}`);
for (const e of oos) p(`       oos: ${e.code} ${e.viewerName}`);

p("\n================ END ================");
p(msErr.length || multiBuyer || dupPos || productNotFound.length || (oos.length !== wishlistAdded) ? ">> RED FLAGS present — see above." : ">> No structural red flags. (Still eyeball pricing ⚠ items.)");
