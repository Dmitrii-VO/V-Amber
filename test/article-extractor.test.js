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

test("detectArticle opens a lot from the short «код» trigger and full «код товара»", async () => {
  const config = { triggers: ["код товара", "артикул", "код"], minLength: 1, maxLength: 10 };

  const short = await detectArticle("код 01234", config);
  assert.equal(short.status, "confirmed");
  assert.equal(short.chosen?.code, "01234");

  // Full phrase must still resolve to the same code (no ambiguity from the
  // overlapping «код» trigger — «товара» is stripped as a filler).
  const full = await detectArticle("код товара 01234", config);
  assert.equal(full.status, "confirmed");
  assert.equal(full.chosen?.code, "01234");
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

test("detectArticle does not fold a trailing thousands cardinal into the code", async () => {
  // Operator says: "Код товара 00301. Размер тысяча четыреста." If SpeechKit
  // elides "размер" or transcribes the digits as digit-words, the extender
  // used to greedily absorb "тысяча четыреста" → "003011400". Guard against
  // that — cardinals >= 100 must not extend a numeric run.
  const result = await detectArticle(
    "код товара ноль ноль три ноль один тысяча четыреста",
    { ...baseConfig, triggers: ["код товара"] },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "00301");
});

test("detectArticle does not fold a trailing 1400 numeric token after a 5-digit code", async () => {
  // Same hazard via the bare-numeric path: "код товара 00301 1400" must not
  // collapse to "003011400"; both numbers are clearly separate utterances.
  const result = await detectArticle(
    "код товара 00301 1400",
    { ...baseConfig, triggers: ["код товара"] },
  );
  // The parser emits the two leading numerics as separate candidates, which
  // surfaces as ambiguous to the operator.
  assert.equal(result.status, "ambiguous");
  const codes = result.candidates.map((candidate) => candidate.code);
  assert.ok(codes.includes("00301"), `expected 00301 in candidates, got ${codes}`);
});

test("detectArticle still folds short cardinals into a mixed-form code", async () => {
  // Regression guard: the old behaviour for short cardinals (< 100) must
  // survive. "ноль один ноль двадцать два" historically resolves to "01022".
  const result = await detectArticle(
    "код товара ноль один ноль двадцать два",
    { ...baseConfig, triggers: ["код товара"] },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "01022");
});

test("detectArticle trims trailing size when known product code matches prefix", async () => {
  const result = await detectArticle(
    "код товара ноль один два три четыре семнадцать размер",
    { ...baseConfig, triggers: ["код товара"], knownCodes: new Set(["01234"]) },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "01234");
  assert.equal(result.chosen?.originalCode, "0123417");
});

test("detectArticle prefers known code over trailing numeric size candidate", async () => {
  const result = await detectArticle(
    "код товара 01234 17 размер",
    { ...baseConfig, triggers: ["код товара"], knownCodes: new Set(["01234"]) },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "01234");
});

test("detectArticle keeps exact known code before trying known prefixes", async () => {
  const result = await detectArticle(
    "код товара ноль один ноль двадцать два",
    { ...baseConfig, triggers: ["код товара"], knownCodes: new Set(["0102", "01022"]) },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "01022");
});

test("knownCodes accepts Array as well as Set", async () => {
  // normalizeKnownCodes must handle both — settings.json loaders typically
  // pass arrays, while productCodeCache.getCodes() returns a Set. Regression
  // here would silently disable catalog filtering for one of the callers.
  const result = await detectArticle(
    "код товара ноль один два три четыре семнадцать размер",
    { ...baseConfig, triggers: ["код товара"], knownCodes: ["01234", "99999"] },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "01234");
});

test("candidate without exact or prefix match in catalog passes through unchanged when alone", async () => {
  // If no candidate matches the catalog at all, applyKnownCodeHints must
  // not strip the lot. We surface the raw regex candidate so the operator
  // can still confirm manually (or the catalog refresh fixes it later).
  const result = await detectArticle(
    "код товара 99999",
    { ...baseConfig, triggers: ["код товара"], knownCodes: new Set(["01234"]) },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "99999");
  assert.notEqual(result.chosen?.knownCode, true);
});

test("known-catalog candidates win over unknown ones in the same transcript", async () => {
  // Two leading numeric tokens: "01234" is in the catalog, "5555" is not.
  // The old behaviour produced both as ambiguous. With catalog filtering,
  // only the validated one survives — status flips to confirmed.
  const result = await detectArticle(
    "код товара 01234 5555",
    { ...baseConfig, triggers: ["код товара"], knownCodes: new Set(["01234"]) },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "01234");
  assert.equal(result.chosen?.knownCode, true);
});

test("LLM fallback is skipped when knownCodes is empty (no catalog = no LLM)", async () => {
  // Even with an LLM key configured, an empty catalog means LLM output
  // cannot be validated and must not be published — better to stay silent.
  const result = await detectArticle(
    "код товара какая-то невнятная фраза без чисел",
    {
      ...baseConfig,
      triggers: ["код товара"],
      knownCodes: new Set(),
      yandexgpt: { apiKey: "fake", folderId: "fake", endpoint: "http://127.0.0.1:1", model: "x" },
    },
  );
  // No fetch happens (catalog empty); status falls through to no_match.
  assert.equal(result.status, "no_match");
});

test("LLM fallback is skipped when YandexGPT keys are missing", async () => {
  // Symmetric guard: catalog present, LLM not configured — no fallback.
  const result = await detectArticle(
    "код товара какая-то невнятная фраза без чисел",
    {
      ...baseConfig,
      triggers: ["код товара"],
      knownCodes: new Set(["01234"]),
      yandexgpt: { apiKey: "", folderId: "", endpoint: "", model: "" },
    },
  );
  assert.equal(result.status, "no_match");
});

test("LLM fallback returns llm_error when fetch fails (used by ws-server early-exit)", async () => {
  // ws-server's detection loop breaks on llm_error to avoid hammering a
  // broken API. Verify the status surfaces so the guard has something to
  // key off. We point at a non-routable host to force fetch to throw.
  const result = await detectArticle(
    "код товара какая-то невнятная фраза без чисел",
    {
      ...baseConfig,
      triggers: ["код товара"],
      knownCodes: new Set(["01234"]),
      yandexgpt: { apiKey: "k", folderId: "f", endpoint: "http://127.0.0.1:1", model: "m" },
    },
  );
  assert.equal(result.status, "llm_error");
  assert.ok(typeof result.error === "string" && result.error.length > 0);
});

test("detectArticle parses multiplier-noun: 'два нуля 123' = 00123", async () => {
  // Operator's natural Russian: "two zeros 123" → "00123". Old parser saw
  // "два" as digit "2" and stopped on "нуля" (gen. sg., not in DIGIT_WORDS),
  // returning a phantom "2".
  const result = await detectArticle(
    "код товара два нуля 123",
    { ...baseConfig, triggers: ["код товара"] },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "00123");
});

test("detectArticle parses multiplier-noun: 'пять девяток' = 99999", async () => {
  // Same family of constructions: "five nines" = "99999". Old parser took
  // "пять" as cardinal 5 and stopped.
  const result = await detectArticle(
    "код товара пять девяток",
    { ...baseConfig, triggers: ["код товара"] },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "99999");
});

test("detectArticle parses 'два нуля' followed by digit-words", async () => {
  // Mixed: zeros declared via multiplier, then digit-words tail.
  // "два нуля три четыре четыре пять" → "003445".
  const result = await detectArticle(
    "код товара два нуля три четыре четыре пять",
    { ...baseConfig, triggers: ["код товара"] },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "003445");
});

test("detectArticle preserves 'два три' as digit-words '23' (not multiplier)", async () => {
  // Regression: "три" is NOT a digit-noun, so multiplier-noun check must
  // fall through and let DIGIT_WORDS treat "два" → "2", "три" → "3".
  const result = await detectArticle(
    "код товара два три",
    { ...baseConfig, triggers: ["код товара"] },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "23");
});

test("detectArticle: multiplier-noun extension after numeric prefix", async () => {
  // "артикул 01 два нуля 5" — mixed form. numericTokens picks "01", then
  // extendWithMixedDigits sees "два нуля" (multiplier) → "00", then "5".
  // Combined: "01005".
  const result = await detectArticle(
    "артикул 01 два нуля 5",
    { ...baseConfig, triggers: ["артикул"] },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.chosen?.code, "01005");
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
