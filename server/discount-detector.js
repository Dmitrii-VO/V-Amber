// parseMonetaryWords раньше был локальной копией — теперь живёт в
// ru-numerals.js рядом со словарями (единственный источник для price/discount).
import { parseMonetaryWords } from "./ru-numerals.js";

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
