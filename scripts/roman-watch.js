// Block until Roman sends a new incoming VK message past a baseline id, then
// print it and exit (which re-invokes the agent). Exits with TIMEOUT after the
// max wait so it never hangs forever.
//
//   node scripts/roman-watch.js <baselineId> [intervalSec] [maxMinutes]
import dotenv from "dotenv";

dotenv.config();

const TOKEN = process.env.VK_GROUP_TOKEN || "";
const API_VERSION = process.env.VK_API_VERSION || "5.199";
// Только из env: репозиторий публичный, VK id человека в коде не хардкодим.
const PEER = (process.env.ROMAN_VK_ID || "").trim();

const baseline = Number.parseInt(process.argv[2] || "0", 10);
const intervalMs = Number.parseInt(process.argv[3] || "30", 10) * 1000;
const maxMs = Number.parseFloat(process.argv[4] || "30") * 60 * 1000;

if (!TOKEN || !/^\d+$/.test(PEER)) {
  console.error("VK_GROUP_TOKEN and/or ROMAN_VK_ID missing in .env");
  process.exit(1);
}
// parseInt("abc") → NaN: фильтр `m.id > NaN` всегда false, и скрипт молча
// провисел бы весь maxMinutes до TIMEOUT вместо ошибки сразу.
if (!Number.isFinite(baseline) || !Number.isFinite(intervalMs) || !Number.isFinite(maxMs)) {
  console.error("usage: node scripts/roman-watch.js <baselineId> [intervalSec] [maxMinutes] — numeric args");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll() {
  // Токен — в теле POST, не в query string (не светим в логах).
  const body = new URLSearchParams({
    peer_id: PEER,
    count: "10",
    access_token: TOKEN,
    v: API_VERSION,
  });
  const j = await (await fetch("https://api.vk.com/method/messages.getHistory", { method: "POST", body })).json();
  if (j.error) throw new Error(`VK ${j.error.error_code}: ${j.error.error_msg}`);
  return (j.response.items || []).filter((m) => m.id > baseline && m.out === 0);
}

const started = Date.now();
while (Date.now() - started < maxMs) {
  try {
    const fresh = await poll();
    if (fresh.length) {
      for (const m of fresh.reverse()) {
        console.log(`NEW id=${m.id} from ${m.from_id}: ${m.text || "(вложение без текста)"}`);
      }
      process.exit(0);
    }
  } catch (e) {
    console.error("poll error:", e.message);
  }
  await sleep(intervalMs);
}
console.log("TIMEOUT: no new message from Roman");
