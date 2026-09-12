// Проверка VK перед эфиром: пройдёт ли зал к нам и мы к залу. Только чтение,
// ничего не публикует и не меняет настроек.
//
//   node scripts/vk-token-check.js
//
// Эфир целиком живёт на ТОКЕНЕ СООБЩЕСТВА: комментарии приходят событием
// video_comment_new (Long Poll), карточки и подтверждения уходят через
// wall.createComment от имени сообщества, бан — groups.ban. Пользовательский
// токен убран 13.09.2026: 12.09 ВК заблокировал аккаунт по флуду (ошибка 9),
// и два часа эфира прошли вслепую. Красный пункт здесь = глухой эфир.
//
// Подробности: knowledge/wiki/vk-integration.md
import "dotenv/config";

const version = process.env.VK_API_VERSION?.trim() || "5.199";
const groupToken = process.env.VK_GROUP_TOKEN?.trim() || "";
const groupId = (process.env.VK_GROUP_ID?.trim() || "").replace(/^-/, "");

async function call(method, params, token) {
  if (!token) return { error: "нет токена" };
  const url = new URL(`https://api.vk.com/method/${method}`);
  for (const [key, value] of Object.entries({ ...params, access_token: token, v: version })) {
    url.searchParams.set(key, value);
  }
  const body = await (await fetch(url)).json();
  return body.error
    ? { error: `ОШИБКА ${body.error.error_code}: ${body.error.error_msg}` }
    : { ok: body.response };
}

const results = [];
function report(label, verdict, detail = "") {
  results.push({ label, verdict });
  const mark = verdict === "ok" ? "  ок  " : verdict === "warn" ? " ждёт " : "ПЛОХО ";
  console.log(`${mark} ${label}${detail ? " — " + detail : ""}`);
}

console.log("\nГрупповой токен — на нём держится эфир\n");

const group = await call("groups.getById", { group_id: groupId }, groupToken);
if (group.error) {
  report("сообщество отвечает", "fail", group.error);
} else {
  const found = group.ok?.groups?.[0] || group.ok?.[0];
  report("сообщество отвечает", "ok", `${found?.name || "?"} (id ${found?.id || "?"})`);
}

const settings = await call("groups.getLongPollSettings", { group_id: groupId }, groupToken);
if (settings.error) {
  report("Long Poll настроен", "fail", settings.error);
} else {
  const enabled = Boolean(settings.ok?.is_enabled);
  const event = Number(settings.ok?.events?.video_comment_new) === 1;
  report("Long Poll включён", enabled ? "ok" : "fail", enabled ? "" : "включить в «Работа с API → Long Poll API»");
  report(
    "событие «Комментарий к видео: добавлен»",
    event ? "ok" : "fail",
    event ? "" : "без него комментарии зрителей до сервера не дойдут",
  );
}

const server = await call("groups.getLongPollServer", { group_id: groupId }, groupToken);
report("очередь событий выдаётся", server.error ? "fail" : "ok", server.error || "");

// Имена авторов комментариев тянутся этим же токеном — в событии их нет.
const names = await call("users.get", { user_ids: 1 }, groupToken);
report("имена зрителей читаются", names.error ? "fail" : "ok", names.error || "");

const dm = await call(
  "messages.isMessagesFromGroupAllowed",
  { group_id: groupId, user_id: 1 },
  groupToken,
);
report("личные сообщения сообщества", dm.error ? "fail" : "ok", dm.error || "");

// Публикацию (wall.createComment) вживую не проверяем: это публичный
// комментарий под эфиром. Проверяем то, от чего она зависит, — известен ли
// post_id записи. Пустой — не беда: сервер узнает его из первого же
// комментария зрителя (событие wall_reply_new).
const postId = process.env.VK_LIVE_POST_ID?.trim() || "";
report(
  "запись эфира для публикации",
  postId ? "ok" : "warn",
  postId ? `VK_LIVE_POST_ID=${postId}` : "не задана — узнается сама из первого комментария зрителя",
);

const broken = results.filter((r) => r.verdict === "fail");
console.log(
  broken.length === 0
    ? "\nИтог: эфир примет брони и ответит залу.\n"
    : `\nИтог: сломано пунктов — ${broken.length}, эфир будет глухим. Чинить: ${broken.map((r) => r.label).join(", ")}.\n`,
);
