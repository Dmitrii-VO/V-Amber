// Проверка VK-токенов перед эфиром: читаем и НЕ публикуем ничего.
// Отвечает на один вопрос — примет ли ВК наши вызовы, или аккаунт под
// флуд-блоком (ошибка 9). Эфир 2026-09-12: 249 из 249 опросов упали с
// «Flood control», комментарии не доходили два часа, а узнали об этом
// только из логов после эфира.
//
//   node scripts/vk-token-check.js
//
// Ошибка 9 у video.getComments = аккаунт user-токена заблокирован ВК по
// флуду. Лечится не кодом: нужен user-токен другого администратора
// сообщества (см. knowledge/wiki/vk-integration.md).
import "dotenv/config";

const version = process.env.VK_API_VERSION?.trim() || "5.199";
const userToken = process.env.VK_USER_TOKEN?.trim() || "";
const groupToken = process.env.VK_GROUP_TOKEN?.trim() || "";
const liveUrl = process.env.VK_LIVE_VIDEO_URL?.trim() || "";
// video-183296442_456245462 — из ссылки на эфир в .env.
const video = liveUrl.match(/video(-?\d+)_(\d+)/);

async function call(method, params, token) {
  if (!token) return "нет токена";
  const url = new URL(`https://api.vk.com/method/${method}`);
  for (const [key, value] of Object.entries({ ...params, access_token: token, v: version })) {
    url.searchParams.set(key, value);
  }
  const body = await (await fetch(url)).json();
  return body.error
    ? `ОШИБКА ${body.error.error_code}: ${body.error.error_msg}`
    : "ок";
}

const checks = [
  ["users.get (кто мы)", "users.get", {}, userToken],
  ["messages.isMessagesFromGroupAllowed (ЛС)", "messages.isMessagesFromGroupAllowed",
    { group_id: process.env.VK_GROUP_ID?.trim() || "", user_id: 1 }, groupToken],
];
if (video) {
  checks.splice(1, 0,
    ["video.get (эфир виден)", "video.get", { owner_id: video[1], videos: `${video[1]}_${video[2]}` }, userToken],
    ["video.getComments (комменты читаются)", "video.getComments", { owner_id: video[1], video_id: video[2], count: 1 }, userToken],
  );
} else {
  console.log("VK_LIVE_VIDEO_URL не разобран — проверки по видео пропущены\n");
}

for (const [label, method, params, token] of checks) {
  console.log(`${label}: ${await call(method, params, token)}`);
}
