# 22, а не 20: `npm test` это `node --test "test/**/*.test.js"`, а glob-паттерны
# тест-раннер понимает только с Node 21+ — на 20 набор тестов не запускался
# вовсе, то есть код никогда не проверялся на той версии, на которой ехал в
# прод. Теперь версия одна везде: здесь, в CI, в release.yml и в
# deploy/chat-service. См. knowledge/wiki/log.md за 2026-07-16.
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY web-ui ./web-ui

RUN mkdir -p logs

EXPOSE 8080

CMD ["npm", "start"]
