# Amberry Voice (V-Amber)

![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)
![License](https://img.shields.io/badge/license-private-red.svg)

**Amberry Voice** — это система автоматизации для прямых эфиров и e-commerce, объединяющая распознавание речи, управление заказами в МойСклад и интерактивное взаимодействие через Telegram и VK.

Проект позволяет ведущему эфира управлять лотами и заказами голосом, автоматически извлекая артикулы товаров из речи и синхронизируя данные с учетной системой.

## 🚀 Основные возможности

*   **🎙 Voice-to-Commerce (STT):** Потоковое распознавание речи через **Yandex SpeechKit**.
*   **📦 Интеграция с МойСклад:**
    *   Автоматический поиск товаров по артикулу (коду).
    *   Проверка остатков и актуальных цен в реальном времени.
    *   Создание заказов покупателей и резервирование товаров.
    *   Автоматическое создание контрагентов для пользователей VK.
*   **🤖 Интеллектуальное извлечение данных:**
    *   Распознавание артикулов по триггерам (например, "код товара 123").
    *   Использование **YandexGPT** для сложного извлечения сущностей из транскрипта.
    *   Детекция команд на скидку из речи.
*   **📲 Telegram Notification & Control:**
    *   Уведомления о смене активного лота с фото товара и ценой.
    *   Разрешение неоднозначностей (кнопки подтверждения кода в Telegram).
    *   Управление скидками через команды бота.
*   **📺 VK Live Integration:** Связь комментариев из эфира VK с заказами в МойСклад.
*   **🌐 Web UI:** Панель управления стримингом, мониторинг метрик и realtime-транскрипт.

## 🛠 Технологический стек

*   **Backend:** Node.js (ES Modules), WebSocket (ws), gRPC (для SpeechKit).
*   **Frontend:** Vanilla JS, CSS, HTML5 Audio API.
*   **AI/ML:** Yandex SpeechKit (STT), YandexGPT.
*   **API:** MoySklad JSON API, Telegram Bot API, VK API.

## 📂 Структура проекта

```text
├── server/                 # Backend сервер
│   ├── article-extractor.js # Логика извлечения артикулов
│   ├── speechkit-stream.js  # Стриминг аудио в Yandex SpeechKit
│   ├── moysklad.js         # Клиент для работы с МойСклад API
│   ├── telegram.js         # Телеграм-бот и уведомления
│   ├── vk.js               # Интеграция с VK
│   └── ws-server.js        # WebSocket сервер для Web UI
├── web-ui/                 # Frontend интерфейс
│   ├── audio-processor.js   # Захват и обработка аудио из браузера
│   └── app.js              # Основная логика UI
└── .env.example            # Пример конфигурации
```

## ⚙️ Настройка и запуск

### 1. Подготовка окружения
Создайте файл `.env` на основе `.env.example` и заполните необходимые ключи:

```env
# Server
PORT=8080

# Yandex Cloud (SpeechKit & GPT)
YANDEX_SPEECHKIT_API_KEY=your_key
YANDEX_SPEECHKIT_FOLDER_ID=your_folder_id

# MoySklad
MOYSKLAD_LOGIN=admin@login
MOYSKLAD_PASSWORD=password
MOYSKLAD_STORE_ID=...

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### 2. Установка зависимостей
```bash
npm install
```

### 3. Запуск
```bash
npm start
```
После запуска откройте `http://localhost:8080` в браузере.

## 📖 Использование

1.  Откройте Web UI, выберите микрофон и нажмите **"Старт"**.
2.  Произнесите фразу с триггером, например: *"А теперь лот, код товара один два три"*.
3.  Система:
    *   Распознает "123".
    *   Найдет товар в МойСклад.
    *   Отправит карточку товара в Telegram.
    *   Сделает товар активным для резервирования по комментариям из VK.

---
Разработано для Amberry.
