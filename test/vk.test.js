import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVideoCommentParams,
  isUsableCommentPhoto,
  createVkPublisher,
} from "../server/vk.js";

// Минимальный стаб fetch для video.createComment + загрузки фото. Маршрутизация
// по pathname метода и наличию параметра attachments.
function installVkFetchStub(handlers) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const method = url.pathname.replace("/method/", "");
    calls.push({ method, url, init });

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
      const hasAttachment = url.searchParams.has("attachments");
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

const USABLE_PHOTO = {
  photo: { buffer: Buffer.from("x"), contentType: "image/jpeg", filename: "p.jpg" },
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

test("isUsableCommentPhoto requires buffer, content type, and filename", () => {
  assert.equal(isUsableCommentPhoto({
    buffer: Buffer.from("x"),
    contentType: "image/jpeg",
    filename: "product.jpg",
  }), true);
  assert.equal(isUsableCommentPhoto({ contentType: "image/jpeg", filename: "product.jpg" }), false);
  assert.equal(isUsableCommentPhoto({ buffer: Buffer.from("x"), filename: "product.jpg" }), false);
  assert.equal(isUsableCommentPhoto(null), false);
});

test("publishLotCard republishes text-only when VK rejects the photo (error 100)", async () => {
  const stub = installVkFetchStub({
    createComment: (hasAttachment) => (hasAttachment
      ? { error: { error_code: 100, error_msg: "photo is undefined" } }
      : { response: { comment_id: 555 } }),
  });
  try {
    const vk = createVkPublisher(PUBLISHER_CONFIG);
    const result = await vk.publishLotCard(ACTIVE_LOT, USABLE_PHOTO);
    assert.equal(result.comment_id, 555);

    const commentCalls = stub.calls.filter((c) => c.method === "video.createComment");
    assert.equal(commentCalls.length, 2, "should retry once without the photo");
    assert.equal(commentCalls[0].url.searchParams.has("attachments"), true);
    assert.equal(commentCalls[1].url.searchParams.has("attachments"), false);
    // Текстовый фолбэк показывает плейсхолдер-ссылку, хотя у товара hasPhoto.
    assert.match(commentCalls[1].url.searchParams.get("message"), /placeholder\.jpg/);
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
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const method = url.pathname.replace("/method/", "");
    calls.push({ method, url });
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
    const result = await vk.publishLotCard(ACTIVE_LOT, USABLE_PHOTO);
    assert.equal(result.comment_id, 777);
    const commentCalls = calls.filter((c) => c.method === "video.createComment");
    assert.equal(commentCalls.length, 1);
    assert.equal(commentCalls[0].url.searchParams.has("attachments"), false);
    assert.match(commentCalls[0].url.searchParams.get("message"), /placeholder\.jpg/);
  } finally {
    globalThis.fetch = original;
  }
});
