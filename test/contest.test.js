import test from "node:test";
import assert from "node:assert/strict";

import { createContest } from "../server/contest.js";

// random() = 0 → минимальное число диапазона, 0.999… → максимальное.
const fixed = (value) => createContest({ random: () => value, now: () => 1000 });

test("загаданное число всегда трёхзначное", () => {
  assert.equal(fixed(0).start().number, 100);
  assert.equal(fixed(0.9999999).start().number, 999);
});

test("побеждает первый, кто назвал точное число", () => {
  const contest = fixed(0);
  contest.start();

  assert.equal(contest.submit({ commentId: 1, viewerId: 5001, text: "200" }), null);
  const winner = contest.submit({ commentId: 2, viewerId: 5002, viewerName: "Марина", text: "100" });

  assert.equal(winner.viewerId, 5002);
  assert.equal(winner.viewerName, "Марина");
  assert.equal(winner.number, 100);
  assert.equal(winner.attempts, 2);
  // Конкурс закончился — торги снимаются с паузы.
  assert.equal(contest.isActive(), false);
});

test("число ищется целой группой цифр, а не подстрокой", () => {
  const contest = fixed(0);
  contest.start();

  // «1005» содержит «100», но это не тот ответ.
  assert.equal(contest.submit({ commentId: 1, text: "1005" }), null);
  // Знаки препинания вокруг ответу не мешают.
  assert.ok(contest.submit({ commentId: 2, viewerId: 7, text: "+100!" }));
});

test("ведущий ноль не отнимает победу", () => {
  const contest = fixed(0);
  contest.start();

  // В этом каталоге артикулы пишут с ведущими нулями, и зрители переносят
  // привычку на конкурс. «0100» — это тот же ответ 100.
  assert.ok(contest.submit({ commentId: 1, viewerId: 7, text: "0100" }));
});

test("повторная доставка того же комментария не даёт второй попытки", () => {
  const contest = fixed(0);
  contest.start();

  contest.submit({ commentId: 42, text: "555" });
  contest.submit({ commentId: 42, text: "555" });

  assert.equal(contest.getState().attempts, 1);
});

test("повторный старт не перезагадывает число", () => {
  let calls = 0;
  const contest = createContest({ random: () => { calls += 1; return 0; }, now: () => 1 });

  const first = contest.start();
  const second = contest.start();

  assert.equal(second.started, false, "двойной клик не должен менять уже названное вслух число");
  assert.equal(second.number, first.number);
  assert.equal(calls, 1);
});

test("стоп завершает конкурс без победителя", () => {
  const contest = fixed(0);
  contest.start();

  const stopped = contest.stop();

  assert.equal(stopped.stopped, true);
  assert.equal(stopped.winner, null);
  assert.equal(contest.isActive(), false);
  // После стопа комментарии больше не считаются попытками.
  assert.equal(contest.submit({ commentId: 9, text: "100" }), null);
});
