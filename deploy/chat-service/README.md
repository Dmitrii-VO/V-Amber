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
| `GET /chat/messages?after=N` | зритель | публичная лента (имя+текст, включая сервисные ответы) |
| `GET /chat/feed?after=N` | V-Amber | сообщения зрителей с `viewerId`/`commentId` (9e9+) и телефоном; без `after` — только `latestSeq` (история не переигрывается) |
| `POST /chat/service` `{text}` | V-Amber | сервисный ответ бота («бронь подтверждена…»), имя «Янтарь» |
| `GET /chat/health` | — | ok + счётчики |

Хранение: `data/viewers.jsonl` + `data/messages.jsonl`, при старте грузятся в
память целиком (объёмы эфира — сотни строк).

## Деплой на cloud

```bash
ssh cloud "mkdir -p ~/chat-service/data"
scp deploy/chat-service/server.js deploy/chat-service/docker-compose.yml cloud:~/chat-service/
# секрет операторского фида (тот же кладётся в .env V-Amber как STREAM_CHAT_TOKEN):
ssh cloud "cd ~/chat-service && printf 'OPERATOR_TOKEN=<секрет>\nVK_APP_ID=<client_id из id.vk.com>\nPUBLIC_BASE_URL=https://www.xn--80azkg6cn.space\n' > .env && docker compose up -d"
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
