# Amberry Voice (V-Amber)

![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)
![License](https://img.shields.io/badge/license-private-red.svg)

**Amberry Voice** - MVP-прототип voice-assisted live-commerce workflow для VK:
браузерная панель записывает речь оператора, сервер распознает поток через
Yandex SpeechKit, извлекает артикул, открывает активный лот, публикует карточку
в VK и обрабатывает комментарии `бронь` с созданием/пополнением заказа в
МойСклад.

`Amberry_Voice_Technical_Specification.md` остается продуктовым источником
истины по целям, терминам и бизнес-правилам. Текущая реализация уже не
spec-only: в репозитории есть рабочий Node.js прототип.

## Возможности

- Потоковое STT через Yandex SpeechKit Streaming API.
- Web UI для выбора микрофона, запуска/остановки сессии, VK live URL,
  transcript/status/metrics и safe mode.
- Извлечение артикула из финальных транскриптов по regex/number-word parsing и
  YandexGPT fallback.
- Telegram callback workflow для подтверждения неоднозначного артикула.
- Детекция голосовой скидки и применение скидки через Telegram-команды.
- Поиск товара и остатков в МойСклад, создание контрагента, создание заказа
  покупателя и резервирование без превышения доступного остатка текущего лота.
- VK API: публикация карточки лота, polling комментариев эфира, ответы на
  брони, уведомления о закрытии лота и скидках.
- Safe mode: внешние write-действия в Telegram, МойСклад и VK блокируются, а
  события продолжают логироваться.
- JSON-лог сервера в `logs/server.log` и Markdown-лог каждой сессии в
  `logs/sessions/*.md`.

## Текущий стек

- Backend: Node.js, ES Modules, `ws`, `@grpc/grpc-js`, `dotenv`.
- Frontend: static HTML/CSS/Vanilla JS, Web Audio API AudioWorklet.
- Integrations: Yandex SpeechKit, YandexGPT, VK API, MoySklad JSON API,
  Telegram Bot API.

Redis, SQLite, TypeScript и Python audio-driver описаны в спецификации как
планируемая архитектура, но в текущем MVP отсутствуют. Docker-упаковка для
текущего Node.js MVP добавлена: приложение можно запускать через Docker Desktop
без локальной установки Node.js.

## Структура проекта

```text
server/
  index.js              # запуск HTTP + WebSocket сервера
  http-server.js        # static Web UI, /health, /api/safe-mode
  ws-server.js          # сессия, active lot, VK comments, брони, скидки
  speechkit-stream.js   # gRPC streaming в Yandex SpeechKit
  article-extractor.js  # извлечение артикула
  discount-detector.js  # извлечение скидки из речи
  moysklad.js           # клиент МойСклад
  vk.js                 # публикации и polling комментариев VK
  telegram.js           # уведомления, callback confirmations, скидки
  config.js             # конфигурация из .env
  safe-mode.js          # блокировка внешних write-действий
  session-log.js        # Markdown-лог сессии
  logger.js             # JSON console/file logger
web-ui/
  index.html
  app.js
  audio-processor.js
  styles.css
Dockerfile
docker-compose.yml
start-docker.command
start.command
update.command
scripts/
  backfill-vk-id-dry-run.js
```

Не считать исходниками: `node_modules/`, `logs/`, `.env`.

## Настройка

1. Установите зависимости:

```bash
npm install
```

2. Создайте `.env` на основе `.env.example`.

Минимально обязательная переменная для старта:

```env
YANDEX_SPEECHKIT_API_KEY=...
```

Полезные группы переменных:

- `PORT` - HTTP/WebSocket порт, по умолчанию `8080`.
- `YANDEX_SPEECHKIT_FOLDER_ID`, `YANDEX_SPEECHKIT_LANG`,
  `YANDEX_SPEECHKIT_MODEL` - настройки STT.
- `YANDEX_GPT_API_KEY`, `YANDEX_GPT_FOLDER_ID`, `YANDEX_GPT_MODEL` - fallback
  для сложного извлечения артикула. Если не заданы, используются SpeechKit
  credentials, когда возможно.
- `VK_TOKEN`, `VK_LIVE_VIDEO_URL`, `VK_GROUP_ID` - VK integration.
- `MOYSKLAD_LOGIN`, `MOYSKLAD_PASSWORD`, `MOYSKLAD_ORGANIZATION_ID`,
  `MOYSKLAD_STORE_ID`, `MOYSKLAD_VK_ID_ATTRIBUTE_ID` - МойСклад.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` - Telegram notifications/control.
- `VOICE_ARTICLE_TRIGGERS`, `VOICE_ARTICLE_MIN_LENGTH`,
  `VOICE_ARTICLE_MAX_LENGTH` - настройка извлечения артикула.

VK, МойСклад, Telegram и YandexGPT на уровне кода опциональны: без настройки
часть действий будет пропущена или залогирована. SpeechKit API key обязателен.

## Запуск

Есть два поддерживаемых способа запуска. Для MacBook проще использовать Docker
Desktop и `start-docker.command`.

### Docker-запуск на macOS

Установите Docker Desktop for Mac, запустите его и затем дважды кликните
`start-docker.command` в Finder. При первом запуске файл создаст `.env`,
попросит `YANDEX_SPEECHKIT_API_KEY` и соберет контейнер.

Если macOS не разрешает запуск файла, выполните один раз:

```bash
chmod +x start-docker.command
```

Ручной Docker-запуск:

```bash
docker compose --env-file .env up --build
```

Контейнер пишет логи в локальную папку `logs/`, потому что она подключена как
volume.

### Node.js-запуск

Если Docker не нужен, запустите приложение локально через Node.js:

```bash
npm start
```

Команда запускает `node server/index.js`. После старта откройте:

```text
http://localhost:8080
```

Проверка HTTP:

```text
GET http://localhost:8080/health
```

## Использование

1. Откройте Web UI.
2. Выберите микрофон.
3. При необходимости укажите VK live video URL.
4. Нажмите Start.
5. Произнесите фразу с триггером, например: `код товара один два три`.
6. После распознавания сервер ищет товар, открывает лот и публикует карточку.
7. Комментарий VK `бронь` создает или пополняет заказ в МойСклад, если
   доступный остаток лота еще не исчерпан.
8. Нажмите Stop для закрытия текущего лота и завершения сессии.

Для каждого активного лота сервер ведет очередь броней в памяти. Пока одна
бронь создает или пополняет заказ, следующие комментарии получают статус
ожидания. Перед записью в МойСклад сервер вычитает уже создаваемые и
подтвержденные брони из `product.availableStock`. Если остатка больше нет,
заказ не создается, а зритель получает ответ `Товар закончился. Бронь не
создана.`.

Safe mode можно переключить в Web UI или через `POST /api/safe-mode`. В этом
режиме write-действия наружу блокируются, но события и попытки остаются в
логах. Цель — провести «сухой прогон» эфира с полной диагностикой и затем
восстановить заказы из лога вручную или через
`node scripts/replay-safe-mode.js`. Скрипт парсит `reservation_logged_only`
события из `server.log` и создаёт соответствующие заказы в МойСклад
(`--apply`) либо просто печатает таблицу для проверки (по умолчанию).

### Отправка логов разработчику

В верхней панели dashboard есть кнопка «Отправить логи». При клике
открывается окно с полем «Что случилось?», списком файлов, кнопками
«Отправить в Telegram» и «Скачать ZIP».

Архив (`.zip`) содержит:

- `manifest.json` — install ID, версия V-Amber, версия Node, ОС, заметку
  оператора, флаги настроенных интеграций (без секретов).
- `server.log` плюс ротированные `server.log.1`..`server.log.5`.
- Все файлы из `logs/sessions/*.md`.

Если итоговый размер превышает 40 МБ, архив автоматически разбивается на
части `…part-1-of-N.zip` и отправляется несколькими сообщениями (для
склейки на стороне получателя: `cat part-* > bundle.zip`). На отправку в
Telegram действует rate-limit 1 раз в минуту; скачивание архива не
ограничено.

`server.log` ротируется автоматически при достижении 10 МБ; хранится
текущий файл и до 5 архивных копий.

## Команды

Подтвержденные команды в текущем репозитории:

```bash
npm install
npm start
docker compose --env-file .env up --build
```

Тестов, линтера и отдельной build-команды в репозитории сейчас нет. Docker
Compose используется только для локального runtime-запуска. CI присутствует
только в виде workflow автоматического релиза (см. ниже).

## Обновления

При запуске сервер обращается к GitHub Releases и, если доступна более новая
версия, печатает в консоль баннер с командой для обновления:

```text
git pull && npm install      # обычный запуск
docker compose up --build    # Docker
```

Проверка работает по сравнению `package.json` `version` с тегом последнего
релиза (`vX.Y.Z`). Сетевая ошибка или отсутствие релизов не блокируют запуск.
Отключить проверку можно переменной окружения `DISABLE_UPDATE_CHECK=1`.

На macOS можно обновиться двойным кликом по `update.command`. Скрипт скачивает
последний GitHub Release, накатывает файлы поверх текущей папки, сохраняет
`.env`, `logs/`, `node_modules/` и затем запускает `npm install`. Если порт
`8080` занят, скрипт просит остановить запущенный V-Amber и повторить
обновление.

## Служебные скрипты

В папке `scripts/` лежат разовые диагностические утилиты. Они не запускаются
автоматически и читают настройки из `.env`.

```bash
node scripts/backfill-vk-id-dry-run.js
```

`backfill-vk-id-dry-run.js` проверяет контрагентов МойСклад: ищет поле `VK ID`,
считает уже заполненные карточки, находит кандидатов для переноса `viewerId` из
`description` в атрибут и выводит группы дублей по `viewerId`. Скрипт работает
в режиме dry run и не изменяет данные в МойСклад.

Релизы публикуются автоматически через GitHub Actions
(`.github/workflows/release.yml`):

- Пуш в `main` без правки `package.json` — workflow инкрементирует patch-версию,
  коммитит изменение с пометкой `[skip ci]` и публикует релиз `vX.Y.(Z+1)`.
- Если в пуше уже обновлено поле `version` в `package.json` (например, при
  переходе на новую minor/major), workflow использует эту версию как есть.

Ручное вмешательство нужно только для major/minor-бампа — отредактировать
`version` в `package.json` перед пушем.

## Документация

- `AGENTS.md` - актуальные правила работы для AI-агентов в этом репозитории.
- `CLAUDE.md` - краткая памятка для Claude Code.
- `Amberry_Voice_Technical_Specification.md` - продуктовая спецификация на
  русском.
- `todo.md` - открытые задачи и продуктовые заметки.
