import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { logger } from "../server/logger.js";

test("logger.flush waits for server.log writes", async () => {
  const marker = `flush-marker-${Date.now()}-${Math.random()}`;
  logger.info("test", "flush_marker", { marker });
  await logger.flush();

  const content = await readFile(logger.filePath, "utf8");
  assert.match(content, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
