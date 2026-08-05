import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createWishlistStore } from "../server/wishlist-store.js";

test("wishlist preserves requested quantity for overflow and close migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v-amber-wishlist-"));
  const filePath = join(dir, "events.jsonl");
  try {
    const store = createWishlistStore({ filePath });
    await store.load();
    await store.addFromOutOfStock({
      event: { viewerId: 1, viewerName: "Аня", commentId: 10, quantity: 3 },
      lot: { code: "03204", lotSessionId: "lot-1", product: { salePrice: 1000 } },
    });
    await store.addFromWaitlistOnClose({
      events: [{ viewerId: 2, viewerName: "Оля", commentId: 11, quantity: 4, lotCode: "03205" }],
      lot: { code: "03205", lotSessionId: "lot-2" },
      reason: "stream_stop",
    });
    await store.flush();

    assert.deepEqual(store.listActive().map((entry) => entry.quantity).sort(), [3, 4]);
    const records = (await readFile(filePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(records.map((record) => record.quantity).sort(), [3, 4]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wishlist append failure rejects without mutating active state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v-amber-wishlist-fail-"));
  const store = createWishlistStore({ filePath: dir });

  try {
    await assert.rejects(store.addFromOutOfStock({
      event: { viewerId: 77, viewerName: "Оля", commentId: 9, quantity: 2 },
      lot: { code: "03820", lotSessionId: "lot-fail", product: {} },
      productMeta: {},
    }));
    assert.equal(store.getActiveCount(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repeated wishlist demand adds requested quantity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v-amber-wishlist-repeat-"));
  const store = createWishlistStore({ filePath: join(dir, "events.jsonl") });

  try {
    const lot = { code: "03820", lotSessionId: "lot-repeat", product: {} };
    await store.addFromOutOfStock({
      event: { viewerId: 77, viewerName: "Оля", commentId: 9, quantity: 3 },
      lot,
      productMeta: {},
    });
    await store.addFromOutOfStock({
      event: { viewerId: 77, viewerName: "Оля", commentId: 10, quantity: 4 },
      lot,
      productMeta: {},
    });

    assert.equal(store.listActive()[0].quantity, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent wishlist additions deduplicate atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v-amber-wishlist-concurrent-"));
  const filePath = join(dir, "events.jsonl");
  const store = createWishlistStore({ filePath });

  try {
    const lot = { code: "03820", lotSessionId: "lot-concurrent", product: {} };
    await Promise.all([
      store.addFromOutOfStock({
        event: { viewerId: 77, viewerName: "Оля", commentId: 11, quantity: 2 },
        lot,
        productMeta: {},
      }),
      store.addFromOutOfStock({
        event: { viewerId: 77, viewerName: "Оля", commentId: 12, quantity: 3 },
        lot,
        productMeta: {},
      }),
    ]);

    assert.equal(store.getActiveCount(), 1);
    assert.equal(store.listActive()[0].quantity, 5);
    const records = (await readFile(filePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(records.map((record) => record.kind), ["added", "seen_again"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent removal and close migration leave an active replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v-amber-wishlist-remove-race-"));
  const store = createWishlistStore({ filePath: join(dir, "events.jsonl") });

  try {
    const lot = { code: "03820", lotSessionId: "lot-remove-race", product: {} };
    const original = await store.addFromOutOfStock({
      event: { viewerId: 77, viewerName: "Оля", commentId: 20, quantity: 1 },
      lot,
      productMeta: {},
    });
    await Promise.all([
      store.remove(original.id),
      store.addFromWaitlistOnClose({
        events: [{ viewerId: 77, viewerName: "Оля", commentId: 21, quantity: 2 }],
        lot,
        reason: "stream_stop",
      }),
    ]);

    assert.equal(store.getActiveCount(), 1);
    assert.notEqual(store.listActive()[0].id, original.id);
    assert.equal(store.listActive()[0].quantity, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
