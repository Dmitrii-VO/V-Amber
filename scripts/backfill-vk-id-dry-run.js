import "dotenv/config";

const login = process.env.MOYSKLAD_LOGIN;
const password = process.env.MOYSKLAD_PASSWORD;
const baseUrl = (process.env.MOYSKLAD_BASE_URL?.trim() || "https://api.moysklad.ru/api/remap/1.2/").replace(/\/$/, "");
const auth = "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
const headers = { Authorization: auth, Accept: "application/json;charset=utf-8" };

const metaRes = await fetch(`${baseUrl}/entity/counterparty/metadata/attributes`, { headers });
const meta = await metaRes.json();
const vkAttr = (meta.rows || []).find((a) => a.name === "VK ID");
if (!vkAttr) {
  console.log("VK ID attribute not found. Available:", (meta.rows || []).map((a) => a.name));
  process.exit(1);
}
console.log("VK ID attribute id:", vkAttr.id);
console.log("---");

const PAGE = 1000;
let offset = 0;
let total = 0;
const filled = []; // { id, name, viewerId } — VK ID attribute already set
const candidates = []; // { id, name, viewerId } — empty attribute, viewerId in description
let emptyNoMarker = 0;

while (true) {
  const url = `${baseUrl}/entity/counterparty?limit=${PAGE}&offset=${offset}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.log("HTTP", res.status, await res.text());
    process.exit(1);
  }
  const data = await res.json();
  const rows = data.rows || [];
  if (rows.length === 0) break;
  for (const c of rows) {
    total++;
    const attrValue = (c.attributes || []).find((a) => a.id === vkAttr.id)?.value;
    if (attrValue) {
      filled.push({ id: c.id, name: c.name, viewerId: String(attrValue) });
      continue;
    }
    const m = /viewerId=(\d+)/.exec(c.description || "");
    if (m) {
      candidates.push({ id: c.id, name: c.name, viewerId: m[1] });
    } else if ((c.description || "").includes("VK") || (c.name || "").startsWith("VK:")) {
      emptyNoMarker++;
    }
  }
  offset += rows.length;
  if (offset >= (data.meta?.size || 0)) break;
}
const withVkAttr = filled.length;

console.log("Всего контрагентов в МойСклад:", total);
console.log("Уже с заполненным атрибутом VK ID:", withVkAttr);
console.log("Кандидаты на backfill (атрибут пуст + viewerId= в description):", candidates.length);
console.log("Пустой атрибут, нет viewerId, но похоже на VK-контрагента:", emptyNoMarker);

// Build cross-set duplicate detection: by viewerId across BOTH filled and candidates.
const byViewerId = new Map();
for (const c of filled) {
  if (!byViewerId.has(c.viewerId)) byViewerId.set(c.viewerId, []);
  byViewerId.get(c.viewerId).push({ ...c, source: "attribute" });
}
for (const c of candidates) {
  if (!byViewerId.has(c.viewerId)) byViewerId.set(c.viewerId, []);
  byViewerId.get(c.viewerId).push({ ...c, source: "description" });
}
const dupGroups = [...byViewerId.entries()].filter(([, list]) => list.length > 1);
const extraToMerge = dupGroups.reduce((acc, [, list]) => acc + list.length - 1, 0);
console.log("Группы дубликатов по viewerId (filled + candidates):", dupGroups.length, "| лишних записей:", extraToMerge);

if (dupGroups.length > 0) {
  console.log("---");
  console.log("ВСЕ группы дубликатов:");
  for (const [vid, list] of dupGroups) {
    console.log(`  viewerId=${vid}:`);
    for (const c of list) console.log(`    - [${c.source}] ${c.name}  (${c.id})`);
  }
}

console.log("---");
console.log("Примеры кандидатов на backfill (первые 10):");
for (const c of candidates.slice(0, 10)) {
  console.log(`  viewerId=${c.viewerId.padStart(12)}  |  ${c.name}  |  ${c.id}`);
}
console.log("---");
console.log("DRY RUN — никаких изменений не сделано.");
