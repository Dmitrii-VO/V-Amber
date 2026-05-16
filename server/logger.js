import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logsDir = join(__dirname, "..", "logs");
const logFilePath = join(logsDir, "server.log");

const ROTATE_BYTES = 10 * 1024 * 1024;
const ROTATE_KEEP = 5;
const ROTATE_CHECK_EVERY = 50;

let writeChain = Promise.resolve();
let writesSinceRotateCheck = 0;
let rotatingPromise = null;

function rotatedPath(index) {
  return `${logFilePath}.${index}`;
}

async function rotateIfNeeded() {
  let size;
  try {
    ({ size } = await stat(logFilePath));
  } catch {
    return;
  }
  if (size < ROTATE_BYTES) return;

  if (rotatingPromise) {
    await rotatingPromise;
    return;
  }

  rotatingPromise = (async () => {
    try {
      try {
        await unlink(rotatedPath(ROTATE_KEEP));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      for (let i = ROTATE_KEEP - 1; i >= 1; i -= 1) {
        try {
          await rename(rotatedPath(i), rotatedPath(i + 1));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      await rename(logFilePath, rotatedPath(1));
    } catch (error) {
      console.error(`logger_rotate_failed ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rotatingPromise = null;
    }
  })();

  await rotatingPromise;
}

function normalizeMeta(meta) {
  if (!meta) {
    return undefined;
  }

  return JSON.parse(
    JSON.stringify(meta, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      return value;
    }),
  );
}

function writeLine(line) {
  writeChain = writeChain
    .then(async () => {
      await mkdir(logsDir, { recursive: true });
      writesSinceRotateCheck += 1;
      if (writesSinceRotateCheck >= ROTATE_CHECK_EVERY) {
        writesSinceRotateCheck = 0;
        await rotateIfNeeded();
      }
      await appendFile(logFilePath, `${line}\n`, "utf8");
    })
    .catch((error) => {
      console.error(`logger_write_failed ${error instanceof Error ? error.message : String(error)}`);
    });
}

function emit(level, component, message, meta) {
  const record = {
    ts: new Date().toISOString(),
    level,
    component,
    message,
    meta: normalizeMeta(meta),
  };

  const line = JSON.stringify(record);
  const consoleMethod = level === "ERROR" ? console.error : console.log;
  consoleMethod(line);
  writeLine(line);
}

export const logger = {
  debug(component, message, meta) {
    emit("DEBUG", component, message, meta);
  },
  info(component, message, meta) {
    emit("INFO", component, message, meta);
  },
  warn(component, message, meta) {
    emit("WARN", component, message, meta);
  },
  error(component, message, meta) {
    emit("ERROR", component, message, meta);
  },
  filePath: logFilePath,
  rotatedPath,
  rotateKeep: ROTATE_KEEP,
};
