import test from "node:test";
import assert from "node:assert/strict";
import { createCommentFloodGuard } from "../server/comment-flood-guard.js";

function makeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

test("события до порога проходят без подавления", () => {
  const clock = makeClock();
  const guard = createCommentFloodGuard({ windowMs: 60_000, threshold: 3, now: clock.now });

  for (let i = 0; i < 3; i += 1) {
    const result = guard.hit();
    assert.equal(result.suppress, false);
    assert.equal(result.floodStarted, false);
    assert.equal(result.floodEnded, null);
  }
});

test("после порога события подавляются, floodStarted ровно один раз", () => {
  const clock = makeClock();
  const guard = createCommentFloodGuard({ windowMs: 60_000, threshold: 2, now: clock.now });

  guard.hit();
  guard.hit();

  const first = guard.hit();
  assert.equal(first.suppress, true);
  assert.equal(first.floodStarted, true);

  const second = guard.hit();
  assert.equal(second.suppress, true);
  assert.equal(second.floodStarted, false);
});

test("новое окно сбрасывает счётчик и отдаёт сводку о подавленном", () => {
  const clock = makeClock();
  const guard = createCommentFloodGuard({ windowMs: 60_000, threshold: 1, now: clock.now });

  guard.hit();
  guard.hit(); // suppressed 1
  guard.hit(); // suppressed 2

  clock.advance(60_001);
  const result = guard.hit();
  assert.equal(result.suppress, false);
  assert.deepEqual(result.floodEnded, { suppressed: 2 });

  // Следующее окно без флуда — сводки нет.
  clock.advance(60_001);
  const quiet = guard.hit();
  assert.equal(quiet.floodEnded, null);
});

test("окно без подавления не отдаёт floodEnded", () => {
  const clock = makeClock();
  const guard = createCommentFloodGuard({ windowMs: 60_000, threshold: 5, now: clock.now });

  guard.hit();
  clock.advance(60_001);
  const result = guard.hit();
  assert.equal(result.floodEnded, null);
});

test("редкие события в разных окнах никогда не подавляются", () => {
  const clock = makeClock();
  const guard = createCommentFloodGuard({ windowMs: 60_000, threshold: 2, now: clock.now });

  for (let i = 0; i < 10; i += 1) {
    const result = guard.hit();
    assert.equal(result.suppress, false);
    clock.advance(45_000);
  }
});
