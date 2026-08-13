import test from "node:test";
import assert from "node:assert/strict";

import { createLatencyTracker } from "../server/speechkit-stream.js";

test("первый партиал реплики не с чем сравнивать", () => {
  const tracker = createLatencyTracker();
  assert.equal(tracker.partial("артикул", 1000), null);
});

test("партиал меряет промежуток с прошлого нового текста", () => {
  const tracker = createLatencyTracker();
  tracker.partial("артикул", 1000);
  assert.equal(tracker.partial("артикул ноль", 1250), 250);
  assert.equal(tracker.partial("артикул ноль три", 1400), 150);
});

test("повтор того же партиала не сдвигает точку отсчёта", () => {
  const tracker = createLatencyTracker();
  tracker.partial("артикул ноль три", 1000);
  // SpeechKit повторяет партиал во время паузы EOU — если считать от повтора,
  // хвост финала выйдет нулевым, а он и есть искомая задержка.
  assert.equal(tracker.partial("артикул ноль три", 1500), 500);
  assert.equal(tracker.final(1700), 700);
});

test("финал меряет хвост «договорил → пришёл текст»", () => {
  const tracker = createLatencyTracker();
  tracker.partial("артикул ноль три", 1000);
  assert.equal(tracker.final(1720), 720);
});

test("финал без единого партиала даёт null, а не ноль", () => {
  const tracker = createLatencyTracker();
  assert.equal(tracker.final(1000), null);
});

test("следующая реплика считается с нуля", () => {
  const tracker = createLatencyTracker();
  tracker.partial("первая", 1000);
  tracker.final(1700);
  assert.equal(tracker.partial("вторая", 5000), null);
  assert.equal(tracker.final(5800), 800);
});

test("часы назад не уводят latency в минус", () => {
  const tracker = createLatencyTracker();
  tracker.partial("артикул", 1000);
  assert.equal(tracker.final(900), 0);
});
