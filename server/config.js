import "dotenv/config";
import { resolveVkConfig } from "./vk.js";

function parseCsvEnv(value, fallback = []) {
  if (!value?.trim()) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArticleTriggers(value) {
  const configured = parseCsvEnv(value, ["код товара"])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const triggers = new Set(configured);

  if (triggers.has("код товара") || triggers.has("артикул")) {
    triggers.add("код товара");
    triggers.add("артикул");
  }

  return [...triggers];
}

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const config = {
  port: Number(process.env.PORT || 8080),
  vk: resolveVkConfig(process.env),
  moysklad: {
    baseUrl: process.env.MOYSKLAD_BASE_URL?.trim() || "https://api.moysklad.ru/api/remap/1.2/",
    token: process.env.MOYSKLAD_TOKEN?.trim() || "",
    login: process.env.MOYSKLAD_LOGIN?.trim() || "",
    password: process.env.MOYSKLAD_PASSWORD?.trim() || "",
    organizationId: process.env.MOYSKLAD_ORGANIZATION_ID?.trim() || "",
    storeId: process.env.MOYSKLAD_STORE_ID?.trim() || "",
    preferredStoreName: process.env.MOYSKLAD_PREFERRED_STORE_NAME?.trim() || "Аукцион",
    customerOrderStateId: process.env.MOYSKLAD_CUSTOMER_ORDER_STATE_ID?.trim() || "",
    salesChannelId: process.env.MOYSKLAD_SALES_CHANNEL_ID?.trim() || "",
    imageDownloadTimeoutMs: parseIntEnv(process.env.MOYSKLAD_IMAGE_DOWNLOAD_TIMEOUT_MS, 10000),
  },
  articleExtraction: {
    triggers: parseArticleTriggers(process.env.VOICE_ARTICLE_TRIGGERS),
    minLength: parseIntEnv(process.env.VOICE_ARTICLE_MIN_LENGTH, 1),
    maxLength: parseIntEnv(process.env.VOICE_ARTICLE_MAX_LENGTH, 10),
    finalBufferSize: parseIntEnv(process.env.VOICE_ARTICLE_FINAL_BUFFER_SIZE, 3),
    triggerWindowMs: parseIntEnv(process.env.VOICE_ARTICLE_TRIGGER_WINDOW_MS, 8000),
    notificationDedupMs: parseIntEnv(process.env.VOICE_ARTICLE_NOTIFICATION_DEDUP_MS, 15000),
    yandexgpt: {
      apiKey: process.env.YANDEX_GPT_API_KEY?.trim() || process.env.YANDEX_SPEECHKIT_API_KEY?.trim() || "",
      folderId: process.env.YANDEX_GPT_FOLDER_ID?.trim() || process.env.YANDEX_SPEECHKIT_FOLDER_ID?.trim() || "",
      model: process.env.YANDEX_GPT_MODEL?.trim() || "yandexgpt-5-lite/latest",
      endpoint: process.env.YANDEX_GPT_ENDPOINT?.trim() || "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    },
  },
  discount: {
    triggers: parseCsvEnv(process.env.VOICE_DISCOUNT_TRIGGERS, ["скидка", "скидку", "скидки"]),
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",
    chatIds: parseCsvEnv(process.env.TELEGRAM_CHAT_ID, []),
    primaryChatId: parseCsvEnv(process.env.TELEGRAM_CHAT_ID, [])[0] || "",
    pollingTimeoutSec: parseIntEnv(process.env.TELEGRAM_POLLING_TIMEOUT_SEC, 30),
    confirmationTtlMs: parseIntEnv(process.env.TELEGRAM_CONFIRMATION_TTL_MS, 300000),
  },
  speechkit: {
    apiKey: getRequiredEnv("YANDEX_SPEECHKIT_API_KEY"),
    folderId: process.env.YANDEX_SPEECHKIT_FOLDER_ID?.trim() || "",
    sendFolderHeader: process.env.YANDEX_SPEECHKIT_SEND_FOLDER_HEADER === "1",
    lang: process.env.YANDEX_SPEECHKIT_LANG?.trim() || "ru-RU",
    model: process.env.YANDEX_SPEECHKIT_MODEL?.trim() || "general",
    sampleRate: 16000,
    endpoint: "stt.api.cloud.yandex.net:443",
  },
};

if (config.articleExtraction.minLength > config.articleExtraction.maxLength) {
  throw new Error(
    `VOICE_ARTICLE_MIN_LENGTH (${config.articleExtraction.minLength}) must be <= VOICE_ARTICLE_MAX_LENGTH (${config.articleExtraction.maxLength})`,
  );
}

if (!config.articleExtraction.yandexgpt.apiKey || !config.articleExtraction.yandexgpt.folderId) {
  process.emitWarning(
    "YandexGPT fallback disabled: set YANDEX_GPT_API_KEY and YANDEX_GPT_FOLDER_ID (or SpeechKit equivalents).",
  );
}
