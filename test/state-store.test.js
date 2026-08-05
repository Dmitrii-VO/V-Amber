import test from "node:test";
import assert from "node:assert/strict";

import { extractOrphans, partitionOrphansForRecovery } from "../server/state-store.js";

test("crash recovery migrates safe orphan statuses but preserves creating_order for review", () => {
  const state = {
    openLots: [{
      code: "03820",
      lotSessionId: "lot-1",
      reservations: {
        events: [
          { commentId: 1, viewerId: 101, status: "waitlist_pending" },
          { commentId: 2, viewerId: 102, status: "pending_reservation" },
          { commentId: 3, viewerId: 103, status: "order_failed" },
          { commentId: 4, viewerId: 104, status: "creating_order" },
          { commentId: 5, viewerId: 105, status: "reserved" },
        ],
      },
    }],
  };

  const orphans = extractOrphans(state);
  const { safeOrphans, uncertainOrphans } = partitionOrphansForRecovery(orphans);

  assert.deepEqual(safeOrphans.map((entry) => entry.status), [
    "waitlist_pending",
    "pending_reservation",
    "order_failed",
  ]);
  assert.deepEqual(uncertainOrphans.map((entry) => entry.status), ["creating_order"]);
  assert.ok(orphans.every((entry) => entry.lotCode === "03820" && entry.lotSessionId === "lot-1"));
});
