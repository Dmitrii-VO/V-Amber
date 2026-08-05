import test from "node:test";
import assert from "node:assert/strict";

import { createReservationAttention } from "../server/domain/reservation-attention.js";
import { createCommentFloodGuard } from "../server/comment-flood-guard.js";

// Комментарий похож на бронь, но однозначного открытого лота нет. Бронировать
// наугад в денежном пути нельзя, поэтому случай уходит оператору на дашборд.
// До выноса эта ветка проверялась только сквозь весь ws-server.

const CATALOG = new Set(["00246", "03204"]);

function setup({ catalog = CATALOG, openLots = [], names = {}, floodGuard } = {}) {
  const sent = [];
  const registered = [];
  const attention = createReservationAttention({
    connectionId: "ws-test",
    productCodeCache: { getCodes: () => catalog },
    nameCacheStore: { getName: (id) => names[id] || "" },
    getOpenLots: () => openLots.map((code) => ({ code })),
    registerPendingReservation: (payload) => {
      registered.push(payload);
      return `action-${registered.length}`;
    },
    notify: (payload) => sent.push(payload),
    ...(floodGuard ? { floodGuard } : {}),
  });
  return { attention, sent, registered };
}

function comment(text, overrides = {}) {
  return {
    id: 501,
    viewerId: 77,
    viewerName: "Ирина Петрова",
    text,
    createdAt: "2026-08-05T10:00:00.000Z",
    source: "vk",
    ...overrides,
  };
}

const attentionOf = (sent) => sent.find((m) => m.type === "reservationAttention");

test("комментарий без ключевого слова и кода оператору не уходит", () => {
  const { attention, sent } = setup();

  const handled = attention.handleNoOpenLot({
    comment: comment("красивые серьги! сколько стоят?"),
    target: null,
    logSource: "vk",
  });

  assert.equal(handled, false);
  assert.deepEqual(sent, []);
});

test("бронь по закрытому лоту уходит оператору и предлагает забронировать", () => {
  const { attention, sent, registered } = setup({ openLots: ["03204"] });

  attention.handleNoOpenLot({
    comment: comment("бронь 00246"),
    target: null,
    logSource: "vk",
  });

  const card = attentionOf(sent);
  assert.equal(card.reason, "no_open_lot");
  assert.equal(card.code, "00246");
  assert.deepEqual(card.openLotCodes, ["03204"]);
  assert.equal(card.actionId, "action-1", "код есть в каталоге — бронь можно предложить одной кнопкой");
  assert.equal(registered[0].viewerId, 77);
  assert.equal(registered[0].code, "00246");
});

test("код без ведущих нулей приводится к каталожному, сырой сохраняется", () => {
  const { attention, sent } = setup();

  attention.handleNoOpenLot({
    comment: comment("бронь 246"),
    target: null,
    logSource: "vk",
  });

  const card = attentionOf(sent);
  assert.equal(card.code, "00246", "оператору показываем код каталога");
  assert.equal(card.originalCode, "246", "но и то, что написал покупатель");
});

test("ambiguous не предлагает бронь: выбирать лот за оператора нельзя", () => {
  const { attention, sent, registered } = setup({ openLots: ["00588", "000588"] });

  attention.handleNoOpenLot({
    comment: comment("бронь 588"),
    target: { reason: "ambiguous", candidateCodes: ["00588", "000588"] },
    logSource: "vk",
  });

  const card = attentionOf(sent);
  assert.equal(card.reason, "ambiguous");
  assert.equal(card.actionId, undefined, "разные товары — кнопку брони давать нельзя");
  assert.deepEqual(card.candidateCodes, ["00588", "000588"]);
  assert.deepEqual(registered, []);
});

test("без каталога код уходит как есть, кнопки брони нет", () => {
  const { attention, sent, registered } = setup({ catalog: new Set() });

  attention.handleNoOpenLot({
    comment: comment("бронь 00246"),
    target: null,
    logSource: "vk",
  });

  assert.equal(attentionOf(sent).code, "00246");
  assert.deepEqual(registered, [], "без каталога код не подтверждён — предлагать бронь нельзя");
});

test("имя берётся из кеша, когда в комментарии его нет", () => {
  const { attention, sent } = setup({ names: { 77: "Ирина Петрова" } });

  attention.handleNoOpenLot({
    comment: comment("бронь 00246", { viewerName: "" }),
    target: null,
    logSource: "chat",
  });

  assert.equal(attentionOf(sent).viewerName, "Ирина Петрова");
});

test("флуд розыгрыша подавляется, оператор предупреждён один раз", () => {
  // Порог гарда — 8 событий в окне; девятое и дальше подавляются.
  const { attention, sent } = setup({
    floodGuard: createCommentFloodGuard({ windowMs: 60_000, threshold: 8 }),
  });

  for (let i = 0; i < 20; i += 1) {
    attention.handleNoOpenLot({
      comment: comment(`бронь ${300 + i}`, { id: 600 + i, viewerId: 1000 + i }),
      target: null,
      logSource: "vk",
    });
  }

  const cards = sent.filter((m) => m.type === "reservationAttention");
  const warnings = sent.filter((m) => m.type === "warning");
  assert.equal(cards.length, 8, "сверх порога карточки не плодим");
  assert.equal(warnings.length, 1, "предупреждать оператора один раз за всплеск");
  assert.match(warnings[0].message, /розыгрыш/);
});

test("ambiguous проходит мимо ограничителя даже во время флуда", () => {
  const { attention, sent } = setup({
    floodGuard: createCommentFloodGuard({ windowMs: 60_000, threshold: 2 }),
  });

  for (let i = 0; i < 6; i += 1) {
    attention.handleNoOpenLot({
      comment: comment(`бронь ${300 + i}`, { id: 700 + i }),
      target: null,
      logSource: "vk",
    });
  }
  // Живой покупатель у ОТКРЫТОГО товара — его нельзя терять в шуме розыгрыша
  // (инцидент 2026-05-24: «перестала бронировать, Ирина повторите»).
  const handled = attention.handleNoOpenLot({
    comment: comment("бронь 00246", { id: 999 }),
    target: { reason: "ambiguous", candidateCodes: ["00246", "000246"] },
    logSource: "vk",
  });

  assert.equal(handled, true);
  assert.equal(sent.filter((m) => m.type === "reservationAttention").at(-1).commentId, 999);
});
