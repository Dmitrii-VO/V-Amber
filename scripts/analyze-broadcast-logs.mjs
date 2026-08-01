// Read-only health analyzer for an эфир log bundle. Emits the metrics behind
// knowledge/wiki/log-verification-checklist.md so a broadcast can be verified
// in one pass instead of eyeballing raw jsonl.
//
// USAGE (from repo root) — a whole bundle plus the эфир date is the normal form,
// because one эфир spans several session files (every reconnect starts a new one)
// and half the checks live in server.log:
//   node scripts/analyze-broadcast-logs.mjs path/to/bundle --date 2026-08-01
//   node scripts/analyze-broadcast-logs.mjs path/to/sessions/2026-08-01_*.jsonl
//
// It never writes anything (logs or MoySklad). It reports what the APP recorded;
// it does not read MoySklad — for that run verify-broadcast-against-moysklad.mjs.
import {
  loadBundle, finalizeReservations, isLive, STATUS_MEANING, priceMismatch,
  by, byMessage, windowOf, inWindow, broadcastDates,
} from "./lib/broadcast-log.mjs";

const argv = process.argv.slice(2);
const dateIdx = argv.indexOf("--date");
const date = dateIdx >= 0 ? argv[dateIdx + 1] : null;
const asJson = argv.includes("--json");
const inputs = argv.filter((a, i) => !a.startsWith("--") && i !== dateIdx + 1);
if (inputs.length === 0) {
  console.error("Usage: node scripts/analyze-broadcast-logs.mjs <bundle-dir|*.jsonl> [--date YYYY-MM-DD] [--json]");
  process.exit(1);
}

const { sessions, events, serverEvents, serverLogFiles, wishlistEvents, meta } = loadBundle(inputs, { date });
const win = windowOf(events);
const srv = serverEvents.filter((e) => inWindow(e, win));

const flags = [];
const flag = (s) => flags.push(s);
const p = (s) => { if (!asJson) console.log(s); };
const pct = (n, d) => (d ? ` (${Math.round((n / d) * 100)}%)` : "");

// ─── §0 Orientation ────────────────────────────────────────────────────────
p("═".repeat(72));
p("BROADCAST LOG HEALTH   " + (date ? `эфир ${date}` : `dates: ${broadcastDates(events).join(", ")}`));
p("═".repeat(72));
p(`\n[0] Bundle`);
p(`    session files: ${sessions.length}   events: ${events.length}`);
for (const s of sessions) {
  const ended = by(s.events, "session_ended")[0];
  const last = s.events.at(-1)?.ts;
  // The operator usually downloads the bundle while the эфир is still running,
  // so the newest session legitimately has no session_ended. Only flag a gap.
  const stillRunning = !ended && meta?.generatedAt && last
    && (new Date(meta.generatedAt) - new Date(last)) < 5 * 60_000;
  const endLabel = ended ? (ended.reason || "ok") : (stillRunning ? "шла на момент выгрузки" : "НЕТ session_ended");
  p(`      · ${s.file.split(/[\\/]/).pop()}  ${s.events.length} ev  end=${endLabel}`);
  if (!ended && !stillRunning) flag(`сессия ${s.file.split(/[\\/]/).pop()} оборвалась (нет session_ended)`);
}
p(`    server.log files read: ${serverLogFiles.length}${serverLogFiles.length === 0 ? "  ⚠ отмены и no_open_lot НЕ проверены" : ""}`);
if (serverLogFiles.length === 0) flag("server.log не найден — проверки §2.3 (отмены) пропущены");
p(`    window: ${win.from} … ${win.to}`);
if (meta) {
  const ie = meta.integrationsEnabled || {};
  p(`    version=${meta.vamberVersion || "?"} platform=${meta.platform || "?"} integrations: ${Object.entries(ie).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (ie.moysklad === false) flag("integrationsEnabled.moysklad=false — заказы не могли быть созданы вообще");
  // Only the files of THIS эфир matter; a bundle carries weeks of older sessions.
  const loadedNames = new Set(sessions.map((s) => s.file.split(/[\\/]/).pop()));
  const truncated = (meta.files || []).filter((f) => f.truncated && loadedNames.has(String(f.name).split("/").pop()));
  if (truncated.length) { p(`    ⚠ truncated files: ${truncated.length} — счётчики ниже это НИЖНЯЯ граница`); flag(`${truncated.length} файл(ов) обрезаны — счётчики неполные`); }
}
const safeToggles = [...by(events, "safemode_toggled"), ...byMessage(srv, "safe_mode_changed")];
p(`    safe mode toggles in window: ${safeToggles.length}${safeToggles.length ? "  ⚠" : ""}`);
if (safeToggles.length) flag(`safe mode переключался ${safeToggles.length} раз(а) — часть эфира могла не писаться в МойСклад`);

// ─── §1 MoySklad call health ───────────────────────────────────────────────
const msCalls = by(events, "moysklad_call");
const msByOp = {};
const msErrors = [];
const msRetried = [];
let slowest = [];
for (const e of msCalls) {
  const op = e.op || e.method || "?";
  const ok = e.ok !== false && !(Number(e.httpStatus) >= 400);
  msByOp[op] = msByOp[op] || { ok: 0, err: 0 };
  if (ok) msByOp[op].ok++; else { msByOp[op].err++; msErrors.push(e); }
  if (Number(e.attempts) > 1) msRetried.push(e);
  slowest.push(e);
}
slowest = slowest.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 5);
const httpStatuses = {};
for (const e of msErrors) httpStatuses[e.httpStatus ?? "no-status"] = (httpStatuses[e.httpStatus ?? "no-status"] || 0) + 1;

p(`\n[1] MoySklad calls — ${msCalls.length} total`);
for (const [op, v] of Object.entries(msByOp)) p(`    ${op}: ${v.ok} ok / ${v.err} err`);
p(`    >> ERRORS: ${msErrors.length}   ${msErrors.length === 0 ? "✓ healthy" : "✗ INVESTIGATE"}`);
if (msErrors.length) {
  p(`       by httpStatus: ${JSON.stringify(httpStatuses)}`);
  for (const e of msErrors.slice(0, 10)) p(`       ! ${e.ts} ${e.method || ""} ${e.op} ${e.path || ""} → ${e.httpStatus ?? "-"} ${String(e.errorMessage || "").slice(0, 120)}`);
  flag(`${msErrors.length} упавших вызовов МойСклад ${JSON.stringify(httpStatuses)}`);
  if (Object.keys(httpStatuses).some((s) => s === "401" || s === "403")) flag("401/403 — токен МойСклада мёртв, заказов могло не быть вовсе → order-recovery-from-logs");
}
p(`    retried (attempts>1): ${msRetried.length}${msRetried.length ? "  ⚠ ранний признак деградации" : ""}`);
if (msRetried.length) flag(`${msRetried.length} вызовов прошли только с ретрая`);
p(`    slowest: ${slowest.map((e) => `${e.op}=${e.durationMs}ms`).join("  ") || "-"}`);

// ─── §2 Reservations ───────────────────────────────────────────────────────
const finalized = finalizeReservations(events);
const statuses = {};
for (const e of finalized) statuses[e.status || "?"] = (statuses[e.status || "?"] || 0) + 1;
const live = finalized.filter(isLive);
const rawFinalizedEvents = by(events, "reservation_finalized").length;

p(`\n[2] Reservations — ${rawFinalizedEvents} событий reservation_finalized → ${finalized.length} уникальных броней (append-only, считаем последний статус)`);
for (const [s, n] of Object.entries(statuses).sort((a, b) => b[1] - a[1])) {
  const meaning = STATUS_MEANING[s] || "";
  const bad = ["safe_mode_logged", "order_failed", "stale_discarded", "product_not_found"].includes(s);
  p(`    ${bad ? "✗" : " "} ${s.padEnd(20)} ${String(n).padStart(4)}${pct(n, finalized.length)}  ${meaning}`);
  if (bad) flag(`${s}: ${n} — ${meaning}`);
}
p(`\n    live positions (reserved + reserved_appended): ${live.length} в ${new Set(live.map((e) => e.orderId)).size} заказах`);
p(`    customer_order_created events: ${by(events, "customer_order_created").length}   customer_order_cancelled: ${by(events, "customer_order_cancelled").length}`);
// vk_comment пишется уже ВНУТРИ пути приёма брони, поэтому равен
// reservation_detected по построению и ничего не доказывает. Комментарии,
// отброшенные из-за отсутствия ключевого слова, не логируются нигде.
p(`    vk_comment=${by(events, "vk_comment").length}  reservation_detected=${by(events, "reservation_detected").length}  (одно и то же событие; отброшенные комментарии в логи не попадают вовсе)`);
const legacy = by(events, "reservation_accepted").length;
if (legacy) p(`    reservation_accepted (legacy, НЕ считать за бронь): ${legacy}`);

// §2.3 cancellations + no-open-lot — server.log only
const voiceCancels = byMessage(srv, "voice_cancel_command");
const cancelled = byMessage(srv, "reservation_cancelled");
const cancelNoPos = byMessage(srv, "reservation_cancel_no_position");
const cancelFailed = byMessage(srv, "reservation_cancel_failed");
const noOpenLot = byMessage(srv, "reservation_no_open_lot");
const floodEnded = byMessage(srv, "reservation_no_open_lot_flood_ended");
const suppressed = floodEnded.reduce((s, e) => s + (Number(e.suppressed) || 0), 0);
const attention = byMessage(srv, "attention_reservation_created");
p(`\n[2.3] Отмены и комментарии без лота (из server.log)`);
p(`    voice_cancel_command=${voiceCancels.length}  reservation_cancelled=${cancelled.length}  no_position=${cancelNoPos.length}  failed=${cancelFailed.length}`);
const unmatchedCancels = Math.max(0, voiceCancels.length - cancelled.length - cancelNoPos.length);
if (unmatchedCancels > 0) {
  p(`    ✗ отмен без результата: ~${unmatchedCancels} — лот был уже закрыт, приложение НИЧЕГО не сделало`);
  flag(`~${unmatchedCancels} голосовых отмен не выполнены (закрытый лот) — снимать позиции в МойСкладе вручную`);
}
if (cancelFailed.length) flag(`${cancelFailed.length} отмен упали с ошибкой (reservation_cancel_failed)`);
p(`    reservation_no_open_lot=${noOpenLot.length}  подавлено флуд-гардом=${suppressed}  attention_reservation_created=${attention.length}`);
if (noOpenLot.length + suppressed > 0 && attention.length === 0) {
  p(`    ⚠ ни одна строка «требует внимания» не была забронирована оператором`);
}

// ─── §3 Order structure ────────────────────────────────────────────────────
const orders = new Map();
for (const e of live) {
  const o = orders.get(e.orderId) || { viewerIds: new Set(), viewers: new Set(), products: new Set(), dup: 0 };
  if (o.products.has(e.productId)) o.dup++;
  o.products.add(e.productId); o.viewerIds.add(e.viewerId); o.viewers.add(e.viewerName);
  orders.set(e.orderId, o);
}
const multiBuyer = [...orders.entries()].filter(([, o]) => o.viewerIds.size > 1);
const dupPos = [...orders.values()].reduce((s, o) => s + o.dup, 0);
const notFound = finalized.filter((e) => e.status === "product_not_found");
const manualCodes = by(events, "manual_code_submitted");
const openedCodes = new Set(by(events, "lot_opened").map((e) => e.code));
const manualNoLot = manualCodes.filter((e) => !openedCodes.has(e.code));

p(`\n[3] Order structure`);
p(`    заказов с >1 покупателем: ${multiBuyer.length}   ${multiBuyer.length === 0 ? "✓" : "✗ ошибка группировки"}`);
for (const [id, o] of multiBuyer.slice(0, 5)) p(`       ! ${id}: ${[...o.viewers].join(", ")}`);
if (multiBuyer.length) flag(`${multiBuyer.length} заказов содержат позиции разных покупателей`);
p(`    дублей товара внутри заказа: ${dupPos}   ${dupPos === 0 ? "✓" : "✗ append-quantity не сработал"}`);
if (dupPos) flag(`${dupPos} дублирующихся позиций внутри заказов`);
p(`    product_not_found: ${notFound.length}   ${notFound.length === 0 ? "✓" : "✗ покупатели остались без заказа"}`);
const notFoundCodes = {};
for (const e of notFound) notFoundCodes[e.code] = (notFoundCodes[e.code] || 0) + 1;
if (notFound.length) p(`       коды: ${Object.entries(notFoundCodes).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([c, n]) => `${c}×${n}`).join(" ")}`);
p(`    manual_code_submitted: ${manualCodes.length}, из них без открытого лота: ${manualNoLot.length}${manualNoLot.length ? " ⚠" : ""}`);
if (manualNoLot.length) flag(`${manualNoLot.length} ручных кодов не открыли лот: ${[...new Set(manualNoLot.map((e) => e.code))].join(", ")}`);

// ─── §4 Pricing ────────────────────────────────────────────────────────────
const zeroPrice = live.filter((e) => !(Number(e.effectivePrice) > 0));
const mismatches = live.map((e) => ({ e, m: priceMismatch(e) })).filter((x) => x.m);
const discApplied = by(events, "discount_applied").length;
const discSkipped = by(events, "discount_skipped");
const invalidDiscount = byMessage(srv, "invalid_discount");
// lot_price_changed later than a finalized бронь of the same lot: the correction
// never reached the already-created position.
const firstFinalizeByLot = new Map();
for (const e of finalized) {
  const t = firstFinalizeByLot.get(e.lotSessionId);
  if (!t || String(e.ts) < String(t)) firstFinalizeByLot.set(e.lotSessionId, e.ts);
}
// A discount voiced after the first бронь of the lot is the same trap: applyDiscount
// only updates the lot and the VK card, never an already-created position.
const latePriceChanges = [...by(events, "lot_price_changed"), ...by(events, "discount_applied")]
  .filter((e) => firstFinalizeByLot.has(e.lotSessionId) && String(e.ts) > String(firstFinalizeByLot.get(e.lotSessionId)));

p(`\n[4] Pricing & discounts`);
p(`    позиций с ценой 0: ${zeroPrice.length}   ${zeroPrice.length === 0 ? "✓" : "⚠ читать транскрипт — цену скорее всего называли"}`);
for (const e of zeroPrice.slice(0, 20)) p(`       ⚠ ${e.code} ${e.viewerName} (order ${e.orderId})`);
if (zeroPrice.length) flag(`${zeroPrice.length} живых позиций с нулевой ценой`);
p(`    effectivePrice != salePrice − discountAmount: ${mismatches.length}   ${mismatches.length === 0 ? "✓" : "✗ математика скидки не сходится"}`);
for (const { e, m } of mismatches.slice(0, 10)) p(`       ! ${e.code} ${e.viewerName}: sale=${e.salePrice} disc=${e.discountAmount} → ожидали ${m.expected}, в логе ${m.actual}`);
if (mismatches.length) flag(`${mismatches.length} позиций с несходящейся скидкой`);
p(`    discount_applied=${discApplied}  discount_skipped=${discSkipped.length}  invalid_discount=${invalidDiscount.length}`);
const reasons = {};
for (const e of discSkipped) reasons[e.reason || "?"] = (reasons[e.reason || "?"] || 0) + 1;
for (const [r, n] of Object.entries(reasons)) p(`       skip: ${r}: ${n}`);
if (invalidDiscount.length) flag(`${invalidDiscount.length} невалидных скидок отброшено (invalid_discount)`);
p(`    цена/скидка изменены ПОСЛЕ первой брони лота: ${latePriceChanges.length}${latePriceChanges.length ? " ⚠ правка не дошла до уже созданных позиций" : ""}`);
for (const e of latePriceChanges.slice(0, 10)) p(`       ⚠ ${e.ts} ${e.kind} lot=${e.code || e.lotSessionId} → ${e.newPrice ?? e.price ?? e.salePrice ?? "?"}`);
if (latePriceChanges.length) flag(`правок цены/скидки после создания позиции: ${latePriceChanges.length} — в МойСклад они не попали`);

// ─── §5/§6 Waitlist & wishlist ─────────────────────────────────────────────
const wlPending = by(events, "reservation_waitlist_pending").length;
const wlPromoted = by(events, "waitlist_promoted").length;
const orphanWaitlist = by(events, "orphan_waitlist").length;
const oos = finalized.filter((e) => e.status === "out_of_stock");
const wishAdded = wishlistEvents.filter((e) => e.kind === "added" && inWindow(e, win));
const wishFromFailure = wishAdded.filter((e) => e.trigger === "order_failed");
const wishNoSupplier = wishAdded.filter((e) => !e.supplierName);

p(`\n[5] Waitlist`);
p(`    pending=${wlPending}  promoted=${wlPromoted}   ${wlPending === wlPromoted ? "✓ все продвинуты" : "⚠ остались непродвинутые"}`);
if (wlPending !== wlPromoted) flag(`waitlist: ${wlPending} в очереди vs ${wlPromoted} продвинуто`);
p(`    orphan_waitlist=${orphanWaitlist}${orphanWaitlist ? " ✗ очередь без лота" : ""}`);
if (orphanWaitlist) flag(`${orphanWaitlist} orphan_waitlist — очередь без лота`);

p(`\n[6] Wishlist  (источник: wishlist/events.jsonl, окно эфира)`);
p(`    out_of_stock=${oos.length}  wishlist added=${wishAdded.length}   ${oos.length <= wishAdded.length ? "✓" : "✗ часть OOS не попала в wish list"}`);
if (oos.length > wishAdded.length) flag(`${oos.length - wishAdded.length} OOS-броней без записи в wish list`);
p(`    из них added с trigger=order_failed: ${wishFromFailure.length}${wishFromFailure.length ? " ✗ это не overflow, это упавшие заказы" : ""}`);
if (wishFromFailure.length) flag(`${wishFromFailure.length} записей wish list с trigger=order_failed`);
p(`    без supplierName: ${wishNoSupplier.length}${wishNoSupplier.length ? " ⚠ Заказ поставщику потребует ручного поставщика" : ""}`);

// ─── §7 Stock ──────────────────────────────────────────────────────────────
const stockUnknown = finalized.filter((e) => e.stockUnknown === true || e.availableStock === null);
const lotsUnknownStock = by(events, "lot_opened").filter((e) => e.availableStock === null || e.availableStock === undefined);
p(`\n[7] Stock safety`);
p(`    лотов открыто с неизвестным остатком: ${lotsUnknownStock.length} из ${by(events, "lot_opened").length}`);
p(`    броней с stockUnknown/availableStock=null: ${stockUnknown.length}${stockUnknown.length ? " ⚠ кандидаты на перебронь" : ""}`);
for (const e of stockUnknown.filter(isLive).slice(0, 15)) p(`       ⚠ ${e.code} ${e.viewerName} qty=${e.quantity}`);
if (stockUnknown.filter(isLive).length) flag(`${stockUnknown.filter(isLive).length} живых броней по лотам с неизвестным остатком — проверить find-overbooked.js`);

// ─── Summary ───────────────────────────────────────────────────────────────
p("\n" + "═".repeat(72));
if (flags.length === 0) {
  p("✓ Структурных красных флагов нет.");
} else {
  p(`✗ КРАСНЫЕ ФЛАГИ (${flags.length}):`);
  for (const f of flags) p(`   • ${f}`);
}
p("\nЭто самоотчёт приложения. Заказы, цены и снятые брони в МойСкладе он НЕ проверяет:");
p("  node scripts/verify-broadcast-against-moysklad.mjs <bundle> --date <YYYY-MM-DD>");
p("═".repeat(72));

if (asJson) {
  console.log(JSON.stringify({
    date, sessions: sessions.length, events: events.length,
    moysklad: { calls: msCalls.length, errors: msErrors.length, httpStatuses, retried: msRetried.length },
    reservations: { rawEvents: rawFinalizedEvents, unique: finalized.length, statuses, live: live.length, orders: orders.size },
    cancels: { voice: voiceCancels.length, done: cancelled.length, noPosition: cancelNoPos.length, failed: cancelFailed.length, unmatched: unmatchedCancels },
    noOpenLot: { logged: noOpenLot.length, suppressed, attentionCreated: attention.length },
    pricing: { zero: zeroPrice.length, mismatched: mismatches.length, discountApplied: discApplied, discountSkipped: discSkipped.length, invalidDiscount: invalidDiscount.length, latePriceChanges: latePriceChanges.length },
    waitlist: { pending: wlPending, promoted: wlPromoted, orphan: orphanWaitlist },
    wishlist: { outOfStock: oos.length, added: wishAdded.length, fromOrderFailed: wishFromFailure.length },
    stock: { lotsUnknown: lotsUnknownStock.length, reservationsUnknown: stockUnknown.length },
    flags,
  }, null, 2));
}
process.exitCode = flags.length ? 1 : 0;
