import { logger } from "../logger.js";
import { transcriptHasTrigger } from "../article-extractor.js";

export function createVoicePipeline({
  connectionId,
  detectionConfig,
}) {
  let triggerActiveUntil = 0;
  let triggerSessionFinals = [];

  return {
    resetTriggerWindow(reason) {
      triggerActiveUntil = 0;
      triggerSessionFinals = [];
      if (process.env.DEBUG_TRIGGER_WINDOW === "1") {
        logger.debug("article", "trigger_window_reset", { connectionId, reason });
      }
    },

    rememberFinal(text) {
      if (transcriptHasTrigger(text, detectionConfig.triggers)) {
        triggerActiveUntil = Date.now() + detectionConfig.triggerWindowMs;
        triggerSessionFinals = [{ text, ts: Date.now() }];
        return;
      }

      if (Date.now() <= triggerActiveUntil) {
        triggerSessionFinals.push({ text, ts: Date.now() });
        triggerSessionFinals = triggerSessionFinals.slice(-Math.max(1, detectionConfig.finalBufferSize));
      }
    },

    buildDetectionInputs(text) {
      const inputs = [text];
      if (Date.now() > triggerActiveUntil || triggerSessionFinals.length === 0) {
        return inputs;
      }
      for (let size = 1; size <= triggerSessionFinals.length; size += 1) {
        inputs.unshift(triggerSessionFinals.slice(-size).map((entry) => entry.text).join(" "));
      }
      return [...new Set(inputs.filter(Boolean))];
    },

    isTriggerActive: () => Date.now() <= triggerActiveUntil,
  };
}
