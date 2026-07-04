# Чат зрителей /efir/ (deploy)

Мини-сервис чата без зависимостей (`server.js`, node:http) для страницы
зрителя. Живёт на `cloud` рядом с MediaMTX, наружу выходит через nginx
(`location /chat/` → `127.0.0.1:8890`).

Зачем телефон при входе: бронь без контакта бесполезна — оператору не с кем
связаться по оплате/доставке. Телефон виден только операторскому фиду
(заголовок `X-Chat-Token`), публичная лента отдаёт лишь имя и текст.

## Эндпоинты

| Метод/путь | Кто | Что |
|---|---|---|
| `POST /chat/join` `{name, phone}` | зритель | вход → `{token, name}`; телефон нормализуется (8… → +7…) |
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
ssh cloud "cd ~/chat-service && echo OPERATOR_TOKEN=<секрет> > .env && docker compose up -d"
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
