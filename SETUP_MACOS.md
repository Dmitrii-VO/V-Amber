# Перенос V-Amber на MacBook

## Требования

- macOS 12 Monterey и новее
- Node.js 18 или выше
- Git

---

## Быстрый старт (рекомендуется)

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
| `MOYSKLAD_TOKEN` | Нет | МойСклад → Настройки → Доступ → Токены |
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

**`Error: YANDEX_SPEECHKIT_API_KEY is required`**
→ Файл `.env` не создан или ключ не заполнен. Удалите `.env` и запустите `start.command` снова — мастер настройки появится заново.

**Микрофон не работает в Safari**
→ Safari требует HTTPS для доступа к микрофону, кроме `localhost`. Использовать Chrome или Firefox.

**`npm install` падает на `grpc` / `@grpc/grpc-js`**
→ Установите Xcode Command Line Tools: `xcode-select --install`

**Порт 8080 занят**
→ Добавить в `.env`: `PORT=3000` (или любой свободный).
