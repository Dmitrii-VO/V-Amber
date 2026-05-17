import "dotenv/config";

const login = process.env.MOYSKLAD_LOGIN;
const password = process.env.MOYSKLAD_PASSWORD;
const baseUrl = (process.env.MOYSKLAD_BASE_URL?.trim() || "https://api.moysklad.ru/api/remap/1.2/").replace(/\/$/, "");
const auth = "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
const headers = { Authorization: auth, Accept: "application/json;charset=utf-8" };

const PAGE = 1000;
let offset = 0;
let total = 0;
const overbooked = [];

console.log("Scanning stock report (this might take ~30s)…");

while (true) {
  const url = `${baseUrl}/report/stock/all?limit=${PAGE}&offset=${offset}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error("HTTP", res.status, await res.text());
    process.exit(1);
  }
  const data = await res.json();
  const rows = data.rows || [];
  if (rows.length === 0) break;
  for (const row of rows) {
    total++;
    const stock = Number(row.stock || 0);
    const reserve = Number(row.reserve || 0);
    const available = Number(row.quantity != null ? row.quantity : stock - reserve);
    if (available < 0) {
      overbooked.push({
        name: row.name,
        code: row.code,
        stock,
        reserve,
        available,
      });
    }
  }
  offset += rows.length;
  if (rows.length < PAGE) break;
}

overbooked.sort((a, b) => a.available - b.available);

console.log("Всего товаров в МойСклад:", total);
console.log("Overbooked (доступно < 0):", overbooked.length);
console.log("");
console.log("Top-30 (самые большие минусы):");
console.log("код        | остаток | резерв | доступно | название");
console.log("-----------+---------+--------+----------+--------------------------------------");
for (const o of overbooked.slice(0, 30)) {
  const name = String(o.name || "").slice(0, 50);
  console.log(`${String(o.code || "").padEnd(10)} | ${String(o.stock).padStart(7)} | ${String(o.reserve).padStart(6)} | ${String(o.available).padStart(8)} | ${name}`);
}
