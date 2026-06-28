// Fix customer-order positions that were written to MoySklad with price 0 because
// the operator announced the price/discount by voice but it never landed on the
// order (spoken before the lot opened, or after the reservation was already
// finalized, or a discount % with no base price). See the эфир 2026-06-28 review
// and knowledge/wiki/log-verification-checklist.md.
//
// Default is DRY-RUN: it reads each position from MoySklad and prints the current
// price + the intended price. Add --execute to PUT the corrected prices.
//
// USAGE (from repo root):
//   node scripts/fix-zero-price-positions.mjs
//   node scripts/fix-zero-price-positions.mjs --execute
import "dotenv/config";

const EXECUTE = process.argv.includes("--execute");

// priceRub = the price the BUYER pays (already discounted), reconstructed from the
// эфир transcript. null = could not be reconstructed (no base price spoken) → skip.
const FIXES = [
  { code: "03081", viewer: "Елена Ушакова",   orderId: "fa299a77-731e-11f1-0a80-1ff00062702a", positionId: "9fb7ac22-7322-11f1-0a80-07770063ccce", priceRub: 3828.0,  note: "5890 −35% (система посчитала 3828)" },
  { code: "03059", viewer: "Марго Краснова",  orderId: "7c57089c-730e-11f1-0a80-0c52005fbad4", positionId: "d164eb23-7321-11f1-0a80-113c0063ec17", priceRub: 1487.5, note: "1750 −15%" },
  { code: "03082", viewer: "Марина Балашова", orderId: "7a8eb673-7320-11f1-0a80-1da6006474ee", positionId: "ec01de89-7323-11f1-0a80-1ff000631acc", priceRub: 1470.0,  note: "1470 (без скидки)" },
  { code: "03082", viewer: "Галина Трефилова",orderId: "2f614ce3-7310-11f1-0a80-089b005fd1f6", positionId: "14015554-7324-11f1-0a80-00c000633cc0", priceRub: 1470.0,  note: "1470 (без скидки)" },
  { code: "03172", viewer: "Ирина Плаксина",  orderId: "d631724c-7313-11f1-0a80-1ff000608e61", positionId: "d6317827-7313-11f1-0a80-1ff000608e62", priceRub: null,    note: "озвучена только скидка −35%, базовая цена не названа" },
];

const baseUrl = (process.env.MOYSKLAD_BASE_URL?.trim() || "https://api.moysklad.ru/api/remap/1.2/").replace(/\/$/, "");
if (!process.env.MOYSKLAD_LOGIN || !process.env.MOYSKLAD_PASSWORD) { console.error("MoySklad creds missing in .env"); process.exit(1); }
const headers = { Authorization: "Basic " + Buffer.from(`${process.env.MOYSKLAD_LOGIN}:${process.env.MOYSKLAD_PASSWORD}`).toString("base64"), Accept: "application/json;charset=utf-8" };

async function req(method, path, body) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${baseUrl}/${path}`, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await new Promise(x => setTimeout(x, 1000 * (i + 1))); continue; }
    if (r.status === 404) return { __404: true };
    if (!r.ok) throw new Error(`${r.status} ${method} ${path}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }
  throw new Error("429 " + path);
}

console.log(`MODE: ${EXECUTE ? "EXECUTE (will PUT prices)" : "DRY-RUN (read-only)"}\n`);
let toFix = 0, skipped = 0, fixed = 0;
for (const f of FIXES) {
  const pos = await req("GET", `entity/customerorder/${f.orderId}/positions/${f.positionId}`);
  if (pos.__404) { console.log(`  ✗ ${f.code} ${f.viewer}: position NOT FOUND in MoySklad (order/position cancelled?) — skip`); skipped++; continue; }
  const curRub = (pos.price || 0) / 100;
  const qty = pos.quantity;
  const tag = `${f.code} ${f.viewer}`;
  if (f.priceRub == null) { console.log(`  ⚠ ${tag}: current=${curRub}₽ qty=${qty} — НЕ исправляю (${f.note})`); skipped++; continue; }
  if (curRub !== 0) { console.log(`  • ${tag}: current=${curRub}₽ qty=${qty} — already non-zero, leaving as is`); skipped++; continue; }
  console.log(`  → ${tag}: current=${curRub}₽ qty=${qty}  =>  set ${f.priceRub}₽   [${f.note}]`);
  toFix++;
  if (EXECUTE) {
    await req("PUT", `entity/customerorder/${f.orderId}/positions/${f.positionId}`, { price: Math.round(f.priceRub * 100) });
    fixed++;
    await new Promise(x => setTimeout(x, 200));
  }
}
console.log(`\n${EXECUTE ? `Fixed ${fixed} position(s).` : `Would fix ${toFix} position(s).`} Skipped ${skipped}.`);
if (!EXECUTE) console.log("Re-run with --execute to apply.");
