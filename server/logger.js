import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logsDir = join(__dirname, "..", "logs");
const logFilePath = join(logsDir, "server.log");

let writeChain = Promise.resolve();

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
};
