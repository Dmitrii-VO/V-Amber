import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logsDir = join(__dirname, "..", "logs");
const installIdPath = join(logsDir, "install-id");

let cached = null;

export async function getInstallId() {
  if (cached) return cached;
  try {
    const raw = (await readFile(installIdPath, "utf8")).trim();
    if (raw) {
      cached = raw;
      return cached;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(logsDir, { recursive: true });
  const id = randomUUID();
  await writeFile(installIdPath, `${id}\n`, "utf8");
  cached = id;
  return cached;
}
