#!/bin/bash
# Форс-команда для ограниченного SSH-ключа CI (GitHub Actions).
# Устанавливается на cloud как command= в authorized_keys пользователя
# ci-deploy — значит ключ НЕ даёт интерактивный шелл, sshd всегда запускает
# именно этот скрипт, а то, что реально прислал клиент, лежит в
# $SSH_ORIGINAL_COMMAND. Разрешено ровно три действия:
#   1. rsync-запись в /var/www/stream-viewer (статическая страница /efir/)
#   2. rsync-запись в /srv/chat-service (server.js + docker-compose.yml)
#   3. фиксированная команда restart-chat — рестарт chat-контейнера
# Всё остальное (произвольная команда, обход через `;`/`&&` и т.п.) отклоняется:
# rsync --server сам по себе не проходит через шелл, а restart-chat сравнивается
# как целая строка, так что дописать что-то ещё к ней нельзя.
#
# Про подмену пути ниже. rrsync делает chdir в свой каталог и ЯКОРИТ путь
# клиента в нём: `if arg.startswith('/'): arg = args.dir + arg`. То есть
# абсолютный путь от клиента склеивается с корнем — /var/www/stream-viewer/
# превращалось в /var/www/stream-viewer/var/www/stream-viewer, и rsync падал
# с "mkdir failed: No such file or directory". rrsync ожидает "." либо путь
# ОТНОСИТЕЛЬНО своего корня.
#
# Просто слать "." из воркфлоу нельзя: тогда обе цели выглядят в
# SSH_ORIGINAL_COMMAND одинаково и этот case не сможет их различить. Поэтому
# воркфлоу шлёт полный путь (он же документирует, куда деплой идёт), а здесь
# мы его срезаем и подставляем "." — rrsync читает команду из
# SSH_ORIGINAL_COMMAND (rrsync:156), так что правки в env ему достаточно.
# Корень rrsync остаётся узким (именно этот каталог, не /var/www и не /srv) —
# на машине рядом крутится pay-service, расширять область записи нельзя.
set -euo pipefail

case "${SSH_ORIGINAL_COMMAND:-}" in
  "rsync --server"*" /var/www/stream-viewer/")
    export SSH_ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND% /var/www/stream-viewer/} ."
    exec /usr/bin/rrsync -wo /var/www/stream-viewer/
    ;;
  "rsync --server"*" /srv/chat-service/")
    export SSH_ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND% /srv/chat-service/} ."
    exec /usr/bin/rrsync -wo /srv/chat-service/
    ;;
  restart-chat)
    exec docker compose -f /srv/chat-service/docker-compose.yml restart chat
    ;;
  *)
    echo "ci-deploy-dispatch: команда не разрешена" >&2
    exit 1
    ;;
esac
