import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeName,
  tokenizeName,
  stemToken,
  scoreNameMatch,
  matchNameAgainst,
} from "../server/name-matcher.js";

test("normalizeName lowercases, maps ё→е, strips punctuation", () => {
  assert.equal(normalizeName("Галина-Пётр!"), "галина петр");
  assert.equal(normalizeName("  Анна   Иванова "), "анна иванова");
  assert.equal(normalizeName(null), "");
});

test("tokenizeName splits into clean tokens", () => {
  assert.deepEqual(tokenizeName("Галина Прокофьева"), ["галина", "прокофьева"]);
  assert.deepEqual(tokenizeName(""), []);
});

test("stemToken trims case endings but keeps a minimum stem", () => {
  assert.equal(stemToken("галину"), stemToken("галина"));
  assert.equal(stemToken("ян"), "ян"); // too short to trim
});

test("scoreNameMatch is order-independent", () => {
  assert.equal(scoreNameMatch("Галина Прокофьева", "Прокофьева Галина"), 1);
});

test("scoreNameMatch tolerates declension (винительный падеж)", () => {
  assert.ok(scoreNameMatch("Галину Прокофьеву", "Галина Прокофьева") >= 0.5);
});

test("scoreNameMatch with only first name is partial but positive", () => {
  const score = scoreNameMatch("Галина", "Галина Прокофьева");
  assert.equal(score, 1); // 1/1 spoken tokens matched
});

test("scoreNameMatch returns 0 for unrelated names", () => {
  assert.equal(scoreNameMatch("Иван Петров", "Галина Прокофьева"), 0);
});

test("scoreNameMatch returns 0 for empty input", () => {
  assert.equal(scoreNameMatch("", "Галина"), 0);
  assert.equal(scoreNameMatch("Галина", ""), 0);
});

test("matchNameAgainst returns sorted matches above threshold", () => {
  const candidates = [
    { id: 1, name: "Иван Петров" },
    { id: 2, name: "Галина Прокофьева" },
    { id: 3, name: "Галина Сидорова" },
  ];
  const matches = matchNameAgainst("Галина Прокофьева", candidates);
  assert.equal(matches[0].id, 2);
  assert.ok(matches[0].score >= matches[matches.length - 1].score);
  assert.ok(matches.every((m) => m.score >= 0.5));
});

test("matchNameAgainst flags ambiguity (multiple full-name hits)", () => {
  // Two Галины — first-name-only spoken phrase matches both fully.
  const candidates = [
    { id: 2, name: "Галина Прокофьева" },
    { id: 3, name: "Галина Сидорова" },
  ];
  const matches = matchNameAgainst("Галина", candidates);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].score, 1);
  assert.equal(matches[1].score, 1);
});

test("matchNameAgainst accepts viewerName field too", () => {
  const matches = matchNameAgainst("Иван", [{ viewerId: 9, viewerName: "Иван Петров" }]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].viewerId, 9);
});

test("matchNameAgainst with 2+ spoken tokens requires ALL tokens (no half match)", () => {
  // «Галина Прокофьева» must NOT match «Галина Сидорова» on the shared first
  // name alone — otherwise, with no better candidate, a wrong buyer's
  // reservation would be cancelled (real money).
  const matches = matchNameAgainst("Галина Прокофьева", [
    { id: 3, name: "Галина Сидорова" },
  ]);
  assert.equal(matches.length, 0);
});

test("matchNameAgainst single spoken token still matches at 0.5 threshold", () => {
  const matches = matchNameAgainst("Галина", [{ id: 3, name: "Галина Сидорова" }]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 3);
});
