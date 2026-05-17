# Перенос V-Amber на MacBook

## Требования

- macOS 12 Monterey и новее
- Docker Desktop for Mac для запуска одной кнопкой через Docker
- Node.js 18 или выше только для альтернативного локального запуска
- Git

---

## Быстрый старт через Docker (рекомендуется)

В папке проекта есть файл `start-docker.command`. Он запускает текущий MVP в
Docker-контейнере, подключает локальную папку `logs/` и открывает Web UI в
браузере.

1. Установите [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/)
2. Запустите Docker Desktop и дождитесь статуса **Running**
3. Скопируйте папку проекта на MacBook (AirDrop, флешка или `git clone`) -
   `node_modules` не нужны
4. Откройте Терминал и разрешите запуск файла:
   ```bash
   chmod +x /путь/до/папки/start-docker.command
   ```
5. Дважды кликните `start-docker.command` в Finder

При первом запуске откроется короткий мастер настройки. Он создаст `.env`,
попросит `YANDEX_SPEECHKIT_API_KEY`, затем выполнит Docker-сборку и запустит
сервер.

> **При повторных запусках** мастер не появляется - контейнер пересобирается
> при необходимости и сервер запускается сразу.

---

## Быстрый старт через Node.js

В папке проекта есть файл `start.command`. Он делает всё сам:

1. Установите Node.js 18+ с [nodejs.org](https://nodejs.org) (кнопка LTS), если ещё не установлен
2. Скопируйте папку проекта на MacBook (AirDrop, флешка или `git clone`) — `node_modules` не нужны
3. Откройте Терминал и разрешите запуск файла:
   ```bash
   chmod +x /путь/до/папки/start.command
   ```
4. Дважды кликните `start.command` в Finder

При первом запуске откроется мастер настройки — серия диалоговых окон macOS, где нужно ввести API-ключи. После заполнения сервер стартует автоматически и открывается браузер.

> **При повторных запусках** мастер не появляется — сервер запускается сразу.

Если `start.command` не открывается двойным кликом после ручной передачи
папки, выполните из Терминала:

```bash
cd ~/Desktop/V-Amber-main && chmod +x start.command && xattr -d com.apple.quarantine start.command 2>/dev/null
```

Если файл нужно создать заново на Mac, выполните из папки, где лежит проект:

```bash
cd ~/Desktop/V-Amber-main && printf '#!/bin/bash\ncd "$(dirname "$0")"\n/usr/local/bin/npm start\n\necho\nread -n 1 -p "Press any key to close..."\n' > start.command && chmod +x start.command && xattr -d com.apple.quarantine start.command 2>/dev/null
```

Если `npm` установлен не в `/usr/local/bin/npm`, проверьте путь командой
`which npm` и замените путь в скрипте.

---

## Обновление через `update.command`

В папке проекта есть файл `update.command`. Он скачивает последний GitHub
Release, накатывает его поверх текущей папки, сохраняет `.env`, `logs/` и
`node_modules/`, затем запускает `npm install`.

1. Остановите V-Amber, если он сейчас запущен.
2. Дважды кликните `update.command` в Finder.
3. Дождитесь сообщения `Готово. Версия: ...`.
4. Запустите V-Amber снова через `start.command` или `start-docker.command`.

Если `update.command` не открывается двойным кликом, выполните:

```bash
cd ~/Desktop/V-Amber-main && chmod +x update.command && xattr -d com.apple.quarantine update.command 2>/dev/null
```

Если файл нужно создать заново, выполните:

```bash
cd ~/Desktop/V-Amber-main && printf '#!/bin/bash\ncd "$(dirname "$0")"\n/usr/bin/git pull --ff-only\n/usr/local/bin/npm install\n\necho\nread -n 1 -p "Press any key to close..."\n' > update.command && chmod +x update.command && xattr -d com.apple.quarantine update.command 2>/dev/null
```

Эта короткая версия подходит для папки, полученной через `git clone`. Для
папки, скачанной ZIP-архивом, используйте штатный `update.command` из релиза.

---

## Ручной Docker-запуск

Если нужно запустить без двойного клика, используйте Docker Compose из папки
проекта:

```bash
docker compose --env-file .env up --build
```

Если файла `.env` нет, создайте его из `.env.example` и заполните минимум:

```env
YANDEX_SPEECHKIT_API_KEY=...
PORT=8080
```

Логи остаются на хосте в `logs/`, потому что `docker-compose.yml` подключает
эту папку в контейнер как volume.

---

## Ручная установка (альтернатива)

### 1. Установить Node.js

Через [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# перезапустить терминал, затем:
nvm install 20
nvm use 20
node -v   # должно вывести v20.x.x
```

Или скачать установщик напрямую с [nodejs.org](https://nodejs.org) (LTS-версия).

### 2. Получить код

```bash
git clone https://github.com/Dmitrii-VO/V-Amber.git
cd V-Amber
```

### 3. Установить зависимости

```bash
npm install
```

### 4. Создать файл `.env`

```bash
cp .env.example .env
```

Открыть `.env` в любом редакторе и заполнить значения:

| Переменная | Обязательно | Где взять |
|---|---|---|
| `YANDEX_SPEECHKIT_API_KEY` | **Да** | [Yandex Cloud Console](https://console.yandex.cloud) → IAM → Сервисные аккаунты → API-ключи |
| `YANDEX_SPEECHKIT_FOLDER_ID` | **Да** | Yandex Cloud Console → Каталог → ID каталога |
| `VK_TOKEN` | Нет | VK → Управление сообществом → Работа с API → Ключи доступа |
| `TELEGRAM_BOT_TOKEN` | Нет | @BotFather в Telegram |
| `TELEGRAM_CHAT_ID` | Нет | @userinfobot в Telegram |
| `MOYSKLAD_LOGIN` | Нет | Логин от аккаунта МойСклад |
| `MOYSKLAD_PASSWORD` | Нет | Пароль от аккаунта МойСклад |
| `MOYSKLAD_ORGANIZATION_ID` | Нет | UUID из адресной строки в МойСклад |
| `MOYSKLAD_STORE_ID` | Нет | UUID склада в МойСклад |

Без `YANDEX_SPEECHKIT_API_KEY` сервер не запустится. Остальные интеграции опциональны.

### 5. Запустить

```bash
npm start
```

Открыть в браузере: [http://localhost:8080](http://localhost:8080)

---

## Разрешить доступ к микрофону

При первом запуске браузер запросит доступ к микрофону — нажать **Разрешить**. Если не спрашивает: **Системные настройки → Конфиденциальность и безопасность → Микрофон**.

---

## Логи и session-файлы

| Путь | Содержимое |
|---|---|
| `logs/server.log` | Технический JSON-лог сервера |
| `logs/sessions/YYYY-MM-DD_HH-MM.md` | Читаемый Markdown-отчёт каждой трансляции |

---

## Частые проблемы

**`start.command` не запускается двойным кликом**
→ В Терминале выполните: `chmod +x ~/путь/до/start.command`

**`update.command` не запускается двойным кликом**
→ В Терминале выполните: `chmod +x ~/путь/до/update.command`

**`update.command` пишет, что порт 8080 занят**
→ Остановите запущенный V-Amber и запустите `update.command` снова.

**`start-docker.command` не запускается двойным кликом**
→ В Терминале выполните: `chmod +x ~/путь/до/start-docker.command`

**Docker Desktop не запущен**
→ Откройте Docker Desktop, дождитесь статуса **Running** и запустите
`start-docker.command` снова.

**`Error: YANDEX_SPEECHKIT_API_KEY is required`**
→ Файл `.env` не создан или ключ не заполнен. Удалите `.env` и запустите
`start-docker.command` или `start.command` снова - мастер настройки появится
заново.

**Микрофон не работает в Safari**
→ Safari требует HTTPS для доступа к микрофону, кроме `localhost`. Использовать Chrome или Firefox.

**`npm install` падает на `grpc` / `@grpc/grpc-js`**
→ Установите Xcode Command Line Tools: `xcode-select --install`

**Порт 8080 занят**
→ Добавить в `.env`: `PORT=3000` (или любой свободный).
