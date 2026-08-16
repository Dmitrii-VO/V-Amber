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

// Нормализация по ведущим нулям работает в обе стороны, но стороны неравноценны.
//
// «3172» → «03172» (кандидат КОРОЧЕ каталожного) — обычный недобор padding'а,
// оператор просто не проговорил ведущий ноль. Всегда разрешаем.
//
// «002» → «02» (кандидат ДЛИННЕЕ каталожного) — почти всегда обрывок недослышанной
// фразы. 2026-07-26 17:06:53 такой обрывок из «артикул ноль ноль два двести
// шестьдесят шесть» сматчился с реальным, но посторонним товаром «02» (Заколка
// Янтарная) вместо 00266, и его карточка ушла в VK. Разрешаем это направление
// только когда значимая часть достаточно длинная, чтобы не быть случайной:
// оговорка даёт 1-2 значимые цифры, настоящий код — три и больше.
//
// Цена: товар с каталожным кодом в 1-2 значимые цифры («02») больше нельзя
// назвать с лишними нулями — только «артикул два» или руками. Таких кодов единицы,
// а цена ошибки — чужая карточка в публичном эфире.
const MIN_SIGNIFICANT_DIGITS_FOR_ZERO_TRIM = 3;

// Минимальная длина кода, до которой можно дорезать префикс. Только для
// размытого восстановления — точное совпадение и нормализация нулей работают
// на любой длине. Подробности у места использования.
const MIN_PREFIX_FALLBACK_LENGTH = 4;

function isSafeZeroNormalization(rawCode, knownCode) {
  if (rawCode.length <= knownCode.length) {
    return true;
  }

  return stripLeadingZeros(knownCode).length >= MIN_SIGNIFICANT_DIGITS_FOR_ZERO_TRIM;
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
    .filter((knownCode) => isNumericCode(knownCode)
      && stripLeadingZeros(knownCode) === significantCode
      && isSafeZeroNormalization(rawCode, knownCode));

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

  // Пол размытого восстановления. Раньше префикс резался до любой длины,
  // до которой каталог что-нибудь подтвердит: «ноль пять восемь восемь» →
  // 0588 → 058 (нет) → 05 (есть) — и в эфир уходила «Заколка», а не браслет.
  // Так же появились 07, 02 и 03 из «ноль три семь один ноль».
  //
  // Ограничение стоит именно на ДОГАДКЕ, а не на каталоге: короткие коды —
  // законные данные (спецификация использует 402, тесты фиксируют 02, 03,
  // 017), и точное разрешение (resolveKnownCode) их по-прежнему открывает.
  // Границы длин из каталога тут не помощник: deriveCodeLengthBounds снимает
  // ведущие нули, поэтому их пол и так равен 1.
  const minLength = Math.max(1, Number(options?.minLength || 1));
  const prefixFloor = Math.max(MIN_PREFIX_FALLBACK_LENGTH, minLength);
  for (let length = rawCode.length - 1; length >= prefixFloor; length -= 1) {
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
      // Пол по сырой длине — тот же, что у обрезки префикса, иначе размытое
      // восстановление просто переезжает в эту ветку. Плюс пол по ЗНАЧИМОЙ
      // части, тот же порог, что у нормализации нулей: «ноль ноль ноль
      // пятнадцать» (00015, реальный код 015) значимой частью «15» цеплялось
      // за «00001» со значимой «1» и открывало посторонний товар. Одна
      // значимая цифра — это уже не восстановление, а угадывание.
      return knownCode.length >= prefixFloor
        && significantKnownCode.length >= Math.max(minLength, MIN_SIGNIFICANT_DIGITS_FOR_ZERO_TRIM)
        && significantCode.startsWith(significantKnownCode)
        // Тот же предохранитель, что в resolveKnownCode: обрывок «002» не должен
        // дотягиваться до постороннего короткого кода «02» (инцидент 26.07).
        && isSafeZeroNormalization(rawCode, knownCode);
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
