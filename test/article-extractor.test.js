import test from "node:test";
import assert from "node:assert/strict";

import {
  detectArticle,
  transcriptHasTrigger,
} from "../server/article-extractor.js";

const triggers = ["артикул", "номер"];

const baseConfig = {
  triggers,
  minLength: 1,
  maxLength: 10,
  yandexgpt: { apiKey: "", folderId: "", endpoint: "", model: "" },
};

test("transcriptHasTrigger matches a known trigger", () => {
  assert.equal(transcriptHasTrigger("посмотрите артикул 12345", triggers), true);
});

test("transcriptHasTrigger ignores text without trigger", () => {
  assert.equal(transcriptHasTrigger("просто текст без кода", triggers), false);
});

test("transcriptHasTrigger is stable across repeated calls (cached regex)", () => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal(transcriptHasTrigger("артикул 42", triggers), true, `iteration ${i}`);
    assert.equal(transcriptHasTrigger("без триггера", triggers), false, `iteration ${i}`);
  }
});

test("detectArticle returns confirmed for numeric suffix", async () => {
  const result = await detectArticle("артикул 12345", baseConfig);
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "12345");
});

test("detectArticle works after multiple invocations (cached global regex lastIndex)", async () => {
  // The capture regex is /g and cached. If lastIndex isn't reset between calls,
  // the second call on the same input would miss the match and return no_match.
  const first = await detectArticle("артикул 777", baseConfig);
  const second = await detectArticle("артикул 777", baseConfig);
  const third = await detectArticle("артикул 777", baseConfig);
  assert.equal(first.status, "confirmed");
  assert.equal(second.status, "confirmed");
  assert.equal(third.status, "confirmed");
  assert.equal(second.chosen?.code, "777");
  assert.equal(third.chosen?.code, "777");
});

test("detectArticle resets cached global regex lastIndex between distinct inputs", async () => {
  // The capture regex is /g — if lastIndex isn't reset, a longer first input
  // would leave lastIndex past the start of a shorter second input, causing
  // the second detectArticle call to silently return no_match.
  const longInput = "вступление какое-то длинное артикул 123456";
  const shortInput = "артикул 7";
  const first = await detectArticle(longInput, baseConfig);
  const second = await detectArticle(shortInput, baseConfig);
  assert.equal(first.status, "confirmed");
  assert.equal(first.chosen?.code, "123456");
  assert.equal(second.status, "confirmed");
  assert.equal(second.chosen?.code, "7");
});

test("detectArticle returns awaiting_continuation when trigger ends with filler", async () => {
  const result = await detectArticle("у нас артикул номер", baseConfig);
  assert.equal(result.status, "awaiting_continuation");
});

test("detectArticle returns no_match without trigger", async () => {
  const result = await detectArticle("просто число 12345 без слова", baseConfig);
  assert.equal(result.status, "no_match");
});

test("detectArticle handles digit-word sequences", async () => {
  const result = await detectArticle("артикул один два три", baseConfig);
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "123");
});

test("trigger cache stays consistent across calls with the same array", async () => {
  // WeakMap is keyed on the triggers array identity. Sequential calls must
  // reuse the cached regexes; a regression that re-creates regexes per call
  // would still functionally work, so we cross-check that a *different*
  // triggers array produces a fresh, independent cache entry.
  const altTriggers = ["модель"];
  const altConfig = { ...baseConfig, triggers: altTriggers };

  const hit = await detectArticle("артикул 999", baseConfig);
  const miss = await detectArticle("артикул 999", altConfig);
  const altHit = await detectArticle("модель 999", altConfig);

  assert.equal(hit.status, "confirmed");
  assert.equal(miss.status, "no_match");
  assert.equal(altHit.status, "confirmed");
  assert.equal(altHit.chosen?.code, "999");
});
