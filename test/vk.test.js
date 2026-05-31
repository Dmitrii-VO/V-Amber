import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVideoCommentParams,
  isUsableCommentPhoto,
} from "../server/vk.js";

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
