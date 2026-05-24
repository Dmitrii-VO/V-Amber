import test from "node:test";
import assert from "node:assert/strict";

import { detectPrice } from "../server/price-detector.js";

test("detectPrice extracts numeric стоимость", () => {
  assert.deepEqual(detectPrice("код товара 12345 стоимость 1500"), {
    value: 1500,
    trigger: "стоимость",
  });
});

test("detectPrice extracts spoken price with fillers", () => {
  assert.deepEqual(detectPrice("стоимость такая то тысяча пятьсот"), {
    value: 1500,
    trigger: "стоимость",
  });
});

test("detectPrice ignores text without price trigger", () => {
  assert.equal(detectPrice("код товара 12345"), null);
});
