import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStreamRelay } from "../server/stream-relay.js";

// Дубль эфира в ВК: ffmpeg-релей MediaMTX→ВК. Проверяем построение команды,
// перезапуск при неожиданном выходе (ограниченный), остановку и guard'ы.
// Свой поток идёт напрямую — тут только вторичный VK-канал.

const silentLog = { info() {}, warn() {}, error() {} };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Ждём условие, опрашивая до таймаута — устойчивее фиксированной паузы под
// нагрузкой параллельного тест-раннера (таймеры перезапуска могут задержаться).
async function waitFor(cond, { timeoutMs = 1000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await delay(stepMs);
  }
  return cond();
}

function makeFakeSpawn() {
  const spawned = [];
  function spawn(cmd, args, opts) {
    const child = new EventEmitter();
    Object.assign(child, { cmd, args, opts, killed: false });
    child.kill = (signal) => { child.killed = true; child.killSignal = signal; };
    child.stderr = new EventEmitter();
    spawned.push(child);
    return child;
  }
  spawn.spawned = spawned;
  return spawn;
}

const CFG = {
  relaySourceUrl: "rtmp://src:1935/live",
  vkTargetUrl: "rtmp://vk-ingest/app/streamkey",
  ffmpegPath: "ffmpeg",
  relayRestartMax: 2,
  relayRestartDelayMs: 5,
};

test("start строит ffmpeg-команду MediaMTX→ВК с -c copy -f flv", () => {
  const spawn = makeFakeSpawn();
  const relay = createStreamRelay({ streamConfig: CFG, spawnImpl: spawn, log: silentLog });
  const res = relay.start();
  assert.equal(res.ok, true);
  assert.equal(spawn.spawned.length, 1);
  const { cmd, args } = spawn.spawned[0];
  assert.equal(cmd, "ffmpeg");
  const i = args.indexOf("-i");
  assert.equal(args[i + 1], "rtmp://src:1935/live");
  assert.equal(args[args.length - 1], "rtmp://vk-ingest/app/streamkey");
  assert.ok(args.includes("copy"));
  assert.ok(args.includes("flv"));
  assert.equal(relay.status().state, "running");
  relay.stop();
});

test("не настроен без источника/цели", () => {
  const spawn = makeFakeSpawn();
  const relay = createStreamRelay({ streamConfig: { relaySourceUrl: "", vkTargetUrl: "" }, spawnImpl: spawn, log: silentLog });
  assert.equal(relay.isConfigured(), false);
  const res = relay.start();
  assert.equal(res.ok, false);
  assert.equal(res.code, "not_configured");
  assert.equal(spawn.spawned.length, 0);
});

test("неожиданный выход перезапускает релей (ограниченно)", async () => {
  const spawn = makeFakeSpawn();
  const relay = createStreamRelay({ streamConfig: CFG, spawnImpl: spawn, log: silentLog });
  relay.start();
  assert.equal(spawn.spawned.length, 1);

  spawn.spawned[0].emit("exit", 1, null);
  assert.equal(relay.status().state, "error");
  assert.ok(await waitFor(() => spawn.spawned.length === 2), "должен перезапуститься (1)");

  spawn.spawned[1].emit("exit", 1, null);
  assert.ok(await waitFor(() => spawn.spawned.length === 3), "должен перезапуститься (2)");

  // restartMax=2 исчерпан — третий выход больше не перезапускает.
  spawn.spawned[2].emit("exit", 1, null);
  await delay(40);
  assert.equal(spawn.spawned.length, 3, "после restartMax перезапусков больше нет");
  relay.stop();
});

test("stop гасит процесс и запрещает перезапуск", async () => {
  const spawn = makeFakeSpawn();
  const relay = createStreamRelay({ streamConfig: CFG, spawnImpl: spawn, log: silentLog });
  relay.start();
  const child = spawn.spawned[0];
  relay.stop();
  assert.equal(child.killed, true);
  assert.equal(relay.status().state, "idle");
  // Пришедший после stop exit не должен поднимать новый процесс.
  child.emit("exit", 0, "SIGTERM");
  await delay(40);
  assert.equal(spawn.spawned.length, 1);
});

test("синхронный сбой запуска ffmpeg → spawn_failed, свой эфир не затронут", () => {
  const throwingSpawn = () => { throw new Error("spawn ffmpeg ENOENT"); };
  const relay = createStreamRelay({ streamConfig: CFG, spawnImpl: throwingSpawn, log: silentLog });
  const res = relay.start();
  assert.equal(res.ok, false);
  assert.equal(res.code, "spawn_failed");
  assert.equal(relay.status().state, "error");
});

test("ключ трансляции ВК не утекает в lastError (редакция stderr)", () => {
  const spawn = makeFakeSpawn();
  const relay = createStreamRelay({ streamConfig: CFG, spawnImpl: spawn, log: silentLog });
  relay.start();
  spawn.spawned[0].stderr.emit("data", "Failed to connect to rtmp://vk-ingest/app/streamkey: I/O error");
  const st = relay.status();
  assert.ok(!st.lastError.includes("streamkey"), "ключ ВК не должен попадать в lastError");
  assert.ok(st.lastError.includes("<vk-target>"), "цель должна быть заредачена");
  relay.stop();
});

test("повторный start идемпотентен (already)", () => {
  const spawn = makeFakeSpawn();
  const relay = createStreamRelay({ streamConfig: CFG, spawnImpl: spawn, log: silentLog });
  relay.start();
  const res2 = relay.start();
  assert.equal(res2.ok, true);
  assert.equal(res2.already, true);
  assert.equal(spawn.spawned.length, 1);
  relay.stop();
});
