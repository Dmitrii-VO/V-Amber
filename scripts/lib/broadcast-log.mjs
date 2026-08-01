// Shared read-only parser for эфир diagnostic bundles.
//
// Both scripts/analyze-broadcast-logs.mjs (log-only health) and
// scripts/verify-broadcast-against-moysklad.mjs (log ↔ MoySklad diff) build on
// this so they can never disagree about what "a live position" is.
//
// The contract it encodes, and why each rule exists, is documented in
// knowledge/wiki/log-verification-checklist.md.
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Input collection
// ---------------------------------------------------------------------------

// Accepts any mix of: a bundle directory, a sessions/ directory, individual
// .jsonl files. `date` (YYYY-MM-DD) filters session files by their filename
// prefix — one эфир usually spans several files because every reconnect starts
// a new session log.
export function collectInputs(args, { date } = {}) {
  const sessionFiles = [];
  const serverLogFiles = [];
  let metaPath = null;

  const addSessionsDir = (dir) => {
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith(".jsonl")) continue;
      if (date && !f.startsWith(date)) continue;
      sessionFiles.push(path.join(dir, f));
    }
  };
  const addServerLogsIn = (dir) => {
    for (const f of fs.readdirSync(dir).sort()) {
      if (/^server\.log(\.\d+)?$/.test(f)) serverLogFiles.push(path.join(dir, f));
    }
  };

  for (const a of args) {
    const st = fs.statSync(a);
    if (st.isDirectory()) {
      const sessions = path.join(a, "sessions");
      if (fs.existsSync(sessions)) addSessionsDir(sessions);
      else addSessionsDir(a);
      addServerLogsIn(a);
      const meta = path.join(a, "meta.json");
      if (fs.existsSync(meta)) metaPath = meta;
      continue;
    }
    if (a.endsWith(".jsonl")) {
      if (date && !path.basename(a).startsWith(date)) continue;
      sessionFiles.push(a);
      // A bare .jsonl still lets us find server.log next to sessions/.
      const bundleRoot = path.dirname(path.dirname(a));
      if (fs.existsSync(bundleRoot)) {
        addServerLogsIn(bundleRoot);
        const meta = path.join(bundleRoot, "meta.json");
        if (fs.existsSync(meta) && !metaPath) metaPath = meta;
      }
    }
  }
  return {
    sessionFiles: [...new Set(sessionFiles)],
    serverLogFiles: [...new Set(serverLogFiles)],
    metaPath,
  };
}

function readJsonLines(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* truncated bundle tail */ }
  }
  return out;
}

// server.log records are {ts, level, component, message, meta}. Flattened here
// so callers can treat them like session events.
function readServerLog(file) {
  return readJsonLines(file).map((r) => ({
    ts: r.ts,
    level: r.level,
    component: r.component,
    message: r.message,
    ...(r.meta || {}),
  }));
}

export function loadBundle(args, { date } = {}) {
  const { sessionFiles, serverLogFiles, metaPath } = collectInputs(args, { date });
  if (sessionFiles.length === 0) {
    throw new Error(`No session .jsonl files found${date ? ` for date ${date}` : ""}.`);
  }
  const sessions = sessionFiles.map((file) => ({ file, events: readJsonLines(file) }));
  const events = sessions.flatMap((s) => s.events);
  const serverEvents = serverLogFiles.flatMap(readServerLog);
  const meta = metaPath ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : null;
  // Wish list additions live in their own store, NOT in the session jsonl — the
  // session stream carries only a stray subset, so counting `added` there
  // under-reports overflow buyers.
  const wishlistFile = metaPath ? path.join(path.dirname(metaPath), "wishlist", "events.jsonl") : null;
  const wishlistEvents = wishlistFile && fs.existsSync(wishlistFile) ? readJsonLines(wishlistFile) : [];
  return { sessions, events, serverEvents, serverLogFiles, wishlistEvents, meta };
}

// ---------------------------------------------------------------------------
// Domain rules
// ---------------------------------------------------------------------------

// Must match reservationKey() in server/bundle-index.js, or our counts disagree
// with the INDEX.md the operator is looking at.
export const reservationKey = (r) =>
  [r.lotSessionId, r.commentId, r.viewerId, r.positionId].map((v) => v ?? "").join("|");

export const LIVE_STATUSES = new Set(["reserved", "reserved_appended"]);

export const STATUS_MEANING = {
  reserved: "новый заказ создан",
  reserved_appended: "позиция дописана в существующий заказ",
  cancelled: "бронь снята",
  waitlist_pending: "в очереди на товар",
  out_of_stock: "нет в наличии → wish list",
  product_not_found: "артикул не найден в каталоге — покупателю ничего не досталось",
  safe_mode_logged: "SAFE MODE: в МойСклад не записано НИЧЕГО",
  order_failed: "запись в МойСклад упала, спрос ушёл в wish list",
  stale_discarded: "запись в МойСклад ПРОШЛА, приложение результат выбросило",
};

// reservation_finalized is append-only: cancelling re-finalizes the same бронь
// with status "cancelled". Counting raw events double-counts. Keep the latest
// event per stable key.
export function finalizeReservations(events) {
  const latest = new Map();
  for (const e of events) {
    if (e.kind !== "reservation_finalized") continue;
    const k = reservationKey(e);
    const prev = latest.get(k);
    if (!prev || String(e.ts) >= String(prev.ts)) latest.set(k, e);
  }
  return [...latest.values()];
}

export const isLive = (e) => LIVE_STATUSES.has(e.status);

// max(0, salePrice - discountAmount) — the formula processReservationEvent uses.
export function expectedEffectivePrice(e) {
  const sale = Number(e.salePrice || 0);
  const disc = Number(e.discountAmount || 0);
  return Math.max(0, Math.round((sale - disc) * 100) / 100);
}

export function priceMismatch(e) {
  const expected = expectedEffectivePrice(e);
  const actual = Number(e.effectivePrice ?? NaN);
  if (!Number.isFinite(actual)) return null;
  return Math.abs(actual - expected) > 0.005 ? { expected, actual } : null;
}

export const by = (events, kind) => events.filter((e) => e.kind === kind);
export const byMessage = (serverEvents, message) => serverEvents.filter((e) => e.message === message);

// Broadcast dates present in the loaded sessions, newest last.
export function broadcastDates(events) {
  const days = new Set();
  for (const e of events) if (typeof e.ts === "string") days.add(e.ts.slice(0, 10));
  return [...days].sort();
}

// Restrict server.log (which spans weeks) to the window actually covered by the
// loaded session files, so cancellation checks do not drag in other эфиры.
export function windowOf(events) {
  let from = null;
  let to = null;
  for (const e of events) {
    if (typeof e.ts !== "string") continue;
    if (from === null || e.ts < from) from = e.ts;
    if (to === null || e.ts > to) to = e.ts;
  }
  return { from, to };
}

export function inWindow(e, { from, to }) {
  return typeof e.ts === "string" && (!from || e.ts >= from) && (!to || e.ts <= to);
}
