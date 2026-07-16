# Страница зрителя (deploy)

Публичная страница просмотра эфира: `index.html` + `app.js` (вынесен из
`index.html` — строгий CSP на 443-vhost запрещает инлайн-скрипты) +
вендоренный `hls.min.js` (hls.js 1.6, скачан с jsdelivr). Живёт на хосте
`cloud` рядом с MediaMTX, раздаётся тем же nginx, что и
`www.xn--80azkg6cn.space`.

URL для зрителей: **https://www.xn--80azkg6cn.space/efir/**

## Деплой

**Автоматический (обычный путь).** Пуш в `main`, затрагивающий
`deploy/stream-viewer/**`, запускает
[`.github/workflows/deploy-stream.yml`](../../.github/workflows/deploy-stream.yml):
rsync трёх файлов на `cloud` от имени урезанного пользователя `ci-deploy` +
проверка `curl`. Полное описание — в
[stream-integration § CI-деплой](../../knowledge/wiki/stream-integration.md).
Требует одноразовой настройки сервера, см.
[`deploy/ci/setup-cloud-deploy-user.sh`](../ci/setup-cloud-deploy-user.sh).

**Ручной (запасной вариант, если CI недоступен, или для первичной настройки
nginx)**:

```bash
# 1. Файлы страницы
ssh cloud "sudo mkdir -p /var/www/stream-viewer"
scp deploy/stream-viewer/index.html deploy/stream-viewer/app.js deploy/stream-viewer/hls.min.js cloud:/tmp/
ssh cloud "sudo mv /tmp/index.html /tmp/app.js /tmp/hls.min.js /var/www/stream-viewer/ \
  && sudo chown -R www-data:www-data /var/www/stream-viewer"

# 2. Nginx: добавить location'ы из nginx-locations.conf в 443-vhost
#    /etc/nginx/sites-enabled/amberapp_domain.conf (бэкап → nginx -t → reload):
ssh cloud "sudo cp /etc/nginx/sites-enabled/amberapp_domain.conf \
  /etc/nginx/sites-enabled/amberapp_domain.conf.bak.\$(date +%s)"
# ... вставить содержимое nginx-locations.conf внутрь server{} с listen 443 ...
ssh cloud "sudo nginx -t && sudo systemctl reload nginx"
```

Шаг 2 (nginx location) — одноразовый, CI его не трогает.

После деплоя в `.env` оператора:

```
STREAM_VIEWER_URL=https://www.xn--80azkg6cn.space/efir/
```

## Проверка

1. `curl -sI https://www.xn--80azkg6cn.space/efir/` → `200`.
2. Без эфира страница показывает «Эфир ещё не начался» и сама
   переподключается каждые 7 секунд.
3. Запустить эфир из дашборда (или тестовый ffmpeg-паттерн, см.
   [stream-integration](../../knowledge/wiki/stream-integration.md)) —
   страница подхватывает видео без перезагрузки, бейдж «В ЭФИРЕ» загорается.
4. Звук: автоплей стартует без звука, зрителю показывается кнопка
   «Включить звук» (ограничение браузеров, не баг).
