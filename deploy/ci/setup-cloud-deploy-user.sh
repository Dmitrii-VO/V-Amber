#!/bin/bash
# Одноразовая (идемпотентная) настройка отдельного пользователя для CI-деплоя
# на cloud. Запускать от user1 (есть NOPASSWD sudo) рядом с
# ci-deploy-dispatch.sh:
#
#   scp deploy/ci/setup-cloud-deploy-user.sh deploy/ci/ci-deploy-dispatch.sh cloud:/tmp/
#   ssh cloud "bash /tmp/setup-cloud-deploy-user.sh '<ssh-ed25519 AAAA... ci-deploy@github-actions>'"
#
# Зачем отдельный пользователь: user1 (текущий деплой-юзер) имеет NOPASSWD
# sudo ALL и состоит в группе docker — де-факто root на машине, где рядом
# крутится pay-service. Класть этот ключ/доступ в GitHub Actions secrets
# нельзя: утечка секрета = root на боевом сервере. ci-deploy получает только
# то, что реально нужно для деплоя (см. ci-deploy-dispatch.sh), без sudo.
#
# Что делает скрипт:
#  1. Создаёт системного пользователя ci-deploy.
#  2. Добавляет его в группы docker (рестарт chat-контейнера через сокет) и
#     www-data (запись в /var/www/stream-viewer без chown при каждом деплое).
#  3. Переносит ~/chat-service (user1) → /srv/chat-service (ci-deploy),
#     сохраняя data/ и .env, и поднимает стек заново уже от ci-deploy —
#     перенос нужен, т.к. ci-deploy не входит в группу user1 и не может
#     писать внутрь /home/user1/chat-service.
#  4. Устанавливает форс-команду в authorized_keys ci-deploy — ключ CI не
#     даёт интерактивный шелл, только 3 действия из ci-deploy-dispatch.sh.
set -euo pipefail

PUBKEY="${1:?usage: setup-cloud-deploy-user.sh '<ssh-ed25519 AAAA... ci-deploy@github-actions>'}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

id ci-deploy &>/dev/null || sudo useradd -m -s /bin/bash -c "CI deploy (GitHub Actions, no interactive login)" ci-deploy
sudo usermod -aG docker,www-data ci-deploy

sudo install -d -m 750 -o ci-deploy -g ci-deploy /home/ci-deploy/bin
sudo install -d -m 700 -o ci-deploy -g ci-deploy /home/ci-deploy/.ssh

# --- перенос chat-service, только если ещё не перенесён ---
if [ ! -d /srv/chat-service ] && [ -d "$HOME/chat-service" ]; then
  (cd "$HOME/chat-service" && docker compose down)
  sudo mkdir -p /srv/chat-service
  sudo rsync -a --remove-source-files "$HOME/chat-service/" /srv/chat-service/
  find "$HOME/chat-service" -depth -type d -empty -delete
  sudo chown -R ci-deploy:ci-deploy /srv/chat-service
  sudo chmod 750 /srv/chat-service
  sudo -u ci-deploy bash -c 'cd /srv/chat-service && docker compose up -d'
fi

# статическая страница /efir/ уже принадлежит www-data — ci-deploy теперь
# в этой группе, остаётся дать группе право записи
sudo chmod g+w /var/www/stream-viewer

# --- форс-команда ---
sudo install -m 750 -o ci-deploy -g ci-deploy \
  "$SCRIPT_DIR/ci-deploy-dispatch.sh" /home/ci-deploy/bin/ci-deploy-dispatch.sh

AUTH_LINE="command=\"/home/ci-deploy/bin/ci-deploy-dispatch.sh\",no-pty,no-agent-forwarding,no-X11-forwarding,no-port-forwarding $PUBKEY"
echo "$AUTH_LINE" | sudo -u ci-deploy tee /home/ci-deploy/.ssh/authorized_keys >/dev/null
sudo chmod 600 /home/ci-deploy/.ssh/authorized_keys

echo "Готово: ci-deploy настроен, chat-service (если был) перенесён в /srv/chat-service."
