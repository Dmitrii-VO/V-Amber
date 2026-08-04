# Чат зрителей /efir/ (deploy)

Мини-сервис чата без зависимостей (`server.js`, node:http) для страницы
зрителя. Живёт на `cloud` рядом с MediaMTX, наружу выходит через nginx
(`location /chat/` → `127.0.0.1:8890`).

Основной вход — **«Войти через VK»** (VK ID, OAuth 2.1 + PKCE): зритель
получает свой настоящий VK user id, поэтому существующий маппинг
контрагентов МойСклад по VK id работает без изменений и повторные
покупатели не задваиваются. Имя и телефон приходят из профиля VK ID
(телефон — со scope `phone`, по согласию зрителя).

Запасной вход — имя+телефон (без VK): такой зритель получает синтетический
id в диапазоне 9e9+ и заводится в МойСкладе новым контрагентом. Телефон в
обоих случаях виден только операторскому фиду (заголовок `X-Chat-Token`),
публичная лента отдаёт лишь имя и текст.

## Настройка VK ID (один раз, делает владелец VK-аккаунта)

1. В кабинете разработчика [id.vk.com](https://id.vk.com/about/business/go)
   создать приложение типа Web.
2. Redirect URL: `https://www.xn--80azkg6cn.space/chat/auth/vk/callback`
   (должен совпадать буква-в-букву с `PUBLIC_BASE_URL` + путь).
3. Включить scope `phone` (доступ к номеру) в настройках доступа приложения.
4. `client_id` приложения → `VK_APP_ID` в `.env` сервиса (см. ниже).
   Секрет приложения НЕ нужен: используется публичный PKCE-флоу.

Без `VK_APP_ID`/`PUBLIC_BASE_URL` кнопка VK на странице скрыта, работает
только вход по телефону.

## Эндпоинты

| Метод/путь | Кто | Что |
|---|---|---|
| `GET /chat/config` | зритель | `{vkAuth}` — показывать ли кнопку VK |
| `GET /chat/auth/vk/start` | зритель | 302 на `id.vk.com/authorize` (PKCE, state в памяти 10 мин) |
| `GET /chat/auth/vk/callback` | VK | обмен кода → профиль → token; страница-мостик кладёт token в localStorage и возвращает на `/efir/`; ошибка → `/efir/#chatAuthError` |
| `POST /chat/join` `{name, phone}` | зритель | запасной вход → `{token, name}`; телефон нормализуется (8… → +7…) |
| `POST /chat/messages` `{token, text}` | зритель | сообщение ≤300 символов, рейт-лимит 1/1.5с |
| `GET /chat/messages?after=N` | зритель | публичная лента (имя+текст, включая сервисные ответы) + `online` — сколько зрителей сейчас на странице |
| `GET /chat/feed?after=N` | V-Amber | сообщения зрителей с `viewerId`/`commentId` (9e9+) и телефоном; без `after` — только `latestSeq` (история не переигрывается) |
| `POST /chat/service` `{text}` | V-Amber | сервисный ответ бота («бронь подтверждена…»), имя «Янтарь» |
| `POST /chat/session/new` | V-Amber | граница сессии чата + снятие карточки лота |
| `POST /chat/lot` `{lot, photo?}` | V-Amber | карточка текущего лота; `{lot:null}` — убрать |
| `POST /chat/lot` `{keepalive:true}` | V-Amber | «карточка всё ещё актуальна» — продлевает `LOT_TTL_MS`, не меняя `rev` |
| `GET /chat/lot` | зритель | текущая карточка (то же приходит в ответе `/chat/messages`) |
| `GET /chat/lot/photo?rev=N` | зритель | фото текущего лота |
| `POST /chat/state` `{vkMirrorUrl}` | V-Amber | ссылка на зеркало эфира в ВК (плашка под плеером); пустая строка убирает |
| `GET /chat/state` | зритель | то же (приходит и в ответе `/chat/messages`) |
| `GET /chat/health` | — | ok + счётчики |

Хранение: `data/viewers.jsonl` + `data/messages.jsonl`, при старте грузятся в
память целиком (объёмы эфира — сотни строк).

## Карточка лота

Оператор называет артикул → V-Amber (`server/viewer-lot.js`) шлёт сюда
карточку, страница `/efir/` показывает её закреплённой над чатом. Это
**состояние**, а не лента: хранится одна текущая карточка.

- Тело `POST /chat/lot`: `{lot: {code, name, category, price, basePrice,
  discount, availableStock, status: "open"|"closed"}, photo?: {base64,
  contentType}}`. Все поля нормализуются по белому списку, страница рисует их
  `textContent`'ом.
- `photo` **не передан** — картинка сохраняется (обновление цены того же
  лота); `photo: null` — снимается; лимит 1.5 МБ (лимит тела — 3 МБ).
  Фото едет байтами, потому что картинка МойСклада доступна только под
  авторизацией — публичной ссылки на неё не существует.
- Хранение: `data/lot.jsonl` (журнал, актуальна последняя строка) +
  `data/lot-photo.bin`; карточка переживает рестарт контейнера.
- `POST /chat/session/new` снимает карточку — карточка прошлого эфира не
  должна висеть над чистым чатом.
- **Карточка живёт, пока её подтверждают.** Хранится она долго, но зрителям
  отдаётся, только если последнее подтверждение от V-Amber не старше
  `LOT_TTL_MS` (по умолчанию 20 минут). V-Amber (`server/viewer-lot.js`) шлёт
  `{keepalive:true}` каждые 5 минут, пока карточка висит, — TTL взят с запасом
  в четыре такта, так что пара сетевых сбоев карточку в эфире не гасит. Если
  V-Amber упал или ноутбук закрыли, не остановив эфир, карточка со старой ценой
  гаснет сама, а не висит до следующего эфира.
- TTL считается по возрасту подтверждения, а не по возрасту карточки: лот
  спокойно висит в эфире часами, пока его подтверждают. Возраст берётся из
  журнала и после рестарта контейнера, поэтому поднявшийся контейнер не
  «воскрешает» карточку прошлого эфира — идущий эфир вернёт её ближайшим
  keepalive'ом.
- `{keepalive:true}` не трогает ни `rev`, ни журнал: `rev` сидит в URL фото, и
  его рост на каждом такте гонял бы зрителям картинку заново каждые 5 минут.
  Поэтому же протухание read-only — ни карточка, ни фото в сервисе не
  стираются, и один keepalive возвращает ту же карточку целиком.

## Счётчик «сейчас смотрят»

`GET /chat/messages` возвращает `online` — сколько зрителей сейчас на странице
`/efir/`. Считается по самому опросу: страница и так дёргает этот эндпоинт раз
в 3 секунды, отдельного heartbeat нет.

- Ключ присутствия — случайный `clientId`, который страница держит в
  `localStorage` и шлёт заголовком `X-Efir-Client`: перезагрузка и вторая
  вкладка того же зрителя считаются одним человеком. Старая закэшированная
  страница заголовка не шлёт — для неё ключ это хэш IP+User-Agent (в память
  кладётся только хэш, не сам IP).
- Живёт запись `ONLINE_TTL_MS` (15 секунд, ~5 тактов опроса): счётчик не мигает
  из-за одного потерянного запроса, а закрытая вкладка пропадает за 15 секунд.
  Ничего не персистится, рестарт контейнера обнуляет счётчик.
- Опросы V-Amber (`X-Chat-Token`) в счётчик не идут — оператор не зритель.
- Это **не** число читателей HLS: MediaMTX считает своих (их видно в панели
  «Стрим» в дашборде), а здесь — открытые страницы, включая тех, кто ещё не
  представился в чате, и тех, кто ушёл смотреть в ВК по плашке-зеркалу, не
  закрыв вкладку.
- `online` есть и в `GET /chat/health` — удобно проверять снаружи.

## Состояние эфира (плашка «смотреть в ВК»)

Эфир идёт одновременно в ВК и здесь, и зритель с плохой связью должен знать
про запасной экран. V-Amber (`server/cross-promo.js`) присылает ссылку на
ВК-зеркало, пока ВК-эфир реально идёт.

- В отличие от карточки лота состояние **не персистится** совсем; TTL есть у
  обоих (`BROADCAST_STATE_TTL_MS`, по умолчанию 12 минут). V-Amber подтверждает его
  каждые ~5 минут; замолчал — плашка гаснет сама, и зритель не уходит по
  ссылке на давно кончившийся эфир.
- Ссылка попадает в `href` на публичной странице, поэтому принимается
  **только** `https` и только домен `vk.com` (включая `m.vk.com`); всё
  остальное — включая `javascript:` и `https://vk.com.чужое/` — отбрасывается
  в пустую строку.

## Деплой на cloud

**Автоматический (обычный путь).** Пуш в `main`, затрагивающий
`deploy/chat-service/**`, запускает
[`.github/workflows/deploy-stream.yml`](../../.github/workflows/deploy-stream.yml):
rsync `server.js`/`docker-compose.yml` в `/srv/chat-service` от урезанного
пользователя `ci-deploy` + `docker compose restart chat` + health-check.
Подробности — [stream-integration § CI-деплой](../../knowledge/wiki/stream-integration.md).

Сервис живёт в `/srv/chat-service` (перенесён туда одноразовым скриптом
[`deploy/ci/setup-cloud-deploy-user.sh`](../ci/setup-cloud-deploy-user.sh) —
раньше был в `~user1/chat-service`; `ci-deploy` не входит в группу `user1` и
не мог бы писать по старому пути).

**Ручной (запасной вариант / первичная настройка `.env` и nginx)**:

```bash
ssh cloud "sudo mkdir -p /srv/chat-service/data"
scp deploy/chat-service/server.js deploy/chat-service/docker-compose.yml cloud:/tmp/
ssh cloud "sudo mv /tmp/server.js /tmp/docker-compose.yml /srv/chat-service/"
# секрет операторского фида (тот же кладётся в .env V-Amber как STREAM_CHAT_TOKEN):
ssh cloud "cd /srv/chat-service && printf 'OPERATOR_TOKEN=<секрет>\nVK_APP_ID=<client_id из id.vk.com>\nPUBLIC_BASE_URL=https://www.xn--80azkg6cn.space\n' | sudo tee .env >/dev/null && sudo chown ci-deploy:ci-deploy .env data && sudo -u ci-deploy docker compose up -d"
ssh cloud "curl -s http://127.0.0.1:8890/chat/health"
```

Затем добавить `location /chat/` из
[../stream-viewer/nginx-locations.conf](../stream-viewer/nginx-locations.conf)
в 443-vhost (бэкап → `nginx -t` → reload) и проверить снаружи:
`curl -s https://www.xn--80azkg6cn.space/chat/health`.

В `.env` оператора (V-Amber):

```
STREAM_CHAT_URL=https://www.xn--80azkg6cn.space/chat
STREAM_CHAT_TOKEN=<тот же секрет>
```

## Связанное

- V-Amber-сторона: `server/chat-client.js`, поллер в `server/ws-server.js`
  (см. [stream-integration](../../knowledge/wiki/stream-integration.md)).
- UI зрителя: [../stream-viewer/index.html](../stream-viewer/index.html).
