import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createReservationDigestLog } from "../server/reservation-digest-log.js";

test("reservation digest log indexes exact keys and date/viewer prefixes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v-amber-digest-log-"));
  try {
    const path = join(dir, "reservation-digest-sends.jsonl");
    await writeFile(path, [
      JSON.stringify({
        key: "2026-05-24:101:sha256:old",
        date: "2026-05-24",
        viewerId: "101",
        digestHash: "sha256:old",
      }),
      "{bad json",
      "",
    ].join("\n"), "utf8");

    const log = createReservationDigestLog(path);
    assert.equal(await log.has("2026-05-24:101:sha256:old"), true);
    assert.equal(await log.hasAnyFor("2026-05-24", "101"), true);
    assert.equal(await log.hasAnyFor("2026-05-24", "202"), false);

    await log.record({
      key: "2026-05-24:202:sha256:new",
      date: "2026-05-24",
      viewerId: "202",
      digestHash: "sha256:new",
    });

    assert.equal(await log.has("2026-05-24:202:sha256:new"), true);
    assert.equal(await log.hasAnyFor("2026-05-24", "202"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
