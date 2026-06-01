import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/ws-harness.js";

const CARD_03204 = {
  id: "p-03204",
  name: "Серьги янтарь",
  code: "03204",
  pathName: "Украшения/Серьги",
  salePrice: 4500,
  availableStock: 2,
};

const CARD_00588 = {
  id: "p-00588",
  name: "Кольцо янтарь",
  code: "00588",
  pathName: "Украшения/Кольца",
  salePrice: 3200,
  availableStock: 3,
};

function createCollectingSessionLog(events) {
  const push = (kind) => (payload = {}) => events.push({ kind, ...payload });
  const noop = () => {};
  return () => ({
    getFilePath: () => null,
    getJsonl: () => ({ writeEvent: push("jsonl"), flush: async () => {} }),
    logSessionStart: push("session_started"),
    logSessionEnd: push("session_ended"),
    logStateSnapshot: push("state_snapshot"),
    logReservationDetected: push("reservation_detected"),
    logReservationFinalized: push("reservation_finalized"),
    logPriceChanged: push("lot_price_changed"),
    logManualCodeSubmitted: push("manual_code_submitted"),
    logLotClosed: push("lot_closed"),
    logReservationQuantityAppended: push("reservation_quantity_appended"),
    logLotOpened: push("lot_opened"),
    logOrderCreated: push("customer_order_created"),
    logOrderCancelled: push("customer_order_cancelled"),
    logReservationWaitlist: push("reservation_waitlist_pending"),
    logReservationOutOfStock: push("reservation_out_of_stock"),
    logWaitlistPromoted: push("waitlist_promoted"),
    logVkComment: push("vk_comment"),
    logTranscriptFinal: push("transcript_final"),
    logDiscount: push("discount_applied"),
    logDiscountSkipped: push("discount_skipped"),
    logSafemodeToggled: push("safemode_toggled"),
    logReservation: noop,
    logOrphanWaitlist: noop,
    logWaitlistMigratedToWishlist: noop,
    flush: async () => {},
  });
}

async function startStreamAndOpenLot(client, harness, text = "код товара 03204") {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  const session = await harness.waitForSession();
  session.handlers.onFinal({ text, latencyMs: 10 });
  await client.waitFor((m) => m.type === "state" && m.activeLot?.code === "03204");
  return session;
}

test("session JSONL receives final reservation outcome", async () => {
  const events = [];
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204 },
    knownCodes: ["03204"],
    createSessionLog: createCollectingSessionLog(events),
  });
  const client = await harness.connect();
  try {
    await startStreamAndOpenLot(client, harness);
    harness.vk.pushComment({ id: 201, fromId: 5001, text: "бронь 03204", firstName: "Анна" });

    await client.waitFor(
      (m) => m.type === "state" && m.openLots?.some((lot) =>
        lot.reservations?.events?.some((event) => event.commentId === 201 && event.status === "reserved")),
      { timeoutMs: 5000 },
    );

    const detected = events.find((event) => event.kind === "reservation_detected" && event.commentId === 201);
    const finalized = events.find((event) => event.kind === "reservation_finalized" && event.commentId === 201);
    assert.equal(detected.code, "03204");
    assert.equal(finalized.status, "reserved");
    assert.equal(finalized.orderId, "co-test-1");
    assert.equal(finalized.lotSessionId, detected.lotSessionId);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("state snapshots include every open lot, not only active lot", async () => {
  const events = [];
  const harness = await startHarness({
    cardsByCode: { "03204": CARD_03204, "00588": CARD_00588 },
    knownCodes: ["03204", "00588"],
    createSessionLog: createCollectingSessionLog(events),
  });
  const client = await harness.connect();
  try {
    const session = await startStreamAndOpenLot(client, harness);
    session.handlers.onFinal({ text: "код товара 00588", latencyMs: 10 });
    await client.waitFor(
      (m) => m.type === "state" && m.activeLot?.code === "00588" && m.openLots?.length === 2,
      { timeoutMs: 4000 },
    );

    const snapshots = events.filter((event) => event.kind === "state_snapshot" && Array.isArray(event.openLots));
    const multiLot = snapshots.find((event) => event.openLots.map((lot) => lot.code).sort().join(",") === "00588,03204");
    assert.ok(multiLot, "expected a snapshot with both open lots");
    assert.equal(multiLot.activeLotSessionId, multiLot.activeLot.lotSessionId);
  } finally {
    await client.close();
    await harness.close();
  }
});
