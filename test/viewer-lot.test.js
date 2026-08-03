import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildViewerLot,
  createViewerLotPublisher,
  MAX_LOT_PHOTO_BYTES,
} from "../server/viewer-lot.js";

// Карточка лота на странице зрителя /efir/: снимок лота + публикатор, который
// дедупит частые emitState() и шлёт фото только при смене артикула.

const silentLog = { info() {}, warn() {}, error() {} };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLot(overrides = {}) {
  const { product = {}, ...rest } = overrides;
  return {
    code: "03204",
    lotSessionId: 1,
    product: {
      name: "Браслет янтарный",
      pathName: "Браслеты",
      salePrice: 2490,
      availableStock: 3,
      ...product,
    },
    ...rest,
  };
}

function makeChatClient() {
  const calls = [];
  return {
    enabled: true,
    calls,
    async publishLot(payload) {
      calls.push(payload);
      return { ok: true };
    },
  };
}

async function flush() {
  // Публикация уходит в фон (void drain()) — даём микрозадачам отработать.
  await delay(5);
}

test("buildViewerLot: цена, категория и остаток из карточки МойСклада", () => {
  const snapshot = buildViewerLot(makeLot());
  assert.deepEqual(snapshot, {
    code: "03204",
    name: "Браслет янтарный",
    category: "Браслеты",
    price: 2490,
    basePrice: 2490,
    discount: 0,
    availableStock: 3,
    status: "open",
  });
});

test("buildViewerLot: скидка даёт price = base - discount и сохраняет базовую цену", () => {
  const snapshot = buildViewerLot(makeLot({ discountAmount: 200 }));
  assert.equal(snapshot.basePrice, 2490);
  assert.equal(snapshot.price, 2290);
  assert.equal(snapshot.discount, 200);
});

test("buildViewerLot: голосовая цена подхватывается при нулевой цене в МойСкладе", () => {
  const snapshot = buildViewerLot(makeLot({ product: { salePrice: 0, voicePrice: 1500 } }));
  assert.equal(snapshot.price, 1500);
});

test("buildViewerLot: неизвестный остаток — null, а не 0", () => {
  const snapshot = buildViewerLot(makeLot({ product: { availableStock: null } }));
  assert.equal(snapshot.availableStock, null);
});

test("buildViewerLot: без лота — null", () => {
  assert.equal(buildViewerLot(null), null);
  assert.equal(buildViewerLot({ code: "" }), null);
});

test("publisher: повторный sync без изменений не шлёт второй запрос", async () => {
  const chatClient = makeChatClient();
  const publisher = createViewerLotPublisher({ chatClient, logger: silentLog });
  const lot = makeLot();

  publisher.sync(lot);
  await flush();
  publisher.sync(lot);
  publisher.sync(lot);
  await flush();

  assert.equal(chatClient.calls.length, 1);
  assert.equal(chatClient.calls[0].lot.code, "03204");
});

test("publisher: изменение цены шлёт обновление без повторной отправки фото", async () => {
  const chatClient = makeChatClient();
  const publisher = createViewerLotPublisher({ chatClient, logger: silentLog });
  const lot = makeLot({ product: { photo: { buffer: Buffer.from("jpeg-bytes"), contentType: "image/jpeg" } } });

  publisher.sync(lot);
  await flush();
  lot.discountAmount = 200;
  publisher.sync(lot);
  await flush();

  assert.equal(chatClient.calls.length, 2);
  assert.equal(chatClient.calls[0].photo.contentType, "image/jpeg");
  assert.equal(chatClient.calls[0].photo.base64, Buffer.from("jpeg-bytes").toString("base64"));
  // Тот же артикул — фото не переотправляем (сотни килобайт на каждый тик).
  assert.equal("photo" in chatClient.calls[1], false);
  assert.equal(chatClient.calls[1].lot.price, 2290);
});

test("publisher: смена лота на лот без фото явно снимает картинку", async () => {
  const chatClient = makeChatClient();
  const publisher = createViewerLotPublisher({ chatClient, logger: silentLog });

  publisher.sync(makeLot({ product: { photo: { buffer: Buffer.from("x"), contentType: "image/png" } } }));
  await flush();
  publisher.sync(makeLot({ code: "03300", lotSessionId: 2 }));
  await flush();

  assert.equal(chatClient.calls.length, 2);
  assert.equal(chatClient.calls[1].photo, null);
});

test("publisher: слишком большое фото не отправляется, карточка уходит без него", async () => {
  const chatClient = makeChatClient();
  const publisher = createViewerLotPublisher({ chatClient, logger: silentLog });

  publisher.sync(makeLot({
    product: { photo: { buffer: Buffer.alloc(MAX_LOT_PHOTO_BYTES + 1), contentType: "image/jpeg" } },
  }));
  await flush();

  assert.equal(chatClient.calls[0].photo, null);
  assert.equal(chatClient.calls[0].lot.code, "03204");
});

test("publisher: закрытие лота оставляет карточку со статусом closed", async () => {
  const chatClient = makeChatClient();
  const publisher = createViewerLotPublisher({ chatClient, logger: silentLog });

  publisher.sync(makeLot());
  await flush();
  publisher.sync(null);
  await flush();

  assert.equal(chatClient.calls.length, 2);
  assert.equal(chatClient.calls[1].lot.status, "closed");
  assert.equal(chatClient.calls[1].lot.code, "03204");
  // Тот же артикул — фото не переотправляется.
  assert.equal("photo" in chatClient.calls[1], false);
});

test("publisher: clear снимает карточку", async () => {
  const chatClient = makeChatClient();
  const publisher = createViewerLotPublisher({ chatClient, logger: silentLog });

  publisher.sync(makeLot());
  await flush();
  publisher.clear();
  await flush();

  assert.equal(chatClient.calls.at(-1).lot, null);
});

test("publisher: ошибка чата не бросает и не блокирует следующую публикацию", async () => {
  const calls = [];
  let fail = true;
  const chatClient = {
    enabled: true,
    async publishLot(payload) {
      calls.push(payload);
      if (fail) return { ok: false, error: "chat lot status 502" };
      return { ok: true };
    },
  };
  const publisher = createViewerLotPublisher({ chatClient, logger: silentLog });
  const lot = makeLot();

  publisher.sync(lot);
  await flush();
  assert.equal(calls.length, 1);

  // Тот же лот после сбоя должен уехать повторно, а не считаться отправленным.
  fail = false;
  publisher.sync(lot);
  await flush();
  assert.equal(calls.length, 2);
});

test("publisher: без настроенного чата ничего не делает", async () => {
  const publisher = createViewerLotPublisher({ chatClient: { enabled: false }, logger: silentLog });
  assert.equal(publisher.enabled, false);
  publisher.sync(makeLot());
  publisher.clear();
  await flush();
});
