import { readFile } from "node:fs/promises";
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

function printBanner(localVersion, remoteVersion) {
  const yellow = "\x1b[33m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const line1 = `Доступна новая версия V-Amber: ${remoteVersion} (у вас ${localVersion})`;
  const line2 = `Релиз:    ${RELEASES_PAGE}`;
  const line3 = `Обновить: git pull && npm install`;
  const line4 = `В Docker: docker compose up --build`;
  const width = Math.max(line1.length, line2.length, line3.length, line4.length) + 2;
  const pad = (s) => ` ${s}${" ".repeat(width - s.length - 1)}`;
  const top = `╔${"═".repeat(width)}╗`;
  const bottom = `╚${"═".repeat(width)}╝`;
  const mid = `║${" ".repeat(width)}║`;
  console.log(`${yellow}${bold}${top}`);
  console.log(`║${pad(line1)}║`);
  console.log(mid);
  console.log(`║${pad(line2)}║`);
  console.log(`║${pad(line3)}║`);
  console.log(`║${pad(line4)}║`);
  console.log(`${bottom}${reset}`);
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
    printBanner(localVersion, remoteVersion);
    logger.info("update-check", "update_available", { local: localVersion, remote: remoteVersion });
  }
}
