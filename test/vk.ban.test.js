import { test } from "node:test";
import assert from "node:assert/strict";
import { createVkPublisher } from "../server/vk.js";

// Реальная модерация ВК: groups.ban (бан из сообщества эфира) и
// video.deleteComment (удаление коммента), обе под user-токеном. Эфир — видео
// сообщества (owner_id отрицательный), поэтому group_id = -liveOwnerId.
// См. server/vk.js banViewer/deleteVideoComment.

function installStub() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? new URL(input) : input;
    const method = url.pathname.replace("/method/", "");
    calls.push({ method, url });
    return { ok: true, status: 200, async json() { return { response: 1 }; } };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const BASE = { userToken: "user-tok", groupToken: "grp-tok", liveOwnerId: "-221975350", liveVideoId: "456", apiMinIntervalMs: 1 };

test("banViewer банит в сообществе эфира: group_id = -liveOwnerId, owner_id = зритель, user-токен", async () => {
  const stub = installStub();
  try {
    const pub = createVkPublisher(BASE);
    const res = await pub.banViewer({ userId: 5001, comment: "спам" });
    assert.equal(res.ok, true);
    assert.equal(res.groupId, "221975350");
    const ban = stub.calls.find((c) => c.method === "groups.ban");
    assert.ok(ban, "groups.ban должен быть вызван");
    assert.equal(ban.url.searchParams.get("group_id"), "221975350");
    assert.equal(ban.url.searchParams.get("owner_id"), "5001");
    assert.equal(ban.url.searchParams.get("access_token"), "user-tok");
  } finally { stub.restore(); }
});

test("banViewer отклоняет эфир на пользовательском профиле (owner_id > 0)", async () => {
  const stub = installStub();
  try {
    const pub = createVkPublisher({ ...BASE, liveOwnerId: "12345" });
    const res = await pub.banViewer({ userId: 5001 });
    assert.equal(res.ok, false);
    assert.equal(res.code, "not_community");
    assert.equal(stub.calls.filter((c) => c.method === "groups.ban").length, 0);
  } finally { stub.restore(); }
});

test("banViewer отклоняет пустой/некорректный id зрителя", async () => {
  const stub = installStub();
  try {
    const pub = createVkPublisher(BASE);
    const res = await pub.banViewer({ userId: 0 });
    assert.equal(res.ok, false);
    assert.equal(res.code, "bad_user_id");
    assert.equal(stub.calls.filter((c) => c.method === "groups.ban").length, 0);
  } finally { stub.restore(); }
});

test("deleteVideoComment удаляет на owner_id эфирного видео", async () => {
  const stub = installStub();
  try {
    const pub = createVkPublisher(BASE);
    const res = await pub.deleteVideoComment({ commentId: 777 });
    assert.equal(res.ok, true);
    const del = stub.calls.find((c) => c.method === "video.deleteComment");
    assert.ok(del, "video.deleteComment должен быть вызван");
    assert.equal(del.url.searchParams.get("owner_id"), "-221975350");
    assert.equal(del.url.searchParams.get("comment_id"), "777");
    assert.equal(del.url.searchParams.get("access_token"), "user-tok");
  } finally { stub.restore(); }
});

test("модерация недоступна без user-токена", async () => {
  const stub = installStub();
  try {
    const pub = createVkPublisher({ ...BASE, userToken: "" });
    const ban = await pub.banViewer({ userId: 5001 });
    const del = await pub.deleteVideoComment({ commentId: 777 });
    assert.equal(ban.code, "no_user_token");
    assert.equal(del.code, "no_user_token");
  } finally { stub.restore(); }
});
