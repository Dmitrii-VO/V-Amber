import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVideoCommentParams,
  createVkPublisher,
} from "../server/vk.js";

// Минимальный стаб fetch для video.createComment + загрузки фото. Маршрутизация
// по pathname метода и наличию параметра attachments. Параметры VK-вызовов
// (включая access_token) живут в теле POST — стаб отдаёт их как `params`.
function installVkFetchStub(handlers) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const method = url.pathname.replace("/method/", "");
    const params = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    calls.push({ method, url, params, init });

    const makeOk = (payload) => ({
      ok: true,
      status: 200,
      async json() { return payload; },
    });

    if (method === "photos.getWallUploadServer") {
      return makeOk({ response: { upload_url: "https://upload.vk/photo" } });
    }
    if (url.href.startsWith("https://upload.vk/photo")) {
      return makeOk({ photo: "[]", server: 1, hash: "h" });
    }
    if (method === "photos.saveWallPhoto") {
      return makeOk({ response: [{ owner_id: -10, id: 99 }] });
    }
    if (method === "video.createComment") {
      const hasAttachment = params.has("attachments");
      return makeOk(handlers.createComment(hasAttachment));
    }
    return makeOk({ response: {} });
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

const PUBLISHER_CONFIG = {
  userToken: "t",
  liveOwnerId: "-10",
  liveVideoId: "20",
  placeholderImageUrl: "https://img/placeholder.jpg",
  apiMinIntervalMs: 1,
};

const ACTIVE_LOT = {
  code: "00136",
  lotSessionId: "ls-1",
  product: { name: "Брошь", hasPhoto: true, availableStock: 3 },
};


test("buildVideoCommentParams omits undefined attachments", () => {
  assert.deepEqual(
    buildVideoCommentParams({
      ownerId: -1,
      videoId: 2,
      message: "Лот открыт",
      attachments: undefined,
    }),
    {
      owner_id: -1,
      video_id: 2,
      message: "Лот открыт",
    },
  );
});

test("buildVideoCommentParams includes attachments and reply only when present", () => {
  assert.deepEqual(
    buildVideoCommentParams({
      ownerId: -1,
      videoId: 2,
      message: "Ответ",
      attachments: "photo-1_2",
      replyToComment: 10,
    }),
    {
      owner_id: -1,
      video_id: 2,
      message: "Ответ",
      attachments: "photo-1_2",
      reply_to_comment: 10,
    },
  );
});

test("карточка лота уходит текстом, без вложения", async () => {
  const stub = installVkFetchStub({
    createComment: () => ({ response: { comment_id: 555 } }),
  });
  try {
    const vk = createVkPublisher(PUBLISHER_CONFIG);
    // Второй аргумент — карточка товара с фото. Оно намеренно игнорируется:
    // загрузка в ВК регулярно отваливалась «photo is undefined» (8 карточек
    // без картинки и одна непубликованная за эфир 2026-08-29), а товар зритель
    // и так видит в эфире.
    const result = await vk.publishLotCard(ACTIVE_LOT);
    assert.equal(result.comment_id, 555);

    const commentCalls = stub.calls.filter((c) => c.method === "video.createComment");
    assert.equal(commentCalls.length, 1, "никаких повторных публикаций без фото");
    assert.equal(commentCalls[0].params.has("attachments"), false);
    // Заглушка печатается всегда, когда задана в конфиге.
    assert.match(commentCalls[0].params.get("message"), /placeholder\.jpg/);
  } finally {
    stub.restore();
  }
});

test("rate-limit penalty decays gradually instead of resetting on first success", async () => {
  const INTERVAL_MS = 40;
  const fetchTimes = [];
  let callIndex = 0;
  const original = globalThis.fetch;
  // Первые два вызова — VK 6 (штраф ×2, затем ×4), дальше успех.
  globalThis.fetch = async () => {
    fetchTimes.push(Date.now());
    callIndex += 1;
    const payload = callIndex <= 2
      ? { error: { error_code: 6, error_msg: "Too many requests per second" } }
      : { response: { items: [], profiles: [], groups: [], can_post: 1 } };
    return { ok: true, status: 200, async json() { return payload; } };
  };
  try {
    const vk = createVkPublisher({ ...PUBLISHER_CONFIG, apiMinIntervalMs: INTERVAL_MS });
    await assert.rejects(() => vk.getComments(), /VK API 6/); // штраф ×2
    await assert.rejects(() => vk.getComments(), /VK API 6/); // штраф ×4
    await vk.getComments(); // успех: ×4 → ×2 (раньше сбрасывался в ×1)
    await vk.getComments(); // должен подождать ≥ 2×INTERVAL_MS

    const gapAfterSuccess = fetchTimes[3] - fetchTimes[2];
    // setTimeout не срабатывает раньше срока, поэтому нижняя граница надёжна;
    // небольшой люфт вниз — на округление таймеров.
    assert.ok(
      gapAfterSuccess >= INTERVAL_MS * 2 - 5,
      `expected decayed gap >= ${INTERVAL_MS * 2 - 5}ms, got ${gapAfterSuccess}ms`,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("publishLotCard still publishes when photo upload fails", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const method = url.pathname.replace("/method/", "");
    const params = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    calls.push({ method, url, params });
    if (method === "photos.getWallUploadServer") {
      return { ok: true, status: 200, async json() { return { error: { error_code: 500, error_msg: "boom" } }; } };
    }
    if (method === "video.createComment") {
      return { ok: true, status: 200, async json() { return { response: { comment_id: 777 } }; } };
    }
    return { ok: true, status: 200, async json() { return { response: {} }; } };
  };
  try {
    const vk = createVkPublisher(PUBLISHER_CONFIG);
    const result = await vk.publishLotCard(ACTIVE_LOT);
    assert.equal(result.comment_id, 777);
    const commentCalls = calls.filter((c) => c.method === "video.createComment");
    assert.equal(commentCalls.length, 1);
    assert.equal(commentCalls[0].params.has("attachments"), false);
    assert.match(commentCalls[0].params.get("message"), /placeholder\.jpg/);
  } finally {
    globalThis.fetch = original;
  }
});

// ——— Публикация под запись эфира (13.09.2026) ———
//
// ВК не даёт сообществу video.createComment (ошибка 27), но даёт
// wall.createComment — а комментарии под видео лежат и как комментарии к
// записи, на которой висит эфир. Проверено на боевом эфире: комментарий ушёл
// групповым токеном и появился под видео с подписью «Амберри · Автор».
// Это снимает зависимость эфира от пользовательского токена, который ВК
// 12.09 заблокировал по флуду.

function installMethodSpy() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const params = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    calls.push({ method: url.pathname.replace("/method/", ""), params });
    return { ok: true, status: 200, async json() { return { response: { comment_id: 1 } }; } };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

function publisherWith(extra = {}) {
  return createVkPublisher({
    userToken: "user-token",
    groupToken: "group-token",
    groupId: "183296442",
    liveVideoUrl: "https://vk.ru/video-183296442_456245462",
    ...extra,
  });
}

test("зная запись эфира, карточка лота уходит на стену от имени сообщества", async () => {
  const spy = installMethodSpy();
  try {
    const vk = publisherWith({ livePostId: "301049" });
    await vk.publishLotCard({ code: "03900", lotSessionId: "lot-1", salePrice: 4250 });

    const call = spy.calls.at(-1);
    assert.equal(call.method, "wall.createComment");
    assert.equal(call.params.get("post_id"), "301049");
    assert.equal(call.params.get("owner_id"), "-183296442");
    assert.equal(call.params.get("from_group"), "1");
    assert.equal(call.params.get("access_token"), "group-token", "именно групповой токен — user под флуд-блоком");
  } finally {
    spy.restore();
  }
});

test("запись эфира неизвестна — работает старый путь через видео", async () => {
  const spy = installMethodSpy();
  try {
    const vk = publisherWith();
    await vk.publishLotCard({ code: "03900", lotSessionId: "lot-1", salePrice: 4250 });

    const call = spy.calls.at(-1);
    assert.equal(call.method, "video.createComment");
    assert.equal(call.params.get("access_token"), "user-token");
  } finally {
    spy.restore();
  }
});

test("подтверждение брони на стене адресовано по имени, а не ответом в ветке", async () => {
  const spy = installMethodSpy();
  try {
    const vk = publisherWith({ livePostId: "301049" });
    await vk.publishReservationReply({
      commentId: 100001931,
      message: "бронь принята (код 03900)",
      viewerName: "Аня",
      lotSessionId: "lot-1",
      code: "03900",
      viewerId: 5001,
      status: "ok",
    });

    const call = spy.calls.at(-1);
    assert.equal(call.method, "wall.createComment");
    assert.equal(call.params.get("message"), "Аня, бронь принята (код 03900)");
    assert.equal(call.params.get("reply_to_comment"), null, "id комментария к видео в ветке записи не существует");
  } finally {
    spy.restore();
  }
});

test("post_id узнаётся сам из события wall_reply_new", async () => {
  const spy = installMethodSpy();
  try {
    const vk = publisherWith();
    assert.equal(vk.getLivePostId(), 0);

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          ts: "2",
          updates: [
            { type: "wall_reply_new", object: { id: 302806, from_id: 5001, text: "бронь", post_id: 301049, post_owner_id: -183296442 } },
            { type: "video_comment_new", object: { id: 100001931, from_id: 5001, text: "бронь", date: 1, video_id: 456245462, video_owner_id: -183296442 } },
          ],
        };
      },
    });

    const update = await vk.fetchCommentLongPollUpdates({ server: "https://lp.vk.com/whp/1", key: "k", ts: "1" });

    assert.equal(vk.getLivePostId(), 301049, "узнали запись эфира из зеркального события");
    assert.deepEqual(update.comments.map((c) => c.id), [100001931], "сам комментарий берём один раз, из video_comment_new");
  } finally {
    spy.restore();
  }
});

test("новый эфир забывает запись прошлого", async () => {
  const vk = publisherWith({ livePostId: "301049" });
  assert.equal(vk.getLivePostId(), 301049);

  vk.setLiveVideoUrl("https://vk.ru/video-183296442_456299999");

  assert.equal(vk.getLivePostId(), 0, "иначе карточки сегодняшних лотов уйдут под вчерашнее видео");
});
