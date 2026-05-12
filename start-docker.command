#!/usr/bin/env bash
# V-Amber - запуск одной кнопкой через Docker Desktop (macOS)

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

echo ""
echo "  V-Amber / Docker запуск"
echo "  -------------------------------------"

_dialog() {
  osascript -e "display dialog \"$2\" buttons {\"OK\"} default button \"OK\" with title \"$1\"" 2>/dev/null || true
}

_ask() {
  local result
  result=$(osascript -e "tell app \"System Events\" to text returned of (display dialog \"$2\" default answer \"$3\" with title \"$1\" buttons {\"Отмена\", \"Далее\"} default button \"Далее\")" 2>/dev/null || true)
  echo "$result"
}

_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
    return
  fi

  echo -e "${RED}[!] Docker Compose не найден.${NC}"
  _dialog "V-Amber - Docker" "Docker Compose не найден.\n\nУстановите или обновите Docker Desktop и запустите start-docker.command снова."
  exit 1
}

if ! command -v docker >/dev/null 2>&1; then
  echo -e "${RED}[!] Docker не найден.${NC}"
  _dialog "V-Amber - Docker" "Docker не найден.\n\nУстановите Docker Desktop for Mac:\nhttps://www.docker.com/products/docker-desktop/\n\nПосле установки запустите Docker Desktop и повторите запуск."
  read -rp "  Нажмите Enter для выхода..." _
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo -e "${YELLOW}[!] Docker Desktop не запущен.${NC}"
  _dialog "V-Amber - Docker" "Docker Desktop установлен, но не запущен.\n\nОткройте Docker Desktop, дождитесь статуса Running и запустите этот файл снова."
  open -a Docker >/dev/null 2>&1 || true
  read -rp "  Нажмите Enter после запуска Docker Desktop или Ctrl+C для выхода..." _
fi

if ! docker info >/dev/null 2>&1; then
  echo -e "${RED}[!] Docker daemon недоступен.${NC}"
  exit 1
fi

echo -e "  Docker - ${GREEN}OK${NC}"

NEED_SETUP=false
if [ ! -f .env ]; then
  NEED_SETUP=true
else
  SPEECHKIT_VAL=$(grep -E '^YANDEX_SPEECHKIT_API_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- | sed 's/#.*$//' | tr -d ' ' || echo "")
  if [ -z "$SPEECHKIT_VAL" ]; then
    NEED_SETUP=true
  fi
fi

if [ "$NEED_SETUP" = true ]; then
  echo ""
  echo "  Первый запуск - создаю .env..."

  SPEECHKIT_KEY=""
  while [ -z "$SPEECHKIT_KEY" ]; do
    SPEECHKIT_KEY=$(_ask \
      "V-Amber - Yandex SpeechKit" \
      "API-ключ Yandex SpeechKit (обязательно)\n\nВставьте ключ из Yandex Cloud:" \
      "")
    if [ -z "$SPEECHKIT_KEY" ]; then
      _dialog "V-Amber" "API-ключ обязателен для запуска."
    fi
  done

  FOLDER_ID=$(_ask \
    "V-Amber - Yandex SpeechKit" \
    "ID каталога Yandex Cloud\n\nМожно оставить пустым, если текущий ключ работает без folder header." \
    "")

  cat > .env <<EOF
# V-Amber - Docker конфигурация
# Создано $(date '+%Y-%m-%d %H:%M')

YANDEX_SPEECHKIT_API_KEY=${SPEECHKIT_KEY}
YANDEX_SPEECHKIT_FOLDER_ID=${FOLDER_ID}

# VK, Telegram и МойСклад можно добавить позже по примеру .env.example.
PORT=8080
EOF

  echo -e "  .env создан - ${GREEN}OK${NC}"
fi

PORT=$(grep -E '^PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | sed 's/#.*$//' | tr -d ' ' || echo "8080")
PORT="${PORT:-8080}"

echo ""
echo -e "  ${GREEN}Собираю и запускаю контейнер на http://localhost:${PORT}${NC}"
echo "  Остановить: Ctrl+C"
echo "  -------------------------------------"
echo ""

(sleep 3 && open "http://localhost:${PORT}") &

_compose --env-file .env up --build
