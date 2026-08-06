import "dotenv/config";
import { resolveVkConfig } from "./vk.js";

// Разделитель по умолчанию — запятая; «|» передают там, где запятая является
// частью самой фразы (см. CROSS_PROMO_*_VARIANTS).
function parseListEnv(value, fallback = [], separator = ",") {
  if (!value?.trim()) {
    return fallback;
  }

  return value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArticleTriggers(value) {
  const configured = parseListEnv(value, ["код товара"])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const triggers = new Set(configured);

  // Если используются стандартные триггеры — гарантируем все формы, включая
  // сокращённые «код» и «артикул». Так «код 01234» (без «товара») тоже
  // открывает лот. «код» матчится как отдельное слово (regex с границами),
  // а «товара» в «код товара 01234» отрезается как filler в article-extractor.
  if (triggers.has("код товара") || triggers.has("артикул") || triggers.has("код")) {
    triggers.add("код товара");
    triggers.add("артикул");
    triggers.add("код");
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
    excludedStoreNames: parseListEnv(process.env.MOYSKLAD_EXCLUDED_STORE_NAMES, ["Брак"]),
    customerOrderStateId: process.env.MOYSKLAD_CUSTOMER_ORDER_STATE_ID?.trim() || "",
    salesChannelId: process.env.MOYSKLAD_SALES_CHANNEL_ID?.trim() || "",
    vkIdAttributeId: process.env.MOYSKLAD_VK_ID_ATTRIBUTE_ID?.trim() || "",
    vkIdAttributeName: process.env.MOYSKLAD_VK_ID_ATTRIBUTE_NAME?.trim() || "VK ID",
    imageDownloadTimeoutMs: parseIntEnv(process.env.MOYSKLAD_IMAGE_DOWNLOAD_TIMEOUT_MS, 10000),
    requestTimeoutMs: parseIntEnv(process.env.MOYSKLAD_REQUEST_TIMEOUT_MS, 8000),
    // Повтор ЗАПИСЕЙ брони (журнал write-journal.js). Держим низким намеренно:
    // повтор идёт по горячему пути брони, покупатель ждёт ответа в эфире, а
    // каждая попытка стоит до requestTimeoutMs. 2 = одна повторная попытка.
    writeRetryAttempts: parseIntEnv(process.env.MOYSKLAD_WRITE_RETRY_ATTEMPTS, 2),
    writeRetryBaseDelayMs: parseIntEnv(process.env.MOYSKLAD_WRITE_RETRY_BASE_DELAY_MS, 400),
    // Отдельный потолок для bulk-операций (загрузка каталога продуктов).
    // 60с обычно хватает на ~3-5 тысяч позиций; если каталог больше или
    // сеть медленная — поднимите вручную через MOYSKLAD_BULK_REQUEST_TIMEOUT_MS.
    bulkRequestTimeoutMs: parseIntEnv(process.env.MOYSKLAD_BULK_REQUEST_TIMEOUT_MS, 60000),
    // Эфиры идут несколько дней подряд = одна кампания. При включённом флаге
    // брони клиента дописываются в его ПОСЛЕДНИЙ открытый #Эфир-заказ независимо
    // от дня (а не создаётся новый заказ на каждую дату). Новый заказ заводится
    // только когда у клиента нет открытого #Эфир-заказа (оператор закрыл/упаковал
    // прошлый → следующая бронь начинает новый). Откат к прежнему поведению
    // (мердж только в пределах одной даты): MOYSKLAD_CROSS_DAY_ORDER_MERGE=0.
    // См. reservation-flow.md «Customer-order merging across campaign days».
    crossDayOrderMerge: process.env.MOYSKLAD_CROSS_DAY_ORDER_MERGE !== "0",
    // Окно кампании в днях: при crossDayOrderMerge бронь дописывается в
    // существующий заказ, только если последняя активность в нём (самый свежий
    // маркер `#Эфир <дата>`) была не дальше этого числа дней. Заказ старше →
    // новая кампания → новый заказ. Покрывает эфиры подряд с пропуском 1-2 дней.
    campaignMaxGapDays: parseIntEnv(process.env.MOYSKLAD_CAMPAIGN_MAX_GAP_DAYS, 3),
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
    triggers: parseListEnv(process.env.VOICE_DISCOUNT_TRIGGERS, ["скидка", "скидку", "скидки"]),
  },
  // Периодическая инструкция зрителям: как бронировать и как отменять.
  // Зрители подключаются к эфиру в разное время, и объяснять формат голосом
  // каждые полчаса оператору некогда. Варианты текста чередуются: VK режет
  // подряд идущие одинаковые комментарии под одним видео.
  viewerInstructions: {
    enabled: process.env.VIEWER_INSTRUCTIONS_ENABLED !== "0",
    intervalMinutes: parseIntEnv(process.env.VIEWER_INSTRUCTIONS_INTERVAL_MIN, 30),
    // Первая инструкция — вскоре после старта, а не через полчаса: зрители
    // первой половины часа иначе не увидят её вообще.
    firstDelayMinutes: parseIntEnv(process.env.VIEWER_INSTRUCTIONS_FIRST_DELAY_MIN, 2),
    variants: parseListEnv(process.env.VIEWER_INSTRUCTIONS_VARIANTS, [
      "Как забронировать: напишите в комментариях номер артикула — просто цифры, например 03204. Передумали — напишите «отмена 03204».",
      "Бронь — это номер артикула отдельным комментарием, например 03204. Нужно несколько — «03204 2 шт». Отказ — «отмена 03204».",
      "Напоминаем: бронируем номером артикула в комментариях (03204). Отменить бронь — «отмена 03204». Нет в наличии — напишите «список 03204».",
    ]),
  },
  // Перекрёстные подсказки между площадками: эфир идёт одновременно в ВК и на
  // своей площадке (мультистрим на стороне OBS), у обеих бывают проблемы с
  // качеством — и зритель должен знать про запасной экран. Тексты разные для
  // разных каналов: в ВК зовём на свой сайт, в чате /efir/ — в ВК.
  //
  // Разделитель вариантов — «|», а не запятая: тексты со ссылкой и вводным
  // оборотом почти всегда содержат запятую, и CSV-парсер порезал бы их
  // посередине (ровно эта грабля уже была в VIEWER_INSTRUCTIONS_VARIANTS).
  crossPromo: {
    enabled: process.env.CROSS_PROMO_ENABLED !== "0",
    // Как часто публикуем сообщения. Реже инструкций (30 мин) и со сдвигом
    // первого запуска, чтобы два служебных сообщения не приходили встык.
    intervalMinutes: parseIntEnv(process.env.CROSS_PROMO_INTERVAL_MIN, 25),
    firstDelayMinutes: parseIntEnv(process.env.CROSS_PROMO_FIRST_DELAY_MIN, 12),
    // Отдельный, более частый такт: проверка «жива ли вторая площадка» и
    // обновление плашки со ссылкой на странице зрителя. Плашка должна
    // появляться и гаснуть вслед за ВК-эфиром, а не раз в 25 минут.
    probeIntervalMinutes: parseIntEnv(process.env.CROSS_PROMO_PROBE_INTERVAL_MIN, 5),
    // {url} → ссылка на свою площадку (STREAM_VIEWER_URL).
    vkVariants: parseListEnv(process.env.CROSS_PROMO_VK_VARIANTS, [
      "Плохо идёт видео или пропадает звук? Тот же эфир у нас на сайте: {url}",
      "Если картинка подвисает — тот же эфир идёт здесь: {url}",
    ], "|"),
    // В чате ссылку не даём текстом: страница рисует сообщения textContent'ом,
    // и URL был бы некликабельным. Кликабельная ссылка живёт в плашке под
    // плеером, сообщение лишь показывает на неё.
    chatVariants: parseListEnv(process.env.CROSS_PROMO_CHAT_VARIANTS, [
      "Тормозит видео или нет звука? Тот же эфир идёт в ВК — ссылка под плеером.",
      "Если картинка подвисает, эфир можно смотреть в ВК — ссылка под плеером.",
    ], "|"),
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
  // Собственный RTMP/HLS-стрим (MediaMTX) как альтернатива VK Live.
  // Опционально: без STREAM_MEDIAMTX_API_URL панель "Стрим" в дашборде скрыта.
  stream: {
    apiUrl: process.env.STREAM_MEDIAMTX_API_URL?.trim().replace(/\/+$/, "") || "",
    // Токен reverse-proxy на cloud (nginx location /mediamtx/): уходит в
    // заголовок X-Stream-Token. Пустой = прямой доступ без авторизации
    // (например, локальный SSH-туннель до 127.0.0.1:9997).
    apiToken: process.env.STREAM_MEDIAMTX_API_TOKEN?.trim() || "",
    pathName: process.env.STREAM_PATH_NAME?.trim() || "live",
    rtmpUrl: process.env.STREAM_RTMP_URL?.trim() || "",
    publishUser: process.env.STREAM_PUBLISH_USER?.trim() || "",
    publishPass: process.env.STREAM_PUBLISH_PASS?.trim() || "",
    viewerUrl: process.env.STREAM_VIEWER_URL?.trim() || "",
    // Origin страницы зрителя (без /efir/): нужен, чтобы дашборд мог показывать
    // превью эфира. HLS с cloud (/live/) не отдаёт CORS и /efir/ запрещает
    // iframe (X-Frame-Options: DENY), поэтому дашборд играет HLS через
    // локальный прокси /api/stream/hls/* → {viewerOrigin}/live/* (same-origin).
    viewerOrigin: (() => {
      const raw = process.env.STREAM_VIEWER_URL?.trim();
      if (!raw) return "";
      try { return new URL(raw).origin; } catch { return ""; }
    })(),
    statusTimeoutMs: parseIntEnv(process.env.STREAM_STATUS_TIMEOUT_MS, 3000),
    // --- Дубль эфира в ВК (ffmpeg-релей MediaMTX → ВК) ---
    // Топология: OBS → MediaMTX (свой поток, без изменений), а V-Amber
    // локально запускает ffmpeg, который читает свой поток из MediaMTX и
    // пушит его в ВК Live. Так основной поток остаётся прямым и надёжным, а
    // ВК — вторичный best-effort: падение релея не задевает свой эфир.
    // См. server/stream-relay.js и knowledge/wiki/stream-integration.md.
    ffmpegPath: process.env.STREAM_FFMPEG_PATH?.trim() || "ffmpeg",
    // Полный push-URL ВК Live (сервер + ключ из «Трансляции» в ВК). Пустой =
    // дубль в ВК выключен. Можно задать целиком (STREAM_VK_TARGET_URL) или
    // раздельно сервером+ключом (STREAM_VK_RTMP_URL + STREAM_VK_KEY).
    vkTargetUrl: (() => {
      const full = process.env.STREAM_VK_TARGET_URL?.trim();
      if (full) return full;
      const server = process.env.STREAM_VK_RTMP_URL?.trim();
      const key = process.env.STREAM_VK_KEY?.trim();
      return server && key ? `${server.replace(/\/+$/, "")}/${key}` : "";
    })(),
    // Источник релея — RTMP-чтение своего потока из MediaMTX. По умолчанию
    // выводим из STREAM_RTMP_URL (bare-сервер) + путь (MediaMTX разрешает
    // анонимное чтение пути live). Переопределяется STREAM_RELAY_SOURCE_URL.
    relaySourceUrl: (() => {
      const explicit = process.env.STREAM_RELAY_SOURCE_URL?.trim();
      if (explicit) return explicit;
      const bare = process.env.STREAM_RTMP_URL?.trim();
      const path = process.env.STREAM_PATH_NAME?.trim() || "live";
      return bare ? `${bare.replace(/\/+$/, "")}/${path}` : "";
    })(),
    relayRestartMax: parseIntEnv(process.env.STREAM_RELAY_RESTART_MAX, 5),
    relayRestartDelayMs: parseIntEnv(process.env.STREAM_RELAY_RESTART_DELAY_MS, 3000),
  },
  // Чат зрителей на странице /efir/ (deploy/chat-service на cloud).
  // Опционально: без STREAM_CHAT_URL чат-поллер не запускается, брони
  // принимаются только из VK-комментариев.
  chat: {
    apiUrl: process.env.STREAM_CHAT_URL?.trim().replace(/\/+$/, "") || "",
    // Секрет операторского фида (заголовок X-Chat-Token): только с ним
    // сервис отдаёт телефоны зрителей и принимает сервисные сообщения бота.
    apiToken: process.env.STREAM_CHAT_TOKEN?.trim() || "",
    timeoutMs: parseIntEnv(process.env.STREAM_CHAT_TIMEOUT_MS, 3000),
    pollMs: parseIntEnv(process.env.STREAM_CHAT_POLL_MS, 3000),
  },
  // OBS Studio на машине оператора (obs-websocket, встроен в OBS 28+).
  // Нужен для кнопки «Запустить эфир»: V-Amber сам прописывает адрес/ключ
  // и стартует трансляцию. Пароль — в OBS: Сервис → Настройки WebSocket.
  obs: {
    wsUrl: process.env.OBS_WEBSOCKET_URL?.trim() || "ws://127.0.0.1:4455",
    wsPassword: process.env.OBS_WEBSOCKET_PASSWORD?.trim() || "",
    timeoutMs: parseIntEnv(process.env.OBS_TIMEOUT_MS, 4000),
    // Пресет качества и источников эфира: V-Amber приводит OBS оператора к
    // одному known-good виду (1080p30, 4500 кбит/с, камера и микрофон
    // подключённого айфона), чтобы не зависеть от того, что оператор нажал
    // в OBS руками. Применяется в preflight перед стартом эфира и только
    // когда OBS не вещает. OBS_APPLY_PRESET=0 полностью выключает шаг.
    applyPreset: process.env.OBS_APPLY_PRESET !== "0",
    videoWidth: parseIntEnv(process.env.OBS_VIDEO_WIDTH, 1920),
    videoHeight: parseIntEnv(process.env.OBS_VIDEO_HEIGHT, 1080),
    videoFps: parseIntEnv(process.env.OBS_VIDEO_FPS, 30),
    videoBitrateKbps: parseIntEnv(process.env.OBS_VIDEO_BITRATE_KBPS, 4500),
    // Сцена и источники, которые пресет создаёт/чинит. Имена — те, что
    // оператор видит в OBS; менять их безопасно, привязки по имени.
    sceneName: process.env.OBS_SCENE_NAME?.trim() || "V-Amber",
    cameraInputName: process.env.OBS_CAMERA_INPUT_NAME?.trim() || "iPhone — камера",
    micInputName: process.env.OBS_MIC_INPUT_NAME?.trim() || "iPhone — микрофон",
    // Подстроки (регистронезависимо), по которым в списке устройств macOS
    // ищем нужный вход. Айфон по кабелю/Continuity Camera отдаёт устройства
    // вида «iPhone Романа» и «Микрофон iPhone».
    cameraDeviceMatch: parseListEnv(process.env.OBS_CAMERA_DEVICE_MATCH, ["iphone", "айфон"]),
    micDeviceMatch: parseListEnv(process.env.OBS_MIC_DEVICE_MATCH, ["iphone", "айфон"]),
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
    // Паузы между попытками РЕАКТИВНОГО reconnect после gRPC-ошибки
    // (сетевое мигание приходит как событие error, не end). Длина массива =
    // число попыток до полного teardown эфира. Переопределяется в тестах.
    errorRetryDelaysMs: [500, 2000, 5000],
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
