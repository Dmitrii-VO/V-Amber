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

export class SpeechKitStreamingSession {
  #grpcStream;
  #closed = false;

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
    this.startedAt = Date.now();
    this.lastAudioAt = this.startedAt;

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

    this.lastAudioAt = Date.now();
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
    const latencyMs = Math.max(0, Date.now() - this.lastAudioAt);

    const partialText = response.partial?.alternatives?.[0]?.text?.trim();
    if (partialText) {
      this.handlers.onPartial({ text: partialText, latencyMs });
    }

    const finalText = response.final?.alternatives?.[0]?.text?.trim();
    if (finalText) {
      this.handlers.onFinal({ text: finalText, latencyMs });
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
