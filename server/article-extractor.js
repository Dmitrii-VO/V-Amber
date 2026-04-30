const DIGIT_WORDS = new Map([
  ["ноль", "0"],
  ["ноля", "0"],
  ["нуль", "0"],
  ["один", "1"],
  ["одна", "1"],
  ["одну", "1"],
  ["два", "2"],
  ["две", "2"],
  ["три", "3"],
  ["четыре", "4"],
  ["пять", "5"],
  ["шесть", "6"],
  ["семь", "7"],
  ["восемь", "8"],
  ["девять", "9"],
]);

const UNIT_WORDS = new Map([
  ["ноль", 0],
  ["ноля", 0],
  ["нуль", 0],
  ["один", 1],
  ["одна", 1],
  ["одну", 1],
  ["два", 2],
  ["две", 2],
  ["три", 3],
  ["четыре", 4],
  ["пять", 5],
  ["шесть", 6],
  ["семь", 7],
  ["восемь", 8],
  ["девять", 9],
]);

const TEEN_WORDS = new Map([
  ["десять", 10],
  ["одиннадцать", 11],
  ["двенадцать", 12],
  ["тринадцать", 13],
  ["четырнадцать", 14],
  ["пятнадцать", 15],
  ["шестнадцать", 16],
  ["семнадцать", 17],
  ["восемнадцать", 18],
  ["девятнадцать", 19],
]);

const TENS_WORDS = new Map([
  ["двадцать", 20],
  ["тридцать", 30],
  ["сорок", 40],
  ["пятьдесят", 50],
  ["шестьдесят", 60],
  ["семьдесят", 70],
  ["восемьдесят", 80],
  ["девяносто", 90],
]);

const HUNDREDS_WORDS = new Map([
  ["сто", 100],
  ["двести", 200],
  ["триста", 300],
  ["четыреста", 400],
  ["пятьсот", 500],
  ["шестьсот", 600],
  ["семьсот", 700],
  ["восемьсот", 800],
  ["девятьсот", 900],
]);

const THOUSAND_WORDS = new Set(["тысяча", "тысячи", "тысяч"]);

const FILLER_WORDS = new Set([
  "это",
  "вот",
  "нам",
  "у",
  "нас",
  "позиция",
  "артикул",
  "товара",
  "товар",
  "модель",
  "номер",
  "код",
]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,!?;:()[\]{}"«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitWords(text) {
  return normalizeText(text).split(" ").filter(Boolean);
}

function isNumericWord(word) {
  return DIGIT_WORDS.has(word)
    || UNIT_WORDS.has(word)
    || TEEN_WORDS.has(word)
    || TENS_WORDS.has(word)
    || HUNDREDS_WORDS.has(word)
    || THOUSAND_WORDS.has(word);
}

function filterCandidatesByLength(candidates, config) {
  const minLength = Math.max(1, Number(config?.minLength || 1));
  const maxLength = Math.max(minLength, Number(config?.maxLength || 10));

  return candidates.filter((candidate) => candidate.code.length >= minLength && candidate.code.length <= maxLength);
}

function isCodeLengthAllowed(code, config) {
  const minLength = Math.max(1, Number(config?.minLength || 1));
  const maxLength = Math.max(minLength, Number(config?.maxLength || 10));

  return code.length >= minLength && code.length <= maxLength;
}

function parseDigitSequenceWords(words) {
  let consumed = 0;
  const digits = [];

  for (const word of words) {
    if (!DIGIT_WORDS.has(word)) {
      break;
    }

    digits.push(DIGIT_WORDS.get(word));
    consumed += 1;
  }

  if (digits.length < 2) {
    return null;
  }

  return {
    value: digits.join(""),
    consumed,
  };
}

function parseSubThousand(words) {
  let consumed = 0;
  let value = 0;
  let matched = false;
  let currentWord = consumed < words.length ? words[consumed] : undefined;

  if (HUNDREDS_WORDS.has(currentWord)) {
    value += HUNDREDS_WORDS.get(currentWord);
    consumed += 1;
    matched = true;
    currentWord = consumed < words.length ? words[consumed] : undefined;
  }

  if (TEEN_WORDS.has(currentWord)) {
    value += TEEN_WORDS.get(currentWord);
    consumed += 1;
    matched = true;
    return { value, consumed };
  }

  if (TENS_WORDS.has(currentWord)) {
    value += TENS_WORDS.get(currentWord);
    consumed += 1;
    matched = true;
    currentWord = consumed < words.length ? words[consumed] : undefined;

    if (UNIT_WORDS.has(currentWord) && UNIT_WORDS.get(currentWord) > 0) {
      value += UNIT_WORDS.get(currentWord);
      consumed += 1;
    }

    return { value, consumed };
  }

  if (UNIT_WORDS.has(currentWord)) {
    value += UNIT_WORDS.get(currentWord);
    consumed += 1;
    matched = true;
    return { value, consumed };
  }

  return matched ? { value, consumed } : null;
}

function parseCardinalNumber(words) {
  if (words.length === 0) {
    return null;
  }

  if (THOUSAND_WORDS.has(words[0])) {
    const remainder = parseSubThousand(words.slice(1));
    return {
      value: String(1000 + (remainder?.value || 0)),
      consumed: 1 + (remainder?.consumed || 0),
    };
  }

  const prefix = parseSubThousand(words);
  if (!prefix) {
    return null;
  }

  if (THOUSAND_WORDS.has(words[prefix.consumed])) {
    const remainder = parseSubThousand(words.slice(prefix.consumed + 1));
    return {
      value: String((prefix.value || 1) * 1000 + (remainder?.value || 0)),
      consumed: prefix.consumed + 1 + (remainder?.consumed || 0),
    };
  }

  return {
    value: String(prefix.value),
    consumed: prefix.consumed,
  };
}

function buildCandidateMap(candidates) {
  const unique = new Map();

  for (const candidate of candidates) {
    const existing = unique.get(candidate.code);
    if (!existing) {
      unique.set(candidate.code, {
        ...candidate,
        sources: [candidate.source].filter(Boolean),
      });
      continue;
    }

    const preferred = existing.confidence < candidate.confidence
      ? candidate
      : existing;
    const sources = [...new Set([
      ...(existing.sources || [existing.source].filter(Boolean)),
      ...(candidate.sources || [candidate.source].filter(Boolean)),
    ])];

    unique.set(candidate.code, {
      ...preferred,
      sources,
    });
  }

  return [...unique.values()].sort((left, right) => right.confidence - left.confidence);
}

function extractLeadingCandidatesFromSuffix(suffix, config) {
  const words = splitWords(suffix);
  let index = 0;

  while (index < words.length && FILLER_WORDS.has(words[index])) {
    index += 1;
  }

  const remainingWords = words.slice(index);
  if (remainingWords.length === 0) {
    return [];
  }

  const numericTokens = [];
  for (const word of remainingWords) {
    if (!/^\d{1,10}$/.test(word)) {
      break;
    }

    numericTokens.push(word);
  }

  if (numericTokens.length > 0) {
    return numericTokens.map((word, candidateIndex) => ({
      code: word,
      source: "regex",
      fragment: word,
      confidence: candidateIndex === 0 ? 1 : 0.95,
    }));
  }

  const digitSequence = parseDigitSequenceWords(remainingWords);
  if (digitSequence) {
    return [{
      code: digitSequence.value,
      source: "digit_words",
      fragment: remainingWords.slice(0, digitSequence.consumed).join(" "),
      confidence: 0.98,
    }];
  }

  const cardinalGroups = [];
  let cursor = 0;

  while (cursor < remainingWords.length) {
    const parsed = parseCardinalNumber(remainingWords.slice(cursor));
    if (!parsed) {
      break;
    }

    cardinalGroups.push({
      code: parsed.value,
      source: cardinalGroups.length === 0 ? "number_words" : "number_words_group",
      fragment: remainingWords.slice(cursor, cursor + parsed.consumed).join(" "),
      confidence: cardinalGroups.length === 0 ? 0.9 : 0.6,
    });

    cursor += parsed.consumed;
    if (cursor >= remainingWords.length) {
      break;
    }

    if (!isNumericWord(remainingWords[cursor])) {
      break;
    }
  }

  if (cardinalGroups.length >= 2) {
    const combinedCode = cardinalGroups.map((group) => group.code).join("");

    if (isCodeLengthAllowed(combinedCode, config)) {
      return [{
        code: combinedCode,
        source: "number_word_blocks",
        fragment: cardinalGroups.map((group) => group.fragment).join(" "),
        confidence: 0.97,
      }];
    }
  }

  return cardinalGroups;
}

function extractCandidatesByTriggers(text, triggers, config) {
  const normalized = normalizeText(text);
  const candidates = [];

  for (const trigger of triggers) {
    const normalizedTrigger = normalizeText(trigger);
    if (!normalizedTrigger) {
      continue;
    }

    const pattern = new RegExp(`(?:^|\\s)${escapeRegex(normalizedTrigger)}(?:$|\\s)(.{0,80})`, "g");
    let match = pattern.exec(normalized);

    while (match) {
      candidates.push(...extractLeadingCandidatesFromSuffix(match[1], config));
      match = pattern.exec(normalized);
    }
  }

  return candidates;
}

export function transcriptHasTrigger(text, triggers) {
  const normalized = normalizeText(text);

  return triggers.some((trigger) => {
    const normalizedTrigger = normalizeText(trigger);
    if (!normalizedTrigger) {
      return false;
    }

    const pattern = new RegExp(`(?:^|\\s)${escapeRegex(normalizedTrigger)}(?:$|\\s)`);
    return pattern.test(normalized);
  });
}

function isAwaitingContinuation(text, triggers) {
  const normalized = normalizeText(text);
  const fillerPattern = [...FILLER_WORDS].map(escapeRegex).join("|");

  return triggers.some((trigger) => {
    const normalizedTrigger = normalizeText(trigger);
    if (!normalizedTrigger) {
      return false;
    }

    const pattern = new RegExp(`(?:^|\\s)${escapeRegex(normalizedTrigger)}(?:\\s+(?:${fillerPattern}))*$`);
    return pattern.test(normalized);
  });
}

async function extractWithYandexGpt(text, config) {
  if (!config?.apiKey || !config?.folderId) {
    return null;
  }

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Api-Key ${config.apiKey}`,
      "x-folder-id": config.folderId,
    },
    body: JSON.stringify({
      modelUri: `gpt://${config.folderId}/${config.model}`,
      completionOptions: {
        stream: false,
        temperature: 0,
        maxTokens: 64,
      },
      messages: [
        {
          role: "system",
          text:
            "Извлеки артикул товара из русской фразы. Если найден один уверенный артикул, верни JSON {\"status\":\"confirmed\",\"codes\":[\"12345\"],\"confidence\":0.9}. Если есть несколько вариантов или низкая уверенность, верни {\"status\":\"ambiguous\",\"codes\":[\"12345\",\"1234\"],\"confidence\":0.3}. Если артикула нет, верни {\"status\":\"none\",\"codes\":[],\"confidence\":0}. Только JSON без пояснений.",
        },
        {
          role: "user",
          text,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`YandexGPT HTTP ${response.status}`);
  }

  const payload = await response.json();
  const textResult = payload?.result?.alternatives?.[0]?.message?.text?.trim();
  if (!textResult) {
    return null;
  }

  const parsed = JSON.parse(textResult);
  const codes = Array.isArray(parsed.codes)
    ? parsed.codes.filter((value) => typeof value === "string" && /^\d{1,10}$/.test(value))
    : [];

  return {
    status: parsed.status,
    candidates: codes.map((code) => ({
      code,
      source: "yandexgpt",
      fragment: text,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.6,
    })),
  };
}

export async function detectArticle(text, config) {
  const transcript = (text || "").trim();
  if (!transcript) {
    return {
      transcript,
      matchedTrigger: false,
      status: "no_match",
      candidates: [],
      chosen: null,
    };
  }

  const matchedTrigger = transcriptHasTrigger(transcript, config.triggers);
  const triggerCandidates = filterCandidatesByLength(
    buildCandidateMap(extractCandidatesByTriggers(transcript, config.triggers, config)),
    config,
  );

  if (triggerCandidates.length === 1) {
    return {
      transcript,
      matchedTrigger,
      status: "confirmed",
      candidates: triggerCandidates,
      chosen: triggerCandidates[0],
    };
  }

  if (triggerCandidates.length > 1) {
    return {
      transcript,
      matchedTrigger,
      status: "ambiguous",
      candidates: triggerCandidates.slice(0, 3),
      chosen: null,
    };
  }

  if (!matchedTrigger) {
    return {
      transcript,
      matchedTrigger: false,
      status: "no_match",
      candidates: [],
      chosen: null,
    };
  }

  if (isAwaitingContinuation(transcript, config.triggers)) {
    return {
      transcript,
      matchedTrigger,
      status: "awaiting_continuation",
      candidates: [],
      chosen: null,
    };
  }

  try {
    const llmResult = await extractWithYandexGpt(transcript, config.yandexgpt);
    const llmCandidates = filterCandidatesByLength(buildCandidateMap(llmResult?.candidates || []), config);

    if (llmCandidates.length === 1 && llmResult?.status !== "ambiguous") {
      return {
        transcript,
        matchedTrigger,
        status: "confirmed",
        candidates: llmCandidates,
        chosen: llmCandidates[0],
      };
    }

    if (llmCandidates.length > 0) {
      return {
        transcript,
        matchedTrigger,
        status: "ambiguous",
        candidates: llmCandidates.slice(0, 3),
        chosen: null,
      };
    }
  } catch (error) {
    return {
      transcript,
      matchedTrigger,
      status: "llm_error",
      candidates: [],
      chosen: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    transcript,
    matchedTrigger,
    status: "no_match",
    candidates: [],
    chosen: null,
  };
}
