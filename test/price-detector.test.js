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

test("detectPrice extracts spoken digits sequence", () => {
  assert.deepEqual(detectPrice("цена два пять пять ноль"), {
    value: 2550,
    trigger: "цена",
  });
});

test("detectPrice ignores text without price trigger", () => {
  assert.equal(detectPrice("код товара 12345"), null);
});

// Этап 6: «тысячу» (винительный падеж) — частая операторская форма,
// до этого падала к «пятьсот», потому что regex принимал только
// «тысяча»/«тысячи».
test("detectPrice handles «тысячу» (accusative form)", () => {
  assert.deepEqual(detectPrice("цена тысячу пятьсот"), {
    value: 1500,
    trigger: "цена",
  });
  assert.deepEqual(detectPrice("стоимость тысячу"), {
    value: 1000,
    trigger: "стоимость",
  });
});
