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
  host: process.env.HOST?.trim() || "0.0.0.0",
  vk: resolveVkConfig(process.env),
  moysklad: {
    baseUrl: process.env.MOYSKLAD_BASE_URL?.trim() || "https://api.moysklad.ru/api/remap/1.2/",
    login: process.env.MOYSKLAD_LOGIN?.trim() || "",
    password: process.env.MOYSKLAD_PASSWORD?.trim() || "",
    organizationId: process.env.MOYSKLAD_ORGANIZATION_ID?.trim() || "",
    preferredOrganizationName: process.env.MOYSKLAD_PREFERRED_ORGANIZATION_NAME?.trim() || "ИП Куницына Татьяна Васильевна",
    storeId: process.env.MOYSKLAD_STORE_ID?.trim() || "",
    preferredStoreName: process.env.MOYSKLAD_PREFERRED_STORE_NAME?.trim() || "Основной склад",
    // Склады, которые исключаются из суммарного остатка для stock guard и UI.
    // По умолчанию исключаем «Брак» — товар там физически непродаваем.
    excludedStoreNames: parseCsvEnv(process.env.MOYSKLAD_EXCLUDED_STORE_NAMES, ["Брак"]),
    customerOrderStateId: process.env.MOYSKLAD_CUSTOMER_ORDER_STATE_ID?.trim() || "",
    salesChannelId: process.env.MOYSKLAD_SALES_CHANNEL_ID?.trim() || "",
    vkIdAttributeId: process.env.MOYSKLAD_VK_ID_ATTRIBUTE_ID?.trim() || "",
    vkIdAttributeName: process.env.MOYSKLAD_VK_ID_ATTRIBUTE_NAME?.trim() || "VK ID",
    imageDownloadTimeoutMs: parseIntEnv(process.env.MOYSKLAD_IMAGE_DOWNLOAD_TIMEOUT_MS, 10000),
    requestTimeoutMs: parseIntEnv(process.env.MOYSKLAD_REQUEST_TIMEOUT_MS, 8000),
    // Отдельный потолок для bulk-операций (загрузка каталога продуктов).
    // 60с обычно хватает на ~3-5 тысяч позиций; если каталог больше или
    // сеть медленная — поднимите вручную через MOYSKLAD_BULK_REQUEST_TIMEOUT_MS.
    bulkRequestTimeoutMs: parseIntEnv(process.env.MOYSKLAD_BULK_REQUEST_TIMEOUT_MS, 60000),
  },
  articleExtraction: {
    triggers: parseArticleTriggers(process.env.VOICE_ARTICLE_TRIGGERS),
    minLength: parseIntEnv(process.env.VOICE_ARTICLE_MIN_LENGTH, 1),
    maxLength: parseIntEnv(process.env.VOICE_ARTICLE_MAX_LENGTH, 10),
    finalBufferSize: parseIntEnv(process.env.VOICE_ARTICLE_FINAL_BUFFER_SIZE, 3),
    triggerWindowMs: parseIntEnv(process.env.VOICE_ARTICLE_TRIGGER_WINDOW_MS, 8000),
    // YandexGPT fallback: вызывается ТОЛЬКО когда regex ничего не вернул,
    // триггер найден и каталог продуктов загружен. Кандидаты от LLM
    // обязательно проходят валидацию через knownCodes — выдуманный артикул
    // не может попасть в публикацию.
    yandexgpt: {
      apiKey: process.env.YANDEX_GPT_API_KEY?.trim() || "",
      folderId: process.env.YANDEX_GPT_FOLDER_ID?.trim() || "",
      model: process.env.YANDEX_GPT_MODEL?.trim() || "yandexgpt-lite/latest",
      endpoint: process.env.YANDEX_GPT_ENDPOINT?.trim() || "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    },
  },
  discount: {
    triggers: parseCsvEnv(process.env.VOICE_DISCOUNT_TRIGGERS, ["скидка", "скидку", "скидки"]),
  },
  // Wish list / лист предзаказов. Эти значения — fallback по умолчанию,
  // settings.json в logs/ перекрывает их. Не клади сюда секреты — файл попадает
  // в диагностический ZIP.
  wishlist: {
    notifyVkOnAdd: process.env.WISHLIST_NOTIFY_VK === "1",
    oldDaysThreshold: parseIntEnv(process.env.WISHLIST_OLD_DAYS_THRESHOLD, 7),
    defaultSupplierId: process.env.MOYSKLAD_DEFAULT_SUPPLIER_ID?.trim() || "",
    defaultStoreId: process.env.MOYSKLAD_DEFAULT_PURCHASE_STORE_ID?.trim() || "",
    descriptionTemplate: process.env.WISHLIST_DESCRIPTION_TEMPLATE?.trim()
      || "Предзаказ из эфира {date}. Артикулы: {codes}",
  },
  speechkit: {
    apiKey: getRequiredEnv("YANDEX_SPEECHKIT_API_KEY"),
    folderId: process.env.YANDEX_SPEECHKIT_FOLDER_ID?.trim() || "",
    sendFolderHeader: process.env.YANDEX_SPEECHKIT_SEND_FOLDER_HEADER === "1",
    lang: process.env.YANDEX_SPEECHKIT_LANG?.trim() || "ru-RU",
    model: process.env.YANDEX_SPEECHKIT_MODEL?.trim() || "general",
    sampleRate: 16000,
    endpoint: "stt.api.cloud.yandex.net:443",
    // Yandex закрывает streaming-сессию через ~10 мин. Переподключаемся
    // ПРОАКТИВНО чуть раньше, чтобы не терять аудио в окне реактивного
    // реконнекта по событию stream end.
    reconnectIntervalMs: parseIntEnv(process.env.YANDEX_SPEECHKIT_RECONNECT_MS, 9 * 60 * 1000),
    // Порог уверенности финального распознавания (0..1). При 0 (по умолчанию)
    // гейт выключен. ВНИМАНИЕ: Yandex STT v3 сейчас всегда отдаёт confidence=0
    // («Currently is not used» в SDK), поэтому порог дремлет до тех пор, пока
    // поле не начнут заполнять. Срабатывает только на положительный confidence
    // ниже порога — на нулевом/отсутствующем значении транскрипт не режется.
    // Клампим в [0..1]: мусорный порог (1.1, 70, Infinity) иначе зарезал бы
    // все финалы, когда confidence начнут заполнять; NaN → 0 (гейт выключен).
    minConfidence: Math.min(1, Math.max(0, Number.parseFloat(process.env.YANDEX_SPEECHKIT_MIN_CONFIDENCE) || 0)),
  },
};

if (config.articleExtraction.minLength > config.articleExtraction.maxLength) {
  throw new Error(
    `VOICE_ARTICLE_MIN_LENGTH (${config.articleExtraction.minLength}) must be <= VOICE_ARTICLE_MAX_LENGTH (${config.articleExtraction.maxLength})`,
  );
}
