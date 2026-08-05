#!/usr/bin/env node
// Проверка, как МойСклад обращается с syncId у закупочного заказа.
//
// Зачем: защита от дубля закупочного заказа опирается на два свойства —
//   (1) POST entity/purchaseorder принимает поле syncId;
//   (2) GET entity/purchaseorder?filter=syncId=<uuid> находит по нему заказ.
// Отдельным бонусом было (3): повторный POST с тем же syncId обновляет
// существующий заказ вместо создания второго.
//
// РЕЗУЛЬТАТ ПРОГОНА 2026-08-05 на рабочем аккаунте: все три подтверждены.
// Повторный POST вернул id и name первого заказа, filter=syncId нашёл ровно
// один. То есть syncId — настоящий ключ идемпотентности. Скрипт оставлен,
// чтобы перепроверить, если МойСклад поменяет поведение.
//
// Запускать там, где api.moysklad.ru доступен. С машины разработчика хост
// недоступен по сети; проверка 2026-08-05 шла через SSH-туннель на машину,
// у которой доступ есть:
//
//   ssh -N -L 18443:api.moysklad.ru:443 <хост-с-доступом>
//
// и запросы с --connect-to api.moysklad.ru:443:127.0.0.1:18443 — так ключи
// МойСклада не покидают локальную машину. Учтите два требования API: заголовок
// Accept-Encoding: gzip обязателен (иначе nginx отдаёт 415), а тело запроса
// нужно слать как есть, без переформатирования (иначе ошибка 2001).
//
//   node scripts/probe-moysklad-syncid.mjs                 # только чтение
//   node scripts/probe-moysklad-syncid.mjs --write-test    # + создаст ДВА POST
//
// --write-test создаёт настоящий закупочный заказ в рабочем МойСкладе и
// повторяет POST с тем же syncId. Заказ придётся удалить руками; его описание
// начинается с «V-AMBER SYNCID PROBE», чтобы его нельзя было спутать с
// боевым. Без флага скрипт ничего не пишет.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDeterministicUuid, V_AMBER_UUID_NAMESPACE } from "../server/moysklad-helpers.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const writeTest = process.argv.includes("--write-test");

const env = Object.fromEntries(
  readFileSync(join(repoRoot, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

const baseUrl = (env.MOYSKLAD_BASE_URL || "https://api.moysklad.ru/api/remap/1.2/").replace(/\/$/, "");
const auth = "Basic " + Buffer.from(`${env.MOYSKLAD_LOGIN}:${env.MOYSKLAD_PASSWORD}`).toString("base64");
const headers = { Authorization: auth, Accept: "application/json;charset=utf-8" };

async function call(method, path, { params, body } = {}) {
  const url = new URL(path, baseUrl + "/");
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const response = await fetch(url, {
    method,
    headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: response.status, json, text: text.slice(0, 500) };
}

function verdict(ok, label) {
  console.log(`${ok ? "  ДА " : "  НЕТ"}  ${label}`);
}

console.log(`МойСклад: ${baseUrl}`);
console.log(`Режим: ${writeTest ? "чтение + ЗАПИСЬ (создаст заказ!)" : "только чтение"}\n`);

// --- 1. Есть ли syncId у существующих закупочных заказов ---
const list = await call("GET", "entity/purchaseorder", { params: { limit: "10", order: "moment,desc" } });
console.log(`[1] GET entity/purchaseorder → ${list.status}`);
if (list.json?.rows) {
  const withSyncId = list.json.rows.filter((row) => row.syncId);
  console.log(`    заказов: ${list.json.rows.length}, из них с syncId: ${withSyncId.length}`);
  for (const row of withSyncId.slice(0, 3)) console.log(`    · ${row.name} → ${row.syncId}`);
} else {
  console.log(`    ${list.text}`);
}

// --- 2. Работает ли фильтр по syncId (на этом держится сверка) ---
const probeUuid = buildDeterministicUuid(V_AMBER_UUID_NAMESPACE, "probe::" + new Date().toISOString());
const filtered = await call("GET", "entity/purchaseorder", { params: { filter: `syncId=${probeUuid}` } });
console.log(`\n[2] GET entity/purchaseorder?filter=syncId=… → ${filtered.status}`);
const filterWorks = filtered.status === 200 && Array.isArray(filtered.json?.rows);
verdict(filterWorks, "фильтр по syncId поддерживается");
if (!filterWorks) console.log(`    ${JSON.stringify(filtered.json?.errors || filtered.text)}`);

if (!writeTest) {
  console.log("\n[3] POST не проверялся. Повторите с --write-test, чтобы проверить,");
  console.log("    принимает ли POST поле syncId и обновляет ли повторный POST заказ.");
  process.exit(0);
}

// --- 3. Принимает ли POST syncId и что делает повторный POST ---
const defaultsOrg = env.MOYSKLAD_ORGANIZATION_ID;
const suppliers = await call("GET", "entity/counterparty", { params: { limit: "1" } });
const agentId = suppliers.json?.rows?.[0]?.id;
if (!defaultsOrg || !agentId) {
  console.log("\n[3] Пропущено: не удалось определить организацию или контрагента.");
  process.exit(1);
}

const syncId = buildDeterministicUuid(V_AMBER_UUID_NAMESPACE, "probe-write::" + new Date().toISOString());
const meta = (entity, id) => ({
  meta: { href: `${baseUrl}/entity/${entity}/${id}`, type: entity, mediaType: "application/json" },
});
const payload = {
  organization: meta("organization", defaultsOrg),
  agent: meta("counterparty", agentId),
  description: `V-AMBER SYNCID PROBE ${new Date().toISOString()} — тестовый заказ, удалить`,
  syncId,
  positions: [],
};

const first = await call("POST", "entity/purchaseorder", { body: payload });
console.log(`\n[3] POST #1 → ${first.status}`);
verdict(first.status === 200 && Boolean(first.json?.id), "POST принимает syncId");
if (first.status !== 200) {
  console.log(`    ${JSON.stringify(first.json?.errors || first.text)}`);
  process.exit(1);
}
console.log(`    создан ${first.json.name} (${first.json.id}), syncId=${first.json.syncId}`);

const second = await call("POST", "entity/purchaseorder", { body: payload });
console.log(`\n[4] POST #2 с тем же syncId → ${second.status}`);
if (second.status === 200 && second.json?.id === first.json.id) {
  verdict(true, "повторный POST ОБНОВИЛ тот же заказ — syncId работает как ключ идемпотентности");
} else if (second.status === 200) {
  verdict(false, `повторный POST создал ВТОРОЙ заказ (${second.json?.id}) — syncId ключом идемпотентности не является`);
} else {
  verdict(false, `повторный POST отклонён: ${JSON.stringify(second.json?.errors || second.text)}`);
  console.log("    (отказ по дублю syncId тоже годится: дубль на стороне МойСклада невозможен)");
}

console.log("\nУдалите тестовые заказы с описанием «V-AMBER SYNCID PROBE» вручную.");
