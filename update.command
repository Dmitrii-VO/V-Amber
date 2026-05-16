#!/usr/bin/env bash
# V-Amber updater: скачивает свежий релиз с GitHub, накатывает поверх,
# сохраняя .env и logs/. Двойной клик в Finder, либо запуск в терминале.
set -e

# При двойном клике рабочая папка может быть домашняя — встаём рядом с этим
# скриптом.
cd "$(dirname "$0")"

REPO="Dmitrii-VO/V-Amber"
API="https://api.github.com/repos/${REPO}/releases/latest"
TMPDIR="$(mktemp -d -t v-amber-update.XXXXXX)"
TRAP_CLEAN() { rm -rf "$TMPDIR"; }
trap TRAP_CLEAN EXIT

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$*"; }
fail() { printf "\033[1;31m%s\033[0m\n" "$*"; exit 1; }

current_version() {
  if [ -f package.json ]; then
    node -p "require('./package.json').version" 2>/dev/null || echo "?"
  else
    echo "?"
  fi
}

CURRENT="$(current_version)"
say "Текущая версия V-Amber: ${CURRENT}"
say "Узнаю последнюю версию из GitHub..."

META="$(curl -fsSL -H 'User-Agent: V-Amber-updater' "$API")" || fail "Не удалось запросить GitHub. Проверь интернет."
TAG="$(printf "%s" "$META" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[^"]*\)".*/\1/p' | head -n1)"
[ -n "$TAG" ] || fail "Не удалось разобрать ответ GitHub."
VERSION="${TAG#v}"

if [ "$CURRENT" = "$VERSION" ]; then
  say "Уже стоит последняя версия (${VERSION}). Обновлять нечего."
  exit 0
fi

say "Доступна версия ${VERSION}. Качаю..."
ZIP_URL="https://github.com/${REPO}/archive/refs/tags/${TAG}.zip"
ZIP_PATH="${TMPDIR}/v-amber.zip"
curl -fsSL -o "$ZIP_PATH" "$ZIP_URL" || fail "Не удалось скачать ${ZIP_URL}"

say "Распаковываю..."
unzip -q "$ZIP_PATH" -d "$TMPDIR" || fail "ZIP повреждён."
NEW_DIR="$(ls -1d "$TMPDIR"/V-Amber-*/ 2>/dev/null | head -n1)"
[ -n "$NEW_DIR" ] && [ -d "$NEW_DIR" ] || fail "Не нашёл папку проекта в архиве."

# Проверка: новый релиз содержит package.json — иначе что-то не так.
[ -f "${NEW_DIR}package.json" ] || fail "В архиве нет package.json — отмена."

# Проверка запущенного сервера на 8080. Если порт занят — пользователю
# нужно остановить процесс самостоятельно.
if lsof -i :8080 -t >/dev/null 2>&1; then
  warn "На порту 8080 что-то запущено — скорее всего V-Amber работает."
  warn "Остановите его (Ctrl+C в окне, либо закройте окно терминала) и запустите update.command снова."
  exit 1
fi

say "Делаю резервную копию текущей папки (rsync-style replace)..."
# Список того что НЕ трогаем при копировании.
KEEP=(
  ".env"
  "logs"
  "node_modules"
  ".DS_Store"
)
KEEP_EXCLUDES=""
for k in "${KEEP[@]}"; do
  KEEP_EXCLUDES="${KEEP_EXCLUDES} --exclude=${k}"
done

say "Накатываю файлы новой версии..."
# rsync на macOS есть из коробки. -a сохраняет атрибуты, --delete убирает
# файлы, которые удалили в новом релизе. Сохраняем .env и logs/ — они в
# исключениях и поэтому не удалятся.
rsync -a --delete ${KEEP_EXCLUDES} "$NEW_DIR" ./ || fail "rsync завершился с ошибкой."

say "Устанавливаю npm-зависимости..."
if command -v npm >/dev/null 2>&1; then
  npm install --silent || warn "npm install завершился с предупреждениями — посмотри вывод выше."
else
  warn "npm не найден в PATH. Установи Node.js (https://nodejs.org) и запусти 'npm install' в этой папке вручную."
fi

NEW_VERSION="$(current_version)"
say "Готово. Версия: ${NEW_VERSION}"
echo ""
echo "Запустите V-Amber снова: либо start-docker.command, либо 'npm start' в этой папке."
echo ""
read -r -p "Нажмите Enter, чтобы закрыть окно..."
