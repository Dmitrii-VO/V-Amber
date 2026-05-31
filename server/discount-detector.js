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

  if (
    norm.length === 2
    && UNIT_WORDS.has(norm[0])
    && HUNDREDS_WORDS.has(norm[1])
  ) {
    return UNIT_WORDS.get(norm[0]) * 1000 + HUNDREDS_WORDS.get(norm[1]);
  }

  if (i < norm.length && /^тысяч[ауи]?$/.test(norm[i])) {
    value += 1000;
    i++;
  } else if (i + 1 < norm.length && /^тысяч[ауи]?$/.test(norm[i + 1])) {
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

  return value > 0 && i === norm.length ? value : null;
}

function tokenize(normalized) {
  // Сначала отделяем «%» от цифр («30%» → «30 %»), иначе склеенный
  // токен «30%» не распознаётся как percent: isPercentToken проверяет
  // ровно «%» или префикс «процент».
  const split = normalized.replace(/(\d)\s*%/g, "$1 %");
  return split.match(/[a-zа-я0-9%]+/gi) || [];
}

function isPercentToken(token) {
  return token === "%" || /^процент/.test(token);
}

function isDiscountToken(token) {
  return /^скидк/.test(token) || /^скидоч/.test(token);
}

function isRubToken(token) {
  return /^руб/.test(token);
}

function isNumberFillerToken(token) {
  return token === "целых" || token === "целые" || token === "целая";
}

function hasDiscountContext(tokens, startIndex, endIndex) {
  const from = Math.max(0, startIndex - 6);
  const to = Math.min(tokens.length - 1, endIndex + 6);

  for (let i = from; i <= to; i += 1) {
    if (isDiscountToken(tokens[i]) && tokens[i - 1] !== "без") {
      return true;
    }
  }

  for (let i = Math.max(0, startIndex - 4); i < startIndex; i += 1) {
    if (tokens[i] === "минус") {
      return true;
    }
  }

  return false;
}

function parseNumericToken(token) {
  return /^\d+$/.test(token) ? parseInt(token, 10) : null;
}

function detectPercent(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isPercentToken(tokens[i])) continue;

    let beforeEnd = i;
    while (beforeEnd > 0 && isNumberFillerToken(tokens[beforeEnd - 1])) {
      beforeEnd -= 1;
    }

    if (beforeEnd > 0) {
      const digitValue = parseNumericToken(tokens[beforeEnd - 1]);
      if (digitValue && digitValue > 0 && digitValue < 100 && hasDiscountContext(tokens, beforeEnd - 1, i)) {
        return { kind: "percent", value: digitValue };
      }
    }

    for (let len = Math.min(4, beforeEnd); len >= 1; len -= 1) {
      const start = beforeEnd - len;
      const value = parseMonetaryWords(tokens.slice(start, beforeEnd));
      if (value && value > 0 && value < 100 && hasDiscountContext(tokens, start, i)) {
        return { kind: "percent", value };
      }
    }

    if (i + 1 < tokens.length) {
      const digitValue = parseNumericToken(tokens[i + 1]);
      if (digitValue && digitValue > 0 && digitValue < 100 && hasDiscountContext(tokens, i + 1, i + 1)) {
        return { kind: "percent", value: digitValue };
      }
    }

    for (let len = 1; len <= Math.min(4, tokens.length - i - 1); len += 1) {
      const value = parseMonetaryWords(tokens.slice(i + 1, i + 1 + len));
      if (value && value > 0 && value < 100 && hasDiscountContext(tokens, i + 1, i + len)) {
        return { kind: "percent", value };
      }
    }
  }

  return null;
}

function detectAbsolute(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isDiscountToken(tokens[i]) || tokens[i - 1] === "без") continue;

    for (let j = i + 1; j < Math.min(tokens.length, i + 5); j += 1) {
      const digitValue = parseNumericToken(tokens[j]);
      if (digitValue && digitValue > 0) {
        return { kind: "absolute", value: digitValue };
      }

      for (let len = 1; len <= Math.min(4, tokens.length - j); len += 1) {
        const value = parseMonetaryWords(tokens.slice(j, j + len));
        const hasRubToken = isRubToken(tokens[j + len]);
        const isSmallBareAmount = value < 100 && j + len === tokens.length;
        if (value && (hasRubToken || isSmallBareAmount)) {
          return { kind: "absolute", value };
        }
      }
    }
  }

  return null;
}

export function detectDiscount(text, triggers) {
  const normalized = text.toLowerCase().replace(/ё/g, "е");
  const tokens = tokenize(normalized);

  const hasTrigger = triggers.some((t) => {
    const nt = t.toLowerCase().replace(/ё/g, "е");
    return new RegExp(`(?:^|\\s)${nt}(?:$|\\s)`).test(normalized);
  }) || tokens.some((token, index) => isDiscountToken(token) && tokens[index - 1] !== "без");

  const percent = detectPercent(tokens);
  if (percent) return percent;

  if (!hasTrigger) return null;

  const absolute = detectAbsolute(tokens);
  if (absolute) return absolute;

  return null;
}
