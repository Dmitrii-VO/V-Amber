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

test("асинхронный сбой запуска (ENOENT через 'error' без 'exit') → error + retry, не вечный running", async () => {
  const spawn = makeFakeSpawn();
  const relay = createStreamRelay({ streamConfig: CFG, spawnImpl: spawn, log: silentLog });
  relay.start();
  assert.equal(relay.status().state, "running");

  // Node доставляет ENOENT событием 'error' ДО 'spawn'; 'exit' не приходит.
  spawn.spawned[0].emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
  assert.equal(relay.status().state, "error");
  assert.match(relay.status().lastError, /ENOENT/);

  // Ретраи идут и исчерпываются (restartMax=2): 1 старт + 2 повтора.
  assert.ok(await waitFor(() => spawn.spawned.length === 2), "первый ретрай после сбоя запуска");
  spawn.spawned[1].emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
  assert.ok(await waitFor(() => spawn.spawned.length === 3), "второй ретрай");
  spawn.spawned[2].emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
  await delay(40);
  assert.equal(spawn.spawned.length, 3, "после restartMax попыток больше нет");
  assert.equal(relay.status().state, "error");
  relay.stop();
});

test("поздний exit старого процесса после stop→start не плодит второй ffmpeg", async () => {
  const spawn = makeFakeSpawn();
  const relay = createStreamRelay({ streamConfig: CFG, spawnImpl: spawn, log: silentLog });
  relay.start();
  const oldChild = spawn.spawned[0];

  relay.stop();               // SIGTERM отправлен, но exit ещё не пришёл
  relay.start();              // оператор сразу перезапустил эфир
  assert.equal(spawn.spawned.length, 2);
  const newChild = spawn.spawned[1];

  // Теперь прилетает exit УБИТОГО процесса. Раньше он затирал ссылку на
  // новый ffmpeg и планировал рестарт — два релея лили в ВК параллельно.
  oldChild.emit("exit", 0, "SIGTERM");
  await delay(40);
  assert.equal(spawn.spawned.length, 2, "рестарт от устаревшего exit не планируется");
  assert.equal(relay.status().state, "running");

  // stop() всё ещё контролирует именно НОВЫЙ процесс.
  relay.stop();
  assert.equal(newChild.killed, true);
});

test("start в окне ожидания рестарт-таймера отменяет таймер — второй ffmpeg не спаунится", async () => {
  const spawn = makeFakeSpawn();
  const relay = createStreamRelay({ streamConfig: { ...CFG, relayRestartDelayMs: 30 }, spawnImpl: spawn, log: silentLog });
  relay.start();
  spawn.spawned[0].emit("exit", 1, null); // краш → рестарт запланирован через 30мс
  assert.equal(relay.status().state, "error");

  relay.start(); // оператор перезапускает раньше таймера
  assert.equal(spawn.spawned.length, 2);
  assert.equal(relay.status().state, "running");

  await delay(80); // таймер (если бы выжил) уже сработал бы
  assert.equal(spawn.spawned.length, 2, "отменённый ретрай не спаунит третий процесс");
  relay.stop();
  assert.equal(spawn.spawned[1].killed, true, "stop контролирует именно новый процесс");
});

test("runtime 'error' после успешного spawn не роняет релей — ждём exit", () => {
  const spawn = makeFakeSpawn();
  const relay = createStreamRelay({ streamConfig: CFG, spawnImpl: spawn, log: silentLog });
  relay.start();
  const child = spawn.spawned[0];
  child.emit("spawn"); // процесс реально стартовал
  child.emit("error", new Error("kill EPERM")); // ошибка НЕ запуска
  assert.equal(relay.status().state, "running", "процесс жив — running сохраняется");

  child.emit("exit", 1, null); // настоящий выход обрабатывается как раньше
  assert.equal(relay.status().state, "error");
  relay.stop();
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
