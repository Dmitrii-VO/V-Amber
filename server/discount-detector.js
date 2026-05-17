const UNIT_WORDS = new Map([
  ["один", 1], ["одну", 1], ["одна", 1],
  ["два", 2], ["две", 2],
  ["три", 3], ["четыре", 4], ["пять", 5],
  ["шесть", 6], ["семь", 7], ["восемь", 8],
  ["девять", 9],
]);

const TEEN_WORDS = new Map([
  ["десять", 10], ["одиннадцать", 11], ["двенадцать", 12],
  ["тринадцать", 13], ["четырнадцать", 14], ["пятнадцать", 15],
  ["шестнадцать", 16], ["семнадцать", 17], ["восемнадцать", 18],
  ["девятнадцать", 19],
]);

const TENS_WORDS = new Map([
  ["двадцать", 20], ["тридцать", 30], ["сорок", 40],
  ["пятьдесят", 50], ["шестьдесят", 60], ["семьдесят", 70],
  ["восемьдесят", 80], ["девяносто", 90],
]);

const HUNDREDS_WORDS = new Map([
  ["сто", 100], ["двести", 200], ["триста", 300], ["четыреста", 400],
  ["пятьсот", 500], ["шестьсот", 600], ["семьсот", 700],
  ["восемьсот", 800], ["девятьсот", 900],
]);

const THOUSANDS_MULTIPLIERS = new Map([
  ["одна", 1], ["один", 1], ["две", 2], ["два", 2],
  ["три", 3], ["четыре", 4], ["пять", 5], ["шесть", 6],
  ["семь", 7], ["восемь", 8], ["девять", 9], ["десять", 10],
]);

function normalizeWord(w) {
  return w.toLowerCase().replace(/ё/g, "е");
}

function parseMonetaryWords(words) {
  const norm = words.map(normalizeWord);
  let value = 0;
  let i = 0;

  if (i < norm.length && /^тысяч[аи]?$/.test(norm[i])) {
    value += 1000;
    i++;
  } else if (i + 1 < norm.length && /^тысяч[аи]?$/.test(norm[i + 1])) {
    const mult = THOUSANDS_MULTIPLIERS.get(norm[i]);
    if (mult !== undefined) {
      value += mult * 1000;
      i += 2;
    }
  }

  if (i < norm.length && HUNDREDS_WORDS.has(norm[i])) {
    value += HUNDREDS_WORDS.get(norm[i]);
    i++;
  }

  if (i < norm.length && TEEN_WORDS.has(norm[i])) {
    value += TEEN_WORDS.get(norm[i]);
    i++;
  } else {
    if (i < norm.length && TENS_WORDS.has(norm[i])) {
      value += TENS_WORDS.get(norm[i]);
      i++;
    }
    if (i < norm.length && UNIT_WORDS.has(norm[i])) {
      value += UNIT_WORDS.get(norm[i]);
      i++;
    }
  }

  return value > 0 ? value : null;
}

// Matches "процент", "процентов", "%". Used to decide whether a captured
// number is a percent (scale by salePrice) or a ruble amount.
const PERCENT_RE = /(?:%|процент)/i;

export function detectDiscount(text, triggers) {
  const normalized = text.toLowerCase().replace(/ё/g, "е");

  const hasTrigger = triggers.some((t) => {
    const nt = t.toLowerCase().replace(/ё/g, "е");
    return new RegExp(`(?:^|\\s)${nt}(?:$|\\s)`).test(normalized);
  });

  if (!hasTrigger) {
    return null;
  }

  // 1) Digits with explicit percent — "скидка 30 процентов" / "скидка 30%".
  const digitPercentMatch = /скидк[ауеюи]?\s+(?:в\s+)?(\d+)\s*(?:%|процент\w*)/.exec(normalized);
  if (digitPercentMatch) {
    const percent = parseInt(digitPercentMatch[1], 10);
    if (percent > 0 && percent < 100) {
      return { kind: "percent", value: percent };
    }
  }

  // 2) Digits as rubles — "скидка 30", "скидка 30 рублей".
  const digitMatch = /скидк[ауеюи]?\s+(?:в\s+)?(\d+)(?:\s+руб(?:лей|ля)?)?/.exec(normalized);
  if (digitMatch) {
    const amount = parseInt(digitMatch[1], 10);
    if (amount > 0) return { kind: "absolute", value: amount };
  }

  // 3) Word numerals, possibly followed by "процент" → percent. Examples:
  //    "скидка пятьдесят процентов", "скидка тридцать процентов",
  //    "скидка сто рублей", "скидка пять".
  const wordMatch = /скидк[ауеюи]?\s+(?:в\s+)?(.+?)(?:\s+руб(?:лей|ля)?)?\s*$/.exec(normalized);
  if (wordMatch) {
    const tail = wordMatch[1].trim();
    const isPercent = PERCENT_RE.test(tail);
    const words = tail.replace(/\s+процент\w*$/i, "").trim().split(/\s+/);
    const amount = parseMonetaryWords(words);
    if (amount) {
      if (isPercent) {
        if (amount > 0 && amount < 100) return { kind: "percent", value: amount };
      } else {
        return { kind: "absolute", value: amount };
      }
    }
  }

  return null;
}
