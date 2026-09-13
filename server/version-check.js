import { readFile, stat, writeFile } from "node:fs/promises";
import { logger } from "./logger.js";

const RELEASES_API = "https://api.github.com/repos/Dmitrii-VO/V-Amber/releases/latest";
// Публичная лента релизов — без лимита API. Нужна, когда GitHub отвечает 403
// «rate limit exceeded»: неавторизованному API он даёт 60 запросов в час НА
// IP, и на общем адресе (VPN, офис, несколько перезапусков подряд) они
// кончаются мгновенно — 13.09.2026 бейдж на дашборде так и висел
// «обновления не проверены», хотя релиз был.
const RELEASES_ATOM = "https://github.com/Dmitrii-VO/V-Amber/releases.atom";
const RELEASES_PAGE = "https://github.com/Dmitrii-VO/V-Amber/releases";
const FETCH_TIMEOUT_MS = 3000;
// Кеш последнего УСПЕШНОГО ответа GitHub. Держим час: релизы выходят реже, а
// каждый старт приложения тратил запрос из шестидесяти в час на IP.
// Храним только удалённую версию и время — сравнение с локальной делается
// заново, иначе после обновления бейдж ещё час звал бы обновляться.
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_URL = new URL("../logs/update-check.json", import.meta.url);

async function readCachedRemoteVersion() {
  try {
    const cached = JSON.parse(await readFile(CACHE_URL, "utf8"));
    const age = Date.now() - Date.parse(cached.checkedAt);
    if (!Number.isFinite(age) || age < 0 || age > CACHE_TTL_MS) return null;
    return typeof cached.remoteVersion === "string" ? cached.remoteVersion : null;
  } catch {
    return null;
  }
}

async function writeCachedRemoteVersion(remoteVersion) {
  try {
    await writeFile(
      CACHE_URL,
      JSON.stringify({ remoteVersion, checkedAt: new Date().toISOString() }),
      "utf8",
    );
  } catch {
    // Кеш — оптимизация, а не требование: не смогли записать, значит в
    // следующий раз просто сходим в сеть.
  }
}

async function readLocalVersion() {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const raw = await readFile(pkgUrl, "utf8");
  const pkg = JSON.parse(raw);
  return typeof pkg.version === "string" ? pkg.version : null;
}

function parseVersion(value) {
  if (!value) return null;
  const cleaned = String(value).trim().replace(/^v/i, "");
  // Отрезаем pre-release и build-суффикс («1.2.3-beta», «1.2.3+ci»), но НЕ
  // точку: раньше в классе был и ".", поэтому split()[0] от «0.1.104» давал
  // «0», любая версия разбиралась как 0.0.0, сравнение всегда выходило
  // «равны» — и баннер про обновление не печатался НИ РАЗУ. Именно так прод
  // простоял на 0.1.71, пока в репозитории было 0.1.103.
  const parts = cleaned.split(/[+-]/)[0].split(".");
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  while (nums.length < 3) nums.push(0);
  return nums;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function pathExists(relPath) {
  try {
    await stat(new URL(`../${relPath}`, import.meta.url));
    return true;
  } catch {
    return false;
  }
}

async function buildUpdateInstructions() {
  const [hasGit, hasMacScript, hasWinScript] = await Promise.all([
    pathExists(".git"),
    pathExists("update.command"),
    pathExists("update.cmd"),
  ]);
  const lines = [];
  if (hasMacScript && process.platform === "darwin") {
    lines.push("Обновить: двойной клик на update.command в папке проекта");
  } else if (hasWinScript && process.platform === "win32") {
    lines.push("Обновить: двойной клик на update.cmd в папке проекта");
  } else if (hasGit) {
    lines.push("Обновить: git pull && npm install");
  } else {
    lines.push("Обновить: скачайте свежий ZIP и распакуйте поверх,");
    lines.push("          сохранив .env и logs/");
  }
  return lines;
}

function printBanner(localVersion, remoteVersion, instructionLines) {
  const yellow = "\x1b[33m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const top = `Доступна новая версия V-Amber: ${remoteVersion} (у вас ${localVersion})`;
  const release = `Релиз:    ${RELEASES_PAGE}`;
  const contentLines = [top, "", release, ...instructionLines];
  const width = Math.max(...contentLines.map((l) => l.length)) + 2;
  const pad = (s) => ` ${s}${" ".repeat(width - s.length - 1)}`;
  const border = (ch) => `${ch}${"═".repeat(width)}${ch === "╔" ? "╗" : "╝"}`;
  const empty = `║${" ".repeat(width)}║`;
  console.log(`${yellow}${bold}${border("╔")}`);
  for (const line of contentLines) {
    console.log(line === "" ? empty : `║${pad(line)}║`);
  }
  console.log(`${border("╚")}${reset}`);
}

// Последний результат проверки. Раньше checkForUpdates() только печатала
// рамку в консоль и не возвращала ничего — а консоль оператор не видит: лаунчер
// через 1.5 с открывает браузер поверх Терминала, и логгер тут же засыпает
// рамку своим JSON. Именно поэтому в бою стояла 0.1.71, когда в репозитории
// было 0.1.103 — тридцать версий. Теперь результат живёт здесь, отдаётся в
// /health и показывается в дашборде, то есть там, где оператор работает.
//
// Проверка разовая, на старте: обновляться посреди эфира всё равно нельзя.
let lastResult = {
  status: "unknown",
  localVersion: null,
  remoteVersion: null,
  releasesUrl: RELEASES_PAGE,
  instructions: [],
  checkedAt: null,
};

export function getUpdateStatus() {
  return lastResult;
}

function finish(next) {
  lastResult = { ...lastResult, ...next, checkedAt: new Date().toISOString() };
  return lastResult;
}

// `fetchImpl` и `localVersion` — швы для тестов: без них проверить сравнение
// версий можно было только сходив в сеть, поэтому она и не была покрыта вовсе.
// useCache — шов для тестов: иначе один тест писал бы кеш на диск, а
// следующие читали бы его вместо своего мока и проверяли не то.
export async function checkForUpdates({ fetchImpl = fetch, localVersion: injectedVersion, useCache = true } = {}) {
  if (process.env.DISABLE_UPDATE_CHECK === "1") {
    return finish({ status: "disabled" });
  }

  let localVersion = injectedVersion;
  if (!localVersion) {
    try {
      localVersion = await readLocalVersion();
    } catch (error) {
      logger.warn("update-check", "read_local_version_failed", { error });
      return finish({ status: "check_failed", reason: "local_version_unreadable" });
    }
  }
  const localParts = parseVersion(localVersion);
  if (!localParts) {
    return finish({ status: "check_failed", reason: "local_version_unparsable", localVersion });
  }

  const cachedRemote = useCache ? await readCachedRemoteVersion() : null;
  if (cachedRemote) {
    return compareAndFinish({ localVersion, localParts, remoteVersion: cachedRemote });
  }

  let response;
  try {
    response = await fetchImpl(RELEASES_API, {
      headers: {
        "User-Agent": "V-Amber-update-check",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    // Сеть, таймаут, DNS. Молчание тут неотличимо от «всё свежее», поэтому
    // статус отдаём наружу: дашборд скажет «проверить не удалось».
    logger.warn("update-check", "check_failed", { error: error?.message || String(error) });
    return finish({ status: "check_failed", reason: "network", localVersion });
  }

  // 404 — релизов нет вообще (свежий форк, приватный репозиторий). Это не сбой.
  if (response.status === 404) {
    return finish({ status: "current", localVersion, remoteVersion: null });
  }
  // 403 с лимитом GitHub — самый частый отказ: API режет неавторизованные
  // запросы по IP. Не сдаёмся: та же информация лежит в ленте релизов, где
  // лимита нет.
  if (response.status === 403) {
    const fromAtom = await readVersionFromAtom(fetchImpl);
    if (fromAtom) {
      logger.info("update-check", "atom_fallback_used", { remote: fromAtom });
      return compareAndFinish({ localVersion, localParts, remoteVersion: fromAtom, cache: useCache });
    }
  }
  if (!response.ok) {
    logger.warn("update-check", "check_failed", { status: response.status });
    return finish({ status: "check_failed", reason: `http_${response.status}`, localVersion });
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    logger.warn("update-check", "check_failed", { error: error?.message || String(error) });
    return finish({ status: "check_failed", reason: "bad_payload", localVersion });
  }

  const remoteVersion = typeof payload?.tag_name === "string" ? payload.tag_name.replace(/^v/i, "") : null;
  return compareAndFinish({ localVersion, localParts, remoteVersion, cache: useCache });
}

// Последний релиз из ленты: первый <title> с версией. Лента отдаёт релизы
// от новых к старым, поэтому первого достаточно.
export function parseAtomVersion(xml) {
  const match = /<title>\s*v?(\d+(?:\.\d+)*)\s*<\/title>/i.exec(String(xml || ""));
  return match ? match[1] : null;
}

async function readVersionFromAtom(fetchImpl) {
  try {
    const response = await fetchImpl(RELEASES_ATOM, {
      headers: { "User-Agent": "V-Amber-update-check" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseAtomVersion(await response.text());
  } catch {
    // Лента — запасной путь; её отказ ничего не добавляет к уже известному
    // «проверить не удалось».
    return null;
  }
}

async function compareAndFinish({ localVersion, localParts, remoteVersion, cache = false }) {
  if (cache && remoteVersion) {
    await writeCachedRemoteVersion(remoteVersion);
  }
  const remoteParts = parseVersion(remoteVersion);
  if (!remoteParts) {
    return finish({ status: "check_failed", reason: "remote_version_unparsable", localVersion });
  }

  if (compareVersions(remoteParts, localParts) <= 0) {
    return finish({ status: "current", localVersion, remoteVersion });
  }

  const instructions = await buildUpdateInstructions();
  printBanner(localVersion, remoteVersion, instructions);
  logger.info("update-check", "update_available", { local: localVersion, remote: remoteVersion });
  return finish({ status: "update_available", localVersion, remoteVersion, instructions });
}
