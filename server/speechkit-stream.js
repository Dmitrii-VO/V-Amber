import { credentials, Metadata } from "@grpc/grpc-js";
import { logger } from "./logger.js";
import { RecognizerClient } from "@yandex-cloud/nodejs-sdk/ai-stt-v3/stt_service";
import {
  DefaultEouClassifier,
  EouClassifierOptions,
  RawAudio,
  RecognitionModelOptions,
  StreamingOptions,
  TextNormalizationOptions,
} from "@yandex-cloud/nodejs-sdk/ai-stt-v3/stt";

function createCallCredentials(apiKey, folderId, sendFolderHeader) {
  return credentials.createFromMetadataGenerator((_params, callback) => {
    const metadata = new Metadata();
    metadata.set("authorization", `Api-Key ${apiKey}`);
    if (sendFolderHeader && folderId) {
      metadata.set("x-folder-id", folderId);
    }
    callback(null, metadata);
  });
}

function createSessionOptions({ model, lang, sampleRate }) {
  return StreamingOptions.fromPartial({
    recognitionModel: {
      model,
      audioFormat: {
        rawAudio: {
          audioEncoding: RawAudio_AudioEncoding.LINEAR16_PCM,
          sampleRateHertz: sampleRate,
          audioChannelCount: 1,
        },
      },
      textNormalization: {
        textNormalization:
          TextNormalizationOptions_TextNormalization.TEXT_NORMALIZATION_ENABLED,
        profanityFilter: false,
        literatureText: false,
      },
      languageRestriction: {
        restrictionType: LanguageRestrictionOptions_LanguageRestrictionType.WHITELIST,
        languageCode: [lang],
      },
      audioProcessingType: RecognitionModelOptions_AudioProcessingType.REAL_TIME,
    },
    eouClassifier: {
      defaultClassifier: {
        type: DefaultEouClassifier_EouSensitivity.DEFAULT,
        maxPauseBetweenWordsHintMs: 700,
      },
    },
  });
}

const {
  RawAudio_AudioEncoding,
  TextNormalizationOptions_TextNormalization,
  LanguageRestrictionOptions_LanguageRestrictionType,
  RecognitionModelOptions_AudioProcessingType,
  DefaultEouClassifier_EouSensitivity,
} = await import("@yandex-cloud/nodejs-sdk/ai-stt-v3/stt");

// Задержка распознавания = сколько прошло с предыдущего события этой реплики.
// Для финала это ровно «оператор договорил → Yandex прислал текст» (пауза EOU
// + обработка), для партиала — промежуток с прошлого нового текста.
//
// Отсчитываем от партиала с ИЗМЕНИВШИМСЯ текстом: SpeechKit повторяет тот же
// партиал и во время паузы EOU, так что от повтора хвост финала выходил бы
// нулевым.
//
// Раньше здесь было `Date.now() - lastAudioAt` — время с последнего чанка
// аудио. Аудио льётся непрерывно кусками по 100 мс, поэтому в логи шли 3–90 мс
// независимо от того, как быстро отвечал Yandex, и по бандлам логов скорость
// распознавания было не измерить вообще.
export function createLatencyTracker() {
  let lastAt = null;
  let lastText = null;

  const since = (now) => (lastAt === null ? null : Math.max(0, now - lastAt));

  return {
    partial(text, now = Date.now()) {
      const latencyMs = since(now);
      if (text !== lastText) {
        lastText = text;
        lastAt = now;
      }
      return latencyMs;
    },
    final(now = Date.now()) {
      return since(now);
    },
    // Реплика заканчивается по EOU: до него SpeechKit может прислать несколько final.
    endUtterance() {
      lastAt = null;
      lastText = null;
    },
  };
}

export class SpeechKitStreamingSession {
  #grpcStream;
  #closed = false;
  #latency = createLatencyTracker();

  constructor(config, handlers, context = {}) {
    this.config = config;
    this.handlers = handlers;
    this.context = context;

    const channelCredentials = credentials.combineChannelCredentials(
      credentials.createSsl(),
      createCallCredentials(config.apiKey, config.folderId, config.sendFolderHeader),
    );

    this.client = new RecognizerClient(config.endpoint, channelCredentials);
    this.#grpcStream = this.client.recognizeStreaming();

    logger.info("speechkit", "stream_opened", {
      connectionId: this.context.connectionId,
      endpoint: config.endpoint,
      model: config.model,
      lang: config.lang,
      sampleRate: config.sampleRate,
      sendFolderHeader: config.sendFolderHeader,
    });

    this.#grpcStream.on("data", (response) => this.#handleData(response));
    this.#grpcStream.on("error", (error) => {
      if (!this.#closed) {
        this.handlers.onError(error);
        this.close();
      }
    });
    this.#grpcStream.on("end", () => {
      if (!this.#closed) {
        this.handlers.onEnd();
        this.close();
      }
    });

    this.#grpcStream.write({ sessionOptions: createSessionOptions(config) });
  }

  pushAudio(chunkBuffer) {
    if (this.#closed) {
      return;
    }

    this.#grpcStream.write({ chunk: { data: chunkBuffer } });
  }

  close() {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#grpcStream.end();
    this.client.close();
    logger.info("speechkit", "stream_closed", {
      connectionId: this.context.connectionId,
    });
  }

  #handleData(response) {
    const partialText = response.partial?.alternatives?.[0]?.text?.trim();
    if (partialText) {
      this.handlers.onPartial({ text: partialText, latencyMs: this.#latency.partial(partialText) });
    }

    const finalAlt = response.final?.alternatives?.[0];
    const finalText = finalAlt?.text?.trim();
    if (finalText) {
      const latencyMs = this.#latency.final();
      const confidence = typeof finalAlt.confidence === "number" ? finalAlt.confidence : null;
      const minConfidence = this.config.minConfidence || 0;

      // Гейт по уверенности. Режем финал ТОЛЬКО при положительном confidence
      // ниже порога — нулевое/отсутствующее значение трактуем как «нет данных»
      // и пропускаем (Yandex STT v3 пока всегда шлёт 0, см. config.js). Так
      // механизм готов к появлению реальных значений, но сегодня бездействует.
      if (minConfidence > 0 && confidence !== null && confidence > 0 && confidence < minConfidence) {
        logger.info("speechkit", "final_skipped_low_confidence", {
          connectionId: this.context.connectionId,
          confidence,
          minConfidence,
          text: finalText,
        });
      } else {
        this.handlers.onFinal({ text: finalText, latencyMs, confidence });
      }
    }

    if (response.eouUpdate) {
      this.#latency.endUtterance();
    }

    const status = response.statusCode;
    if (status?.message && status.codeType && status.codeType !== 1) {
      this.handlers.onStatus({
        message: status.message,
        codeType: status.codeType,
      });
    }
  }
}
