import { readFile, stat } from "node:fs/promises";
import { logger } from "./logger.js";

const RELEASES_API = "https://api.github.com/repos/Dmitrii-VO/V-Amber/releases/latest";
const RELEASES_PAGE = "https://github.com/Dmitrii-VO/V-Amber/releases";
const FETCH_TIMEOUT_MS = 3000;

async function readLocalVersion() {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const raw = await readFile(pkgUrl, "utf8");
  const pkg = JSON.parse(raw);
  return typeof pkg.version === "string" ? pkg.version : null;
}

function parseVersion(value) {
  if (!value) return null;
  const cleaned = String(value).trim().replace(/^v/i, "");
  const parts = cleaned.split(/[.+-]/)[0].split(".");
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

export async function checkForUpdates() {
  if (process.env.DISABLE_UPDATE_CHECK === "1") return;

  let localVersion;
  try {
    localVersion = await readLocalVersion();
  } catch (error) {
    logger.warn("update-check", "read_local_version_failed", { error });
    return;
  }
  const localParts = parseVersion(localVersion);
  if (!localParts) return;

  let response;
  try {
    response = await fetch(RELEASES_API, {
      headers: {
        "User-Agent": "V-Amber-update-check",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("update-check", "check_failed", { error: error?.message || String(error) });
    return;
  }

  if (response.status === 404) {
    return;
  }
  if (!response.ok) {
    logger.warn("update-check", "check_failed", { status: response.status });
    return;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    logger.warn("update-check", "check_failed", { error: error?.message || String(error) });
    return;
  }

  const remoteVersion = typeof payload?.tag_name === "string" ? payload.tag_name.replace(/^v/i, "") : null;
  const remoteParts = parseVersion(remoteVersion);
  if (!remoteParts) return;

  if (compareVersions(remoteParts, localParts) > 0) {
    const instructions = await buildUpdateInstructions();
    printBanner(localVersion, remoteVersion, instructions);
    logger.info("update-check", "update_available", { local: localVersion, remote: remoteVersion });
  }
}
