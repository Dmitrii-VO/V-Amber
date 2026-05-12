FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY web-ui ./web-ui

RUN mkdir -p logs

EXPOSE 8080

CMD ["npm", "start"]
