export function normalizeKnownCodes(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Set) {
    return value;
  }

  if (Array.isArray(value)) {
    return new Set(value.map((code) => String(code || "").trim()).filter(Boolean));
  }

  return null;
}

function stripLeadingZeros(code) {
  return code.replace(/^0+/, "") || "0";
}

function isNumericCode(code) {
  return /^\d+$/.test(code);
}

export function resolveKnownCode(code, knownCodesValue) {
  const rawCode = String(code || "").trim();
  const knownCodes = normalizeKnownCodes(knownCodesValue);
  if (!rawCode || !knownCodes || knownCodes.size === 0) {
    return { status: "no_catalog", code: rawCode, candidates: [] };
  }

  if (knownCodes.has(rawCode)) {
    return { status: "matched", code: rawCode, originalCode: rawCode, reason: "exact", candidates: [rawCode] };
  }

  if (!isNumericCode(rawCode)) {
    return { status: "not_found", code: rawCode, candidates: [] };
  }

  const significantCode = stripLeadingZeros(rawCode);
  const significantMatches = [...knownCodes]
    .map((knownCode) => String(knownCode || "").trim())
    .filter((knownCode) => isNumericCode(knownCode) && stripLeadingZeros(knownCode) === significantCode);

  if (significantMatches.length === 1) {
    return {
      status: "matched",
      code: significantMatches[0],
      originalCode: rawCode,
      reason: "leading_zeros",
      candidates: significantMatches,
    };
  }

  if (significantMatches.length > 1) {
    return { status: "ambiguous", code: rawCode, candidates: significantMatches };
  }

  return { status: "not_found", code: rawCode, candidates: [] };
}

export function resolveKnownCodePrefix(code, knownCodesValue, options = {}) {
  const rawCode = String(code || "").trim();
  const knownCodes = normalizeKnownCodes(knownCodesValue);
  if (!rawCode || !knownCodes || knownCodes.size === 0) {
    return { status: "no_catalog", code: rawCode, candidates: [] };
  }

  const minLength = Math.max(1, Number(options?.minLength || 1));
  for (let length = rawCode.length - 1; length >= minLength; length -= 1) {
    const prefix = rawCode.slice(0, length);
    if (knownCodes.has(prefix)) {
      return {
        status: "matched",
        code: prefix,
        originalCode: rawCode,
        reason: "prefix",
        candidates: [prefix],
      };
    }
  }

  if (!isNumericCode(rawCode)) {
    return { status: "not_found", code: rawCode, candidates: [] };
  }

  const significantCode = stripLeadingZeros(rawCode);
  const significantMatches = [...knownCodes]
    .map((knownCode) => String(knownCode || "").trim())
    .filter((knownCode) => {
      if (!isNumericCode(knownCode)) return false;
      const significantKnownCode = stripLeadingZeros(knownCode);
      return significantKnownCode.length >= minLength && significantCode.startsWith(significantKnownCode);
    })
    .sort((left, right) => stripLeadingZeros(right).length - stripLeadingZeros(left).length);

  if (significantMatches.length === 0) {
    return { status: "not_found", code: rawCode, candidates: [] };
  }

  const bestLength = stripLeadingZeros(significantMatches[0]).length;
  const bestMatches = significantMatches.filter((knownCode) => stripLeadingZeros(knownCode).length === bestLength);
  if (bestMatches.length === 1) {
    return {
      status: "matched",
      code: bestMatches[0],
      originalCode: rawCode,
      reason: "leading_zeros_prefix",
      candidates: bestMatches,
    };
  }

  return { status: "ambiguous", code: rawCode, candidates: bestMatches };
}
