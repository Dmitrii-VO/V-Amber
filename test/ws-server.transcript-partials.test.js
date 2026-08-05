import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/ws-harness.js";

// Промежуточные распознавания должны попадать в JSONL сессии.
//
// До этого партиалы жили только на экране оператора: onPartial слал их в
// websocket и больше никуда. Из-за этого гипотезы вида «открывать лот по
// партиалу, если артикул появился дважды подряд» невозможно было проверить
// даже задним числом — в бандлах шести эфиров (43 session-jsonl, 19 393
// события) нет ни одной строки про партиалы.

async function startSession(client, harness) {
  client.send({ type: "start", sampleRate: 16000, encoding: "pcm_s16le" });
  return harness.waitForSession();
}

test("партиалы пишутся в лог сессии с нумерацией внутри реплики", async () => {
  const harness = await startHarness({});
  const client = await harness.connect();
  try {
    const session = await startSession(client, harness);

    session.handlers.onPartial({ text: "код", latencyMs: 10 });
    session.handlers.onPartial({ text: "код товара", latencyMs: 20 });
    session.handlers.onPartial({ text: "код товара ноль три", latencyMs: 30 });
    await client.waitFor((m) => m.type === "partial" && m.text === "код товара ноль три");

    const partials = harness.getLastSessionLog().transcripts.filter((t) => t.kind === "partial");
    assert.deepEqual(partials.map((p) => p.text), ["код", "код товара", "код товара ноль три"]);
    assert.deepEqual(partials.map((p) => p.seq), [1, 2, 3], "по seq видно, как уточнялась гипотеза");
    assert.equal(partials[1].latencyMs, 20);
  } finally {
    await client.close();
    await harness.close();
  }
});

test("повтор того же текста в лог не идёт, но клиенту уходит", async () => {
  const harness = await startHarness({});
  const client = await harness.connect();
  try {
    const session = await startSession(client, harness);

    session.handlers.onPartial({ text: "код товара", latencyMs: 10 });
    session.handlers.onPartial({ text: "код товара", latencyMs: 15 });
    session.handlers.onPartial({ text: "код товара ноль", latencyMs: 20 });
    await client.waitFor((m) => m.type === "partial" && m.text === "код товара ноль");

    const partials = harness.getLastSessionLog().transcripts.filter((t) => t.kind === "partial");
    assert.deepEqual(
      partials.map((p) => p.text),
      ["код товара", "код товара ноль"],
      "SpeechKit шлёт партиал и когда текст не изменился — такие строки только раздувают ленту",
    );
  } finally {
    await client.close();
    await harness.close();
  }
});

test("нумерация партиалов начинается заново после финала", async () => {
  const harness = await startHarness({});
  const client = await harness.connect();
  try {
    const session = await startSession(client, harness);

    session.handlers.onPartial({ text: "первая", latencyMs: 10 });
    session.handlers.onFinal({ text: "первая реплика", latencyMs: 12 });
    await client.waitFor((m) => m.type === "final" && m.text === "первая реплика");

    session.handlers.onPartial({ text: "вторая", latencyMs: 10 });
    await client.waitFor((m) => m.type === "partial" && m.text === "вторая");

    const log = harness.getLastSessionLog().transcripts;
    assert.deepEqual(
      log.map((t) => `${t.kind}:${t.text}${t.seq ? "#" + t.seq : ""}`),
      ["partial:первая#1", "final:первая реплика", "partial:вторая#1"],
    );
  } finally {
    await client.close();
    await harness.close();
  }
});

test("тот же текст в новой реплике снова логируется", async () => {
  const harness = await startHarness({});
  const client = await harness.connect();
  try {
    const session = await startSession(client, harness);

    session.handlers.onPartial({ text: "код товара", latencyMs: 10 });
    session.handlers.onFinal({ text: "код товара", latencyMs: 12 });
    await client.waitFor((m) => m.type === "final");
    session.handlers.onPartial({ text: "код товара", latencyMs: 10 });
    await client.waitFor((m) => m.type === "partial" && m.text === "код товара");

    const partials = harness.getLastSessionLog().transcripts.filter((t) => t.kind === "partial");
    assert.equal(partials.length, 2, "дедуп не должен переживать границу реплики");
  } finally {
    await client.close();
    await harness.close();
  }
});
