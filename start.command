#!/usr/bin/env bash
# V-Amber — запуск одной кнопкой (macOS)
# Двойной клик в Finder откроет Terminal и запустит сервер

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

echo ""
echo "  V-Amber / запуск"
echo "  ─────────────────────────────────────"

# ── проверка Node.js ───────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}[!] Node.js не найден.${NC}"
  echo ""
  echo "  Установите Node.js (версия 18+):"
  echo "  https://nodejs.org  →  кнопка LTS"
  echo ""
  echo "  Или через Homebrew:"
  echo "    brew install node"
  echo ""
  osascript -e 'display dialog "Node.js не найден.\n\nУстановите Node.js версии 18 или выше:\nhttps://nodejs.org → кнопка LTS\n\nПосле установки запустите start.command снова." buttons {"OK"} default button "OK" with title "V-Amber — ошибка"' 2>/dev/null || true
  read -rp "  Нажмите Enter для выхода..." _
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo -e "${YELLOW}[!] Node.js $NODE_MAJOR найден, нужна версия 18+.${NC}"
  osascript -e "display dialog \"Установлен Node.js версии $NODE_MAJOR, нужна 18 или выше.\n\nОбновите: https://nodejs.org\" buttons {\"OK\"} default button \"OK\" with title \"V-Amber — устаревший Node.js\"" 2>/dev/null || true
  read -rp "  Нажмите Enter для выхода..." _
  exit 1
fi

echo -e "  Node.js $(node --version) — ${GREEN}OK${NC}"

# ── helpers для диалогов ────────────────────────
_ask() {
  # _ask "заголовок" "текст" "значение по умолчанию"
  osascript -e "tell app \"System Events\" to text returned of (display dialog \"$2\" default answer \"$3\" with title \"$1\" buttons {\"Отмена\", \"Далее\"} default button \"Далее\")" 2>/dev/null || echo ""
}

_confirm() {
  # _confirm "заголовок" "текст" → 0 если Да, 1 если Нет
  local btn
  btn=$(osascript -e "tell app \"System Events\" to button returned of (display dialog \"$2\" buttons {\"Нет\", \"Да\"} default button \"Да\" with title \"$1\")" 2>/dev/null || echo "Нет")
  [[ "$btn" == "Да" ]]
}

_info() {
  osascript -e "display dialog \"$2\" buttons {\"OK\"} default button \"OK\" with title \"$1\"" 2>/dev/null || true
}

# ── первичная настройка .env ───────────────────
NEED_SETUP=false

if [ ! -f .env ]; then
  NEED_SETUP=true
else
  # .env есть, но ключ SpeechKit пустой — тоже запускаем мастер
  SPEECHKIT_VAL=$(grep -E '^YANDEX_SPEECHKIT_API_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' ' || echo "")
  if [ -z "$SPEECHKIT_VAL" ]; then
    NEED_SETUP=true
  fi
fi

if [ "$NEED_SETUP" = true ]; then
  echo ""
  echo "  Первый запуск — открываю мастер настройки..."
  echo ""

  _info "V-Amber — первый запуск" \
    "Добро пожаловать в V-Amber!\n\nЭто помощник для голосовых прямых эфиров ВКонтакте:\nраспознаёт артикулы товаров, принимает брони\nи создаёт заказы в МойСклад.\n\nСейчас настроим несколько параметров.\nПотребуется около 2 минут."

  # ── Yandex SpeechKit (обязательно) ────────────
  SPEECHKIT_KEY=""
  while [ -z "$SPEECHKIT_KEY" ]; do
    SPEECHKIT_KEY=$(_ask \
      "V-Amber — Yandex SpeechKit (1/2)" \
      "API-ключ Yandex SpeechKit (обязательно)\n\nГде взять:\n1. Откройте console.yandex.cloud\n2. Выберите каталог → Сервисные аккаунты\n3. Создайте или откройте аккаунт → вкладка «API-ключи»\n4. Нажмите «Создать API-ключ»\n\nВставьте ключ в поле ниже:" \
      "")
    if [ -z "$SPEECHKIT_KEY" ]; then
      _info "V-Amber" "API-ключ обязателен для работы системы.\nПожалуйста, введите его."
    fi
  done

  FOLDER_ID=""
  while [ -z "$FOLDER_ID" ]; do
    FOLDER_ID=$(_ask \
      "V-Amber — Yandex SpeechKit (2/2)" \
      "ID каталога Yandex Cloud (обязательно)\n\nГде взять:\n1. Откройте console.yandex.cloud\n2. В левом меню нажмите на название каталога\n3. Скопируйте «ID каталога» из карточки\n\nВставьте ID в поле ниже:" \
      "")
    if [ -z "$FOLDER_ID" ]; then
      _info "V-Amber" "ID каталога обязателен для работы системы.\nПожалуйста, введите его."
    fi
  done

  # ── VK (опционально) ──────────────────────────
  VK_TOKEN=""
  if _confirm "V-Amber — VK" \
    "Настроить интеграцию с VK?\n\nПозволяет публиковать карточки лотов в эфире\nи принимать брони через комментарии.\n\nЕсли пропустить — можно добавить позже в файл .env"; then

    VK_TOKEN=$(_ask \
      "V-Amber — VK токен" \
      "Токен сообщества VK\n\nГде взять:\nVK → Управление сообществом\n→ Работа с API → Ключи доступа\n→ Создать ключ (права: управление, видео, стена)\n\nВставьте токен:" \
      "")
  fi

  # ── Telegram (опционально) ────────────────────
  TG_TOKEN=""
  TG_CHAT=""
  if _confirm "V-Amber — Telegram" \
    "Настроить Telegram-уведомления?\n\nБот будет сообщать об обнаруженных артикулах,\nпринятых бронях и ждать подтверждений при неоднозначных кодах.\n\nЕсли пропустить — можно добавить позже в файл .env"; then

    TG_TOKEN=$(_ask \
      "V-Amber — Telegram (1/2)" \
      "Токен Telegram-бота\n\nГде взять:\n1. Напишите @BotFather в Telegram\n2. /newbot → задайте имя и username\n3. Скопируйте токен из ответа\n\nВставьте токен:" \
      "")

    TG_CHAT=$(_ask \
      "V-Amber — Telegram (2/2)" \
      "ID чата оператора\n\nГде взять:\n1. Напишите @userinfobot в Telegram\n2. Скопируйте число из поля «Id»\n\nВставьте ID:" \
      "")
  fi

  # ── МойСклад (опционально) ────────────────────
  MS_TOKEN=""
  MS_ORG=""
  MS_STORE=""
  if _confirm "V-Amber — МойСклад" \
    "Настроить интеграцию с МойСклад?\n\nПозволяет искать товары по артикулу\nи автоматически создавать заказы при бронировании.\n\nЕсли пропустить — можно добавить позже в файл .env"; then

    MS_TOKEN=$(_ask \
      "V-Amber — МойСклад (1/3)" \
      "Bearer-токен МойСклад\n\nГде взять:\nМойСклад → Настройки → Доступ к API\n→ «Создать токен»\n\nВставьте токен:" \
      "")

    MS_ORG=$(_ask \
      "V-Amber — МойСклад (2/3)" \
      "UUID организации МойСклад\n\nГде взять:\nМойСклад → Настройки → Юр. лица\n→ откройте организацию → скопируйте UUID из URL\n\nВставьте UUID:" \
      "")

    MS_STORE=$(_ask \
      "V-Amber — МойСклад (3/3)" \
      "UUID склада МойСклад\n\nГде взять:\nМойСклад → Товары → Склады\n→ откройте склад → скопируйте UUID из URL\n\nВставьте UUID:" \
      "")
  fi

  # ── записываем .env ────────────────────────────
  cat > .env <<EOF
# V-Amber — конфигурация
# Создано мастером настройки $(date '+%Y-%m-%d %H:%M')

# ── Yandex SpeechKit (обязательно) ───────────
YANDEX_SPEECHKIT_API_KEY=${SPEECHKIT_KEY}
YANDEX_SPEECHKIT_FOLDER_ID=${FOLDER_ID}

# ── VK (опционально) ─────────────────────────
VK_TOKEN=${VK_TOKEN}

# ── Telegram (опционально) ───────────────────
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_CHAT_ID=${TG_CHAT}

# ── МойСклад (опционально) ───────────────────
MOYSKLAD_TOKEN=${MS_TOKEN}
MOYSKLAD_ORGANIZATION_ID=${MS_ORG}
MOYSKLAD_STORE_ID=${MS_STORE}

# ── Сервер ───────────────────────────────────
PORT=8080
EOF

  echo -e "  .env создан — ${GREEN}OK${NC}"
  _info "V-Amber — настройка завершена" "Конфигурация сохранена в файл .env\n\nТеперь установим зависимости и запустим сервер."
fi

# ── зависимости ────────────────────────────────
if [ ! -d node_modules ]; then
  echo ""
  echo "  Установка зависимостей (первый запуск)..."
  npm install --silent
  echo -e "  npm install — ${GREEN}OK${NC}"
fi

# ── запуск ─────────────────────────────────────
PORT=$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' ' || echo "8080")
PORT="${PORT:-8080}"

echo ""
echo -e "  ${GREEN}Запускаю сервер на http://localhost:${PORT}${NC}"
echo "  Остановить: Ctrl+C"
echo "  ─────────────────────────────────────"
echo ""

(sleep 1.5 && open "http://localhost:${PORT}") &

npm start
