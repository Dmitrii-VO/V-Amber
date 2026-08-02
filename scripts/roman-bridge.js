// Roman support bridge: read incoming VK DMs from the operator and send replies
// via the community token. Read-only by default; sending requires an explicit
// `send` subcommand so nothing goes out without a deliberate call.
//
//   node scripts/roman-bridge.js read [count]     # print recent messages
//   node scripts/roman-bridge.js send "text..."   # DM Roman as the community
//
// Peer id приходит ТОЛЬКО из env (ROMAN_VK_ID): репозиторий публичный,
// реальный VK id человека в коде не хардкодим.
import dotenv from "dotenv";

dotenv.config();

const TOKEN = process.env.VK_GROUP_TOKEN || "";
const API_VERSION = process.env.VK_API_VERSION || "5.199";
const PEER = (process.env.ROMAN_VK_ID || "").trim();

async function vk(method, params) {
  // Токен и параметры — в теле POST, не в query string (не светим в логах).
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") body.set(k, String(v));
  }
  body.set("access_token", TOKEN);
  body.set("v", API_VERSION);
  const res = await fetch(`https://api.vk.com/method/${method}`, { method: "POST", body });
  const json = await res.json();
  if (json.error) {
    throw new Error(`VK ${json.error.error_code}: ${json.error.error_msg}`);
  }
  return json.response;
}

async function read(count) {
  const resp = await vk("messages.getHistory", { peer_id: PEER, count });
  for (const m of (resp.items || []).slice().reverse()) {
    const who = m.out ? "БОТ" : "РОМАН";
    const when = new Date(m.date * 1000).toISOString().replace("T", " ").slice(0, 16);
    console.log(`[${when}] ${who}: ${m.text || "(вложение без текста)"}`);
  }
}

async function send(text) {
  if (!text) throw new Error("empty message");
  const id = await vk("messages.send", {
    user_id: PEER,
    message: text,
    random_id: Date.now(),
  });
  console.log("sent, message_id:", id);
}

const [cmd, arg] = process.argv.slice(2);
if (!TOKEN) {
  console.error("VK_GROUP_TOKEN missing in .env");
  process.exit(1);
}
if (!/^\d+$/.test(PEER)) {
  console.error("ROMAN_VK_ID missing/invalid in .env (numeric VK user id)");
  process.exit(1);
}

if (cmd === "read") {
  await read(Number.parseInt(arg || "10", 10));
} else if (cmd === "send") {
  await send(arg);
} else {
  console.error('usage: node scripts/roman-bridge.js read [count] | send "text"');
  process.exit(1);
}
